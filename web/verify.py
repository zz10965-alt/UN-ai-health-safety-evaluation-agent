"""Verify a static deployment with Chromium. Optional workbook inputs stay in the test browser."""
import argparse
import csv
import io
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('url')
parser.add_argument('--chromium')
parser.add_argument('--rubric', type=Path)
parser.add_argument('--study', type=Path)
args = parser.parse_args()
assert bool(args.rubric) == bool(args.study)
origin = urlsplit(args.url).netloc

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=args.chromium)
    page = browser.new_page(viewport={'width':1440,'height':1000})
    page.set_default_timeout(15000)
    errors, external, writes = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def check_request(request):
        url = urlsplit(request.url)
        if url.scheme in ('http','https') and url.netloc != origin:
            external.append(request.url)
        if request.method != 'GET':
            writes.append(request.method)

    page.on('request', check_request)
    response = page.goto(args.url)
    assert response and response.ok, f'Page status: {response.status if response else "no response"}'
    expect(page.get_by_role('heading',name='AI Safety Evaluation Assistant')).to_be_visible()
    expect(page.get_by_text('Synthetic demonstration data · For presentation only')).to_be_visible()

    def navigate(section):
        page.locator('nav').get_by_role('link',name=section).click()
        expect(page.get_by_role('heading',name=section,exact=True)).to_be_visible()

    navigate('Data & Rubric')
    page.get_by_label('Model',exact=True).select_option('Sample Alpha')
    expect(page.get_by_text('4 of 12 responses')).to_be_visible()
    page.get_by_role('button',name='DEMO-01A-ALPHA',exact=True).click()
    expect(page.get_by_role('dialog')).to_be_visible()
    expect(page.get_by_text('Leave by a marked exit if it is safe.',exact=True)).to_be_visible()
    page.get_by_role('link',name='View preliminary evaluation').click()
    expect(page.get_by_role('heading',name='Evaluation Workspace')).to_be_visible()
    page.get_by_label('Critical Failure filter').select_option('Potential CF')
    expect(page.get_by_text('1 of 12 preliminary records')).to_be_visible()
    page.get_by_role('button',name='DEMO-01A-GAMMA',exact=True).click()
    expect(page.get_by_text('Potential Critical Failure',exact=True)).to_be_visible()
    expect(page.get_by_text('The example delays action during a stated alarm.',exact=True)).to_be_visible()
    page.get_by_role('link',name='Open human review').click()
    expect(page.get_by_role('heading',name='Human Review',exact=True)).to_be_visible()
    expect(page.get_by_text('do not sync across devices',exact=False)).to_be_visible()
    page.get_by_label('Reviewer label').fill('Browser acceptance check')
    page.get_by_label('Decision',exact=True).select_option('Unresolved')
    page.get_by_label('Reason / reference details').fill('Synthetic workflow verification.')
    page.get_by_role('button',name='Save review').click()
    expect(page.get_by_text('Review saved.',exact=False)).to_be_visible()
    page.reload()
    page.locator('#response').select_option('DEMO-01A-GAMMA')
    expect(page.get_by_text('Browser acceptance check · Pending · Unresolved')).to_be_visible()
    navigate('Results & Export')
    page.get_by_role('button',name='Criterion summary').click()
    with page.expect_download() as csv_download:
        page.get_by_role('button',name='Download CSV').click()
    with open(csv_download.value.path(),encoding='utf-8-sig',newline='') as exported:
        rows = list(csv.DictReader(exported))
    assert len(rows)==12 and all(r['dataset']=='Synthetic demonstration' for r in rows)
    assert any(r['reviewer']=='Browser acceptance check' and r['rating']=='No' and r['review_rating']=='Pending' for r in rows)
    with page.expect_download() as xlsx_download:
        page.get_by_role('button',name='Download Excel').click()
    with zipfile.ZipFile(xlsx_download.value.path()) as book:
        assert b'Criterion Results' in book.read('xl/workbook.xml')
        assert b'Review History' in book.read('xl/workbook.xml')
    with page.expect_download() as zip_download:
        page.get_by_role('link',name='Download source ZIP').click()
    with zipfile.ZipFile(zip_download.value.path()) as source:
        names = source.namelist()
        assert any(n.endswith('/web/workspace.js') for n in names)
        assert all(not n.endswith(('.xlsx','.sqlite3')) for n in names)
    print('PASS static website, all five sections, filters, evidence, saved review, Excel/CSV and source ZIP')

    if args.rubric:
        from openpyxl import load_workbook
        navigate('Data & Rubric')
        page.locator('[name=rubric]').set_input_files(args.rubric)
        page.locator('[name=study]').set_input_files(args.study)
        page.get_by_role('button',name='Validate & preview').click()
        expect(page.get_by_text('36 prompts · 108 responses · 20 criteria',exact=True)).to_be_visible()
        page.get_by_role('button',name='Import workbooks').click()
        expect(page.get_by_text('Import complete.',exact=False)).to_be_visible()
        data = page.evaluate("workspace.request('state')")
        workbook = load_workbook(args.study,read_only=True,data_only=True)
        expected = {r[0]:r[8] for r in workbook['02 Testing Log'].values if r and r[0] not in ('Response ID',None)}
        workbook.close()
        assert {r['Response ID']:r['Full Raw AI Response (paste unchanged)'] for r in data['responses']}==expected
        assert data['report']['historical_counts']=={'04 Pilot Evaluation':495,'08 Review Evidence':632}
        assert 'C-05' in data['report']['rubric_differences']
        assert not data['reviews']
        navigate('Evaluation Workspace')
        expect(page.get_by_text('632 of 632 preliminary records')).to_be_visible()
        page.get_by_label('Evaluation source').select_option('04 Pilot Evaluation')
        expect(page.get_by_text('495 of 495 preliminary records')).to_be_visible()
        navigate('Results & Export')
        with page.expect_download() as private_csv:
            page.get_by_role('button',name='Download CSV').click()
        with open(private_csv.value.path(),encoding='utf-8-sig',newline='') as exported:
            rows = list(csv.DictReader(exported))
        assert len(rows)==632 and all(r['dataset']=='Imported study' for r in rows)
        navigate('Data & Rubric')
        page.get_by_role('button',name='Return to synthetic demo').click()
        expect(page.get_by_text('Synthetic demonstration data · For presentation only')).to_be_visible()
        print('PASS browser-only import, exact fidelity for all 108 responses, separate evaluation sets and private export')
    assert not errors, errors
    assert not external, external
    assert not writes, writes
    print('PASS browser issued same-origin reads only')
