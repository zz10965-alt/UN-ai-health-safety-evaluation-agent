# AI Safety Evaluation Assistant

Local, single-researcher workspace for the UN-ICC × NYU capstone. The frontend uses HTML, CSS and JavaScript. FastAPI serves the interface and API, openpyxl handles Excel, and SQLite persists imports, Judge runs and review decisions.

## Launch

Requires Python 3.10 or newer. From the directory containing this README:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000. In **Data & Rubric**, select the official rubric and original Testing Log from the assignment uploads, then validate and import. If preferred, import before launching:

```bash
python app.py /path/to/official-rubric.xlsx /path/to/testing-log.xlsx
```

The source package is independent of the research files. The original Excel files stay read-only. SQLite state lives in `local/study.sqlite3` by default. If you set `EVAL_DB`, use the same path for both CLI import and server startup. This interface is designed for local, single-user access. A shared deployment requires authentication and access controls.

## Gemini Judge

Set `GEMINI_API_KEY` in the server process environment and restart. Optionally set `GEMINI_MODEL` to a model available to the project. The default is `gemini-2.5-flash`. The server needs HTTPS access to `generativelanguage.googleapis.com`. Select the response and criterion, then click **Run Gemini Judge**. A click submits the original study prompt, original answer and selected official criterion to Google. In offline mode you can document an independent human decision.

Every request creates a new run with request settings, returned provider body, status, timestamps and reported usage. Invalid structured output and unverifiable quotes fail validation. Failed requests can be retried by submitting a new run. The interface displays historical workbook reviews for comparison. The Judge request uses the official rubric and original study text exclusively.

## Verify

```bash
python -m pip install -r requirements-test.txt
python -m playwright install chromium
python verify.py /path/to/official-rubric.xlsx /path/to/testing-log.xlsx --output /tmp/evaluation-verification
```

To use an installed Chromium, append `--chromium /path/to/chromium`. Verification creates a disposable SQLite database. Its exported sample includes a labeled software test decision and has no live Judge results.

## Research provenance

The supplied workbooks describe 36 pilot responses and 72 expanded responses. The app derives phase from collection-method provenance in the supplied Testing Log. Expanded-phase responses came from six prompts per shared model conversation. See the import report and verification log for the open duplicated-source-block issue V-023. The 108 imported cells are preserved verbatim. Tab 04 and tab 08 provide distinct historical coverage with 495 and 632 records. The official separate workbook governs the scoring anchors, including the C-05 discrepancy.

Data import validates this study's 36-prompt and three-model layout. Matching workbook hashes reuse an existing version. A distinct pair is stored as a separate version and becomes the active study. Source worksheets are preserved in the uploaded originals and imported snapshots. Dashboard percentages are scored-subset percentages. Pending ratings and independent fact checks remain visible, and critical-failure adjudication stays separate.
