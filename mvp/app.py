import csv
import hashlib
import io
import json
import os
import re
import sqlite3
import uuid
import zipfile
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from openpyxl import Workbook, load_workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from pydantic import BaseModel

ROOT = Path(__file__).parent
DB = Path(os.environ.get('EVAL_DB', ROOT / 'local' / 'study.sqlite3'))
RAW = 'Full Raw AI Response (paste unchanged)'
MODEL = 'AI Platform'
RATINGS = ['Yes', 'Partially', 'No', 'N/A', 'Pending']
CODES = {f'C-{i:02}' for i in range(1, 21)}
ANCHORS = ['Pass Condition (Yes)', 'Partial Condition', 'Fail Condition (No)']
app = FastAPI(title='AI Safety Evaluation Assistant')


def now():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def db():
    DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB, timeout=10)
    try:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.executescript((ROOT / 'schema.sql').read_text())
        with conn:
            yield conn
    finally:
        conn.close()


def get_active(conn):
    row = conn.execute('SELECT payload FROM imports ORDER BY rowid DESC LIMIT 1').fetchone()
    return json.loads(row[0]) if row else {}


def rows(sheet):
    return [list(r) for r in sheet.values if any(v is not None for v in r)]


def records(sheet, start, field):
    data = rows(sheet)
    i = next(i for i, row in enumerate(data) if field in row[:1] and i >= start)
    return [dict(zip(data[i], row)) for row in data[i+1:] if row[0] is not None]


def read_workbook(blob):
    with zipfile.ZipFile(io.BytesIO(blob)) as package:
        if sum(i.file_size for i in package.infolist()) > 50_000_000:
            raise ValueError('Workbook expands beyond 50 MB.')
    return load_workbook(io.BytesIO(blob), read_only=True, data_only=True, keep_links=False)


def parse(rubric_blob, study_blob):
    with_workbooks = [read_workbook(blob) for blob in (rubric_blob, study_blob)]
    rubric, study = with_workbooks
    try:
        criteria = records(rubric['Criteria (EN)'], 0, 'ID')
        chinese = records(rubric['判据（中文对照）'], 0, 'ID')
        prompts = records(study['01 Pilot Prompts'], 0, 'Prompt ID')
        responses = records(study['02 Testing Log'], 0, 'Response ID')
        reference = defaultdict(list)
        for row in records(study['10 Review Rubric'], 0, 'ID'):
            if row['ID'] in CODES:
                reference[row['ID']].append(row)
        checks = records(study['06 Verification Log'], 0, 'Check ID')
        old = records(study['04 Pilot Evaluation'], 0, 'Evaluation ID')
        second = records(study['08 Review Evidence'], 0, 'Response ID')
        supporting = {
            'rubric': {s.title: rows(s) for s in rubric if s.title not in ('Criteria (EN)', '判据（中文对照）')},
            'study': {s.title: rows(s) for s in study if s.title not in ('01 Pilot Prompts', '02 Testing Log')},
        }
    finally:
        for workbook in with_workbooks:
            workbook.close()
    if len(criteria) != 20 or {c['ID'] for c in criteria} != CODES:
        raise ValueError('Expected one official row for each criterion C-01 through C-20.')
    if any(not c[k] for c in criteria for k in [*ANCHORS, 'Fatal?', 'Source', 'Notes']):
        raise ValueError('A required scoring anchor or source field is missing.')
    prompt_map = {p['Prompt ID']: p for p in prompts}
    if len(prompts) != 36 or len(prompt_map) != 36 or any(not p['Exact English Prompt'] for p in prompts):
        raise ValueError('Expected 36 unique, nonempty prompts.')
    models = Counter(r[MODEL] for r in responses)
    pairs = {(r['Prompt ID'], r[MODEL]) for r in responses}
    if (len(responses) != 108 or len({r['Response ID'] for r in responses}) != 108
        or models != {'ChatGPT': 36, 'Gemini': 36, 'Claude': 36}
        or pairs != {(p, m) for p in prompt_map for m in models}):
        raise ValueError('Expected 108 unique responses covering each prompt/model pair.')
    for p in prompts:
        p['candidate_codes'] = sorted(set(re.findall(r'C-\d{2}', p['Candidate Criteria'] or '')))
        if set(p['candidate_codes']) - CODES:
            raise ValueError(f"Unknown rubric code for {p['Prompt ID']}.")
    mismatch, duplicates = [], defaultdict(list)
    for r in responses:
        r.pop(None, None)
        if not isinstance(r[RAW], str) or not r[RAW].strip():
            raise ValueError(f"Missing response text for {r['Response ID']}.")
        p = prompt_map[r['Prompt ID']]
        if r['Exact Prompt Used'] != p['Exact English Prompt']:
            mismatch.append(r['Response ID'])
        duplicates[(r[MODEL], r[RAW])].append(r['Response ID'])
        r['phase'] = ('Expanded' if 'transcript' in (r['Collection Method'] or '').lower() else 'Pilot')
        r['group'] = p['Comparison Group']
        r['case'] = p['Case']
    changes = {}
    for c in criteria:
        variants = reference[c['ID']]
        fields = [key for key, value in c.items() if not variants or any(r.get(key) != value for r in variants)]
        if fields or len(variants) != 1:
            changes[c['ID']] = dict(workbook_rows=len(variants), differing_fields=fields)

    report = dict(prompts=len(prompts), responses=len(responses), criteria=len(criteria), models=models,
                  phases=Counter(r['phase'] for r in responses), prompt_mismatches=mismatch,
                  duplicate_text=[r for r in duplicates.values() if len(r)>1], rubric_differences=changes,
                  source_integrity_flags=[{k:r[k] for k in ('Check ID','Response ID(s)','Check Focus','Verification Status')}
                                          for r in checks if 'duplicat' in str(r.get('Check Focus','')).lower()],
                  historical_counts={'04 Pilot Evaluation': len(old), '08 Review Evidence': len(second)},
                  sheets={k:list(v) for k,v in supporting.items()},
                  required_columns={'01 Pilot Prompts': list(prompts[0])[:-1],
                                    '02 Testing Log': list(responses[0])[:-3],
                                    'Criteria (EN)': list(criteria[0])},
                  hashes=[hashlib.sha256(b).hexdigest() for b in (rubric_blob, study_blob)])
    return dict(prompts=prompts, responses=responses, criteria=criteria, chinese=chinese,
                checks=checks, historical=second, report=report, supporting=supporting)


