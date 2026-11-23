"""Run browser and backend acceptance checks against a disposable study database."""
import argparse
import csv
import io
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from openpyxl import load_workbook
from playwright.sync_api import expect, sync_playwright

import app

parser = argparse.ArgumentParser()
parser.add_argument('rubric', type=Path)
parser.add_argument('study', type=Path)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--chromium', default=None)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)

scored = app.summarize([{'rating':r} for r in app.RATINGS], [])[0]
assert (scored['applicable'],scored['scored_points'],scored['scored_max'],scored['scored_subset_pct']) == (4,3,6,50)
print('PASS scoring arithmetic')

with tempfile.TemporaryDirectory() as work:
    with socket.socket() as server_socket:
        server_socket.bind(('127.0.0.1',0))
        port = server_socket.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    env = dict(os.environ,EVAL_DB=str(Path(work)/'test.sqlite3'))
    with subprocess.Popen([sys.executable,'-m','uvicorn','app:app','--host','127.0.0.1','--port',str(port)],
                          cwd=app.ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL) as server:
        try:
            for _ in range(100):
                try:
                    with socket.create_connection(('127.0.0.1',port),.1):
                        break
                except OSError:
                    time.sleep(.05)
            with sync_playwright() as p:
                browser=p.chromium.launch(executable_path=args.chromium,args=['--no-sandbox'])
                page=browser.new_page(viewport={'width':1440,'height':1000})
                page.set_default_timeout(6000)
                errors=[]
                page.on('pageerror',lambda exc: errors.append(str(exc)))
                external = []
                page.on('request',lambda req: external.append(req.url) if not req.url.startswith(base) else None)
                page.goto(base)
                expect(page.get_by_role('heading',name='AI Safety Evaluation Assistant')).to_be_visible()
                page.get_by_role('link',name='Browse research data').click()
                page.locator('[name=rubric]').set_input_files(args.rubric.resolve())
                page.locator('[name=study]').set_input_files(args.study.resolve())
                page.get_by_role('button',name='Validate & preview').click()
                expect(page.get_by_text('Validation passed.',exact=False)).to_be_visible()
                assert not page.request.get(base+'/api/state').json().get('responses')
                page.get_by_role('button',name='Import workbooks').click()
                expect(page.get_by_text('Import complete.',exact=False)).to_be_visible()
                expect(page.get_by_text('36 prompts · 108 responses · 20 criteria',exact=True)).to_be_visible()
                expect(page.get_by_text('V-023',exact=False).first).to_be_visible()
                data=page.request.get(base+'/api/state').json()
                pristine = {r['Response ID']:r[app.RAW] for r in data['responses']}
                w=load_workbook(args.study,read_only=True,data_only=True)
                expected={r[0]:r[8] for r in w['02 Testing Log'].values if r and r[0] not in (None,'Response ID')}
                w.close()
                assert pristine==expected
                assert data['report']['phases']=={'Pilot':36,'Expanded':72}
                assert data['report']['historical_counts']=={'04 Pilot Evaluation':495,'08 Review Evidence':632}
                assert 'C-05' in data['report']['rubric_differences']
                first_timestamp=data['report']['imported_at']
                upload={key:{'name':file.name,'mimeType':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                             'buffer':file.read_bytes()} for key,file in [('rubric',args.rubric),('study',args.study)]}
                assert page.request.post(base+'/api/import',multipart=upload).ok
                assert page.request.get(base+'/api/state').json()['report']['imported_at']==first_timestamp
                print('PASS workbook preview, browser import, provenance, idempotency and exact equality for all 108 source responses')
                page.get_by_role('button',name='Prompts',exact=True).click()
                assert page.locator('tbody tr').count()==36
                page.get_by_role('button',name='Rubric',exact=True).click()
                assert page.locator('main details').count()==20
                page.locator('main details summary').first.click()
                expect(page.get_by_role('heading',name='C-01 · Scoring anchors')).to_be_visible()
                page.get_by_role('button',name='Verification',exact=True).click()
                expect(page.get_by_text('V-023',exact=True)).to_be_visible()
                page.get_by_role('button',name='Responses',exact=True).click()
                page.get_by_label('Model',exact=True).select_option('ChatGPT')
                expect(page.get_by_text('36 of 108 responses')).to_be_visible()
                rid=data['responses'][0]['Response ID']
                page.get_by_role('button',name=rid,exact=True).click()
                expect(page.get_by_role('dialog')).to_be_visible()
                page.get_by_role('link',name='View preliminary evaluation').click()
                expect(page.get_by_role('heading',name='Evaluation Workspace')).to_be_visible()
                expect(page.get_by_text('632 of 632 preliminary records')).to_be_visible()
                page.get_by_label('Critical Failure filter').select_option('Potential CF')
                expect(page.get_by_text('14 of 632 preliminary records')).to_be_visible()
                candidate = next(e for e in data['evaluations'] if e['source']==app.SECOND and e['critical_candidate'])
                page.locator('[data-evaluation="'+candidate['response_id']+':'+candidate['criterion_id']+'"]').click()
                expect(page.get_by_text('Potential Critical Failure',exact=True)).to_be_visible()
                expect(page.get_by_role('heading',name='Scoring rationale')).to_be_visible()
                expect(page.get_by_text('Exact match',exact=True).last).to_be_visible()
                assert candidate['evidence'] in pristine[candidate['response_id']]
                page.locator('section').filter(has=page.get_by_role('heading',name=app.SECOND,exact=True)).screenshot(
                    path=args.output/'evaluation-workspace.png')
                page.get_by_label('Evaluation source').select_option(app.PILOT)
                expect(page.get_by_text('495 of 495 preliminary records')).to_be_visible()
                unmatched = next(e for e in data['evaluations'] if e['source']==app.PILOT and e['quote_match']=='Unmatched')
                page.locator('[data-evaluation="'+unmatched['response_id']+':'+unmatched['criterion_id']+'"]').click()
                expect(page.get_by_text('Source excerpt differs',exact=False)).to_be_visible()
                rid, cid = unmatched['response_id'], unmatched['criterion_id']
                page.get_by_role('link',name='Open human review').click()
                expect(page.get_by_role('heading',name='Human Review',exact=True)).to_be_visible()
                page.locator('#queue summary').click()
                page.get_by_label('Queue filter').select_option('Critical candidate')
                expect(page.locator('#queue summary')).to_contain_text('2 criterion records')
                page.get_by_label('Reviewer label').fill('Browser verification')
                page.get_by_label('Decision',exact=True).select_option('Unresolved')
                page.get_by_label('Fact verification').select_option('Pending')
                comment='Software acceptance test. No independent adjudication has been performed.'
                page.get_by_label('Reason / reference details').fill(comment)
                page.get_by_role('button',name='Save review').click()
                expect(page.get_by_text('Review saved.',exact=False)).to_be_visible()
                page.reload()
                page.locator('#response').select_option(rid)
                page.locator('#criterion').select_option(cid)
                expect(page.get_by_text('Browser verification · Pending · Unresolved',exact=True)).to_be_visible()
                page.get_by_text('Browser verification · Pending · Unresolved',exact=True).click()
                expect(page.get_by_text(comment,exact=True)).to_be_visible()
                restored=page.request.get(base+'/api/state').json()
                assert pristine=={r['Response ID']:r[app.RAW] for r in restored['responses']}
                page.locator('section').filter(has=page.get_by_role('heading',name='Reviewer decision',exact=True)).screenshot(path=args.output/'review-workflow.png')
                page.locator('nav a[href="#overview"]').click()
                expect(page.get_by_role('heading',name='AI Safety Evaluation Assistant')).to_be_visible()
                page.screenshot(path=args.output/'overview.png',full_page=True)
                page.locator('nav a[href="#results"]').click()
                page.get_by_role('button',name='Criterion summary').click()
                page.get_by_label('Model',exact=True).select_option('Claude')
                assert page.locator('tbody tr').count() > 0
                page.get_by_label('Model',exact=True).select_option('All')
                with page.expect_download() as download:
                    page.get_by_role('link',name='Download Excel').click()
                save=args.output/'sample-scoring.xlsx'
                download.value.save_as(save)
                book=load_workbook(save,data_only=True,read_only=True)
                assert len(list(book['Response Summary'].values))==109
                history=list(book['Review History'].values)
                assert dict(zip(*history))['response_id']==rid
                detail=list(book['Criterion Results'].values)
                assert len(detail)==633
                headers=detail[0]
                row=next(r for r in detail[1:] if r[headers.index('response_id')]==candidate['response_id']
                         and r[headers.index('criterion_id')]==candidate['criterion_id'])
                assert row[headers.index('evidence')]==candidate['evidence']
                assert len(list(book['Criterion Results'].values))==len(page.request.get(base+'/api/results').json()[0])+1
                book.close()
                page.get_by_label('Results source').select_option(app.PILOT)
                expect(page.get_by_role('link',name='Download CSV')).to_have_attribute('href','/api/export/csv?source=04%20Pilot%20Evaluation')
                with page.expect_download() as csv_download:
                    page.get_by_role('link',name='Download CSV').click()
                csv_file=args.output/'sample-pilot-scoring.csv'
                csv_download.value.save_as(csv_file)
                csv_rows=list(csv.DictReader(io.StringIO(csv_file.read_text(encoding='utf-8-sig'))))
                assert len(csv_rows)==495
                assert {r['rating'] for r in csv_rows}==set(app.RATINGS)
                assert any(r['reviewer']=='Browser verification' and r['rating']!=r['review_rating'] for r in csv_rows)
                page.get_by_label('Results source').select_option(app.HUMAN)
                expect(page.get_by_text('Scores reflect saved reviewer decisions.',exact=True)).to_be_visible()
                assert not errors, errors
                assert not external, external
                print('PASS Chromium navigation, source and flag filters, historical evidence, independent review persistence, dashboard and Excel/CSV exports (local requests only)')
        finally:
            server.terminate()
            server.wait(timeout=10)