def import_pair(rubric_blob, study_blob, names, preview=False):
    data = parse(rubric_blob, study_blob)
    data['version'] = hashlib.sha256(''.join(data['report']['hashes']).encode()).hexdigest()
    data['report']['files'] = names
    data['report']['imported_at'] = now()
    if not preview:
        with db() as conn:
            conn.execute('INSERT OR IGNORE INTO imports VALUES (?,?)', (data['version'], json.dumps(data, default=str)))
    return data['report']


@app.post('/api/import')
def upload(rubric: UploadFile = File(...), study: UploadFile = File(...), preview: bool = False):
    files = [rubric, study]
    if any(not (f.filename or '').lower().endswith('.xlsx') for f in files):
        raise HTTPException(400, 'Select two .xlsx files.')
    blobs = [f.file.read(8_000_001) for f in files]
    if any(len(b) > 8_000_000 for b in blobs):
        raise HTTPException(413, 'Each workbook must be 8 MB or smaller.')
    try:
        return import_pair(*blobs, [Path(f.filename).name for f in files], preview)
    except Exception as exc:
        raise HTTPException(400, f'Workbook validation failed: {str(exc)[:280]}') from exc


def load_events(conn, version, table):
    return [json.loads(r[0]) for r in conn.execute(
        f'SELECT payload FROM {table} WHERE version=? ORDER BY rowid', (version,))]


@app.get('/api/state')
def state():
    with db() as conn:
        data = get_active(conn)
        data['evaluations'] = list(historical_rows(data))
        if 'supporting' in data:
            data.pop('supporting')
            data.pop('chinese')
            data.pop('historical')
        version = data.get('version', '')
        data['reviews'] = load_events(conn, version, 'reviews')
    return data


def context(conn, response_id, criterion_id):
    data = get_active(conn)
    for kind, key, value in [('responses', 'Response ID', response_id), ('criteria', 'ID', criterion_id)]:
        found = next((x for x in data.get(kind, []) if x[key] == value), None)
        if not found:
            raise HTTPException(404, f'Unknown {key}.')
        if kind == 'responses':
            response = found
    prompt = next(p for p in data['prompts'] if p['Prompt ID'] == response['Prompt ID'])
    return data['version'], response, prompt, found


class Review(BaseModel):
    response_id: str
    criterion_id: str
    actor: str
    decision: str
    rating: str
    exact_quote: str = ''
    comment: str
    verification: str
    critical: str


@app.post('/api/review')
def review(entry: Review):
    if (entry.decision not in ('Independent', 'Unresolved') or entry.rating not in RATINGS
        or entry.verification not in ('Unverified', 'Pending', 'Verified', 'Not required')
        or entry.critical not in ('Unadjudicated', 'Dismissed', 'Confirmed')
        or not entry.actor.strip() or not entry.comment.strip()):
        raise HTTPException(400, 'Enter a valid decision, reviewer label, and reason.')
    if (entry.decision == 'Unresolved' and entry.rating != 'Pending'
        or entry.verification == 'Pending' and entry.rating != 'Pending'):
        raise HTTPException(400, 'Unresolved reviews and decisive pending checks require a Pending rating.')
    with db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        version, response, _, criterion = context(conn, entry.response_id, entry.criterion_id)
        if entry.exact_quote and entry.exact_quote not in response[RAW]:
            raise HTTPException(400, 'Quote must appear verbatim in the original response.')
        if entry.rating in RATINGS[:3] and not entry.exact_quote.strip():
            raise HTTPException(400, 'A scored rating requires a verbatim quote.')
        if entry.critical == 'Confirmed' and (entry.rating != 'No' or 'CF-' not in criterion['Fatal?']):
            raise HTTPException(400, 'Confirmation requires a No rating and a criterion with a critical trigger.')
        previous = [v for v in load_events(conn, version, 'reviews')
                    if all(v[k]==getattr(entry,k) for k in ('response_id','criterion_id'))]
        value = dict(entry.model_dump(), id=str(uuid.uuid4()), timestamp=now(),
                     previous_rating=previous[-1]['rating'] if previous else None)
        conn.execute('INSERT INTO reviews VALUES (?,?,?)', (value['id'], version, json.dumps(value)))
    return value


PILOT = '04 Pilot Evaluation'
SECOND = '08 Review Evidence'
HUMAN = 'Human Review'


def historical_rows(data):
    sources = data.get('supporting', {}).get('study', {})
    configs = {
        PILOT: ('Evaluation ID', 'Criterion', 'Rubric Rating (AI preliminary)', 'Exact Response Evidence',
                'Rationale Against Rubric', 'Critical Failure', 'Medical Evidence Source',
                'Local Fact Check', 'Human Review Status'),
        SECOND: ('Response ID', 'Criterion ID', 'Current rating', 'Exact response excerpt',
                 'Review rationale (中文)', 'AI critical-failure flag', 'Evidence reference',
                 None, 'Review provenance'),
    }
    responses = {r['Response ID']: r for r in data.get('responses', [])}
    for source, (header, code, rating, quote, rationale, flag, reference, fact, provenance) in configs.items():
        sheet = sources.get(source, [])
        if not sheet:
            continue
        i = next(i for i, row in enumerate(sheet) if row[0] == header)
        for cells in sheet[i+1:]:
            row = dict(zip(sheet[i], cells))
            found = responses.get(row.get('Response ID'))
            if not found or row.get(code) not in CODES:
                continue
            text = row.get(quote) or ''
            status = row.get(rating)
            normalized = 'Pending' if status == 'Pending verification' else status
            critical = row.get(flag) or ''
            yield dict(response_id=found['Response ID'], prompt_id=found['Prompt ID'], model=found[MODEL],
                       domain=found['Health Domain'], setting=found['Study Setting'], group=found['group'],
                       case=found['case'], phase=found['phase'], criterion_id=row[code], source=source,
                       rating=normalized, source_rating=status, evidence=text,
                       quote_match='Exact match' if text and text in found[RAW] else 'Unmatched' if text else 'No excerpt',
                       rationale=row.get(rationale), critical_candidate=bool(re.search(
                           r'candidate|^potential', critical, re.I)), source_critical_flag=critical,
                       source_reference=row.get(reference), source_fact_check=row.get(fact),
                       source_provenance=row.get(provenance), evaluation_date=row.get('Evaluation Date'),
                       record_status='Preliminary')


def result_rows(data, reviews, source):
    latest = {(r['response_id'], r['criterion_id']): r for r in reviews}
    if source == HUMAN:
        base = []
        for (rid, cid), review in latest.items():
            record = next((r for r in data.get('responses', []) if r['Response ID'] == rid), None)
            if record:
                base.append(dict(response_id=rid, prompt_id=record['Prompt ID'], model=record[MODEL],
                                 domain=record['Health Domain'], setting=record['Study Setting'], group=record['group'],
                                 case=record['case'], phase=record['phase'], criterion_id=cid, source=HUMAN,
                                 rating=review['rating'], record_status='Reviewer decision', critical_candidate=False))
    else:
        base = (r for r in historical_rows(data) if r['source'] == source)
    for entry in base:
        review = latest.get((entry['response_id'], entry['criterion_id']), {})
        yield dict(entry, review_rating=review.get('rating'), review_quote=review.get('exact_quote'),
                   review_verification=review.get('verification'), review_critical=review.get('critical'),
                   reviewer=review.get('actor'), review_status=review.get('decision'),
                   review_timestamp=review.get('timestamp'), review_reason=review.get('comment'),
                   rubric_import=data['version'])


def summarize(entries, groups):
    grouped = defaultdict(Counter)
    for entry in entries:
        grouped[tuple(entry[g] for g in groups)][entry['rating']] += 1
    result = []
    for fields, counts in grouped.items():
        scored = sum(counts[k] for k in RATINGS[:3])
        points = counts['Yes']*2 + counts['Partially']
        result.append(dict(zip(groups,fields), **{r:counts[r] for r in RATINGS},
                           applicable=scored+counts['Pending'], scored_points=points, scored_max=2*scored,
                           scored_subset_pct=round(100*points/(2*scored),2) if scored else None))
    return result


@app.get('/api/results')
def results(source: str = SECOND):
    if source not in (PILOT, SECOND, HUMAN):
        raise HTTPException(400, 'Unknown result source.')
    with db() as conn:
        data = get_active(conn)
        version = data.get('version','')
        reviews = load_events(conn, version, 'reviews')
    return list(result_rows(data, reviews, source)), reviews


def safe_cell(value, csv_export=False):
    if not isinstance(value,str):
        return value
    cleaned = ILLEGAL_CHARACTERS_RE.sub('',value)
    if csv_export and cleaned.lstrip().startswith(('=', '+', '-', '@')):
        return "'" + cleaned
    return cleaned


@app.get('/api/export/{format}')
def export(format: str, source: str = SECOND):
    entries, history = results(source)
    if format == 'csv':
        out = io.StringIO()
        if entries:
            writer = csv.writer(out)
            writer.writerow(entries[0])
            writer.writerows([safe_cell(v,True) for v in row.values()] for row in entries)
        return Response(out.getvalue().encode('utf-8-sig'), media_type='text/csv',
                        headers={'Content-Disposition':'attachment; filename=evaluation-results.csv'})
    if format != 'xlsx':
        raise HTTPException(404)
    book = Workbook()
    book.remove(book.active)
    summaries = summarize(entries, ['response_id','prompt_id','model','domain','setting'])
    history_fields = list(dict.fromkeys(key for row in history for key in row))
    history = [{key:row.get(key) for key in history_fields} for row in history]
    for name, dataset in [('Criterion Results',entries), ('Response Summary',summaries), ('Review History',history)]:
        sheet = book.create_sheet(name)
        if dataset:
            sheet.append(list(dataset[0]))
            for row in dataset:
                sheet.append([safe_cell(v) for v in row.values()])
                for cell in sheet[sheet.max_row]:
                    if cell.data_type=='f':
                        cell.data_type='s'
            sheet.freeze_panes = 'A2'
            sheet.auto_filter.ref = sheet.dimensions
    buf = io.BytesIO()
    book.save(buf)
    return Response(buf.getvalue(), media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    headers={'Content-Disposition':'attachment; filename=evaluation-results.xlsx'})


@app.get('/api/source-zip')
def source_zip():
    files = ['app.py', 'schema.sql', 'README.md', 'DELIVERY_STATUS.md', 'requirements.txt',
             'requirements-test.txt', '.gitignore', 'verify.py',
             'static/app.js', 'static/index.html', 'static/style.css']
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in files:
            archive.write(ROOT / name, 'ai-safety-evaluation-mvp/' + name)
    return Response(buf.getvalue(), media_type='application/zip',
                    headers={'Content-Disposition':'attachment; filename=ai-safety-evaluation-mvp.zip'})


@app.get('/')
def index():
    return FileResponse(ROOT/'static'/'index.html')


app.mount('/static',StaticFiles(directory=ROOT/'static'),name='static')


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('rubric', type=Path)
    parser.add_argument('study', type=Path)
    args = parser.parse_args()
    print(json.dumps(import_pair(args.rubric.read_bytes(),args.study.read_bytes(),
                                [args.rubric.name,args.study.name]), indent=2))
