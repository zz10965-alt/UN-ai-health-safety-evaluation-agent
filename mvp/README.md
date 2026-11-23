# AI Safety Evaluation Assistant

An offline research workspace for the UN-ICC × NYU capstone. Browse the original study records, inspect preliminary evidence beside the official rubric, record independent decisions, and export the results.

## Launch the presentation

Requires Python 3.10 or newer. From the directory containing this README:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

On Windows, activate the virtual environment with `.venv\Scripts\Activate.ps1`. Open http://127.0.0.1:8000. In **Data & Rubric**, select the official rubric and Testing Log supplied with the project, then validate and import them. Alternatively, import them from the command line before starting the server:

```bash
python app.py /path/to/official-rubric.xlsx /path/to/testing-log.xlsx
```

After installing the dependencies, the entire app runs offline. The source ZIP contains the app and test code. Use your existing workbook copies for the presentation. The app reads them without modifying the source files. SQLite state lives in `local/study.sqlite3` by default. To use a different path, set `EVAL_DB` consistently for the import and the web server. The default local launch listens on your own computer.

## Present the workflow

1. **Overview** shows 36 study prompts, 108 collected responses, and 20 official rubric criteria.
2. **Data & Rubric** opens the full original prompt and response, workbook provenance, official scoring anchors, and import report.
3. **Evaluation Workspace** filters either of the two preliminary worksheet sources by model, rating, criterion, or potential Critical Failure. Select a row to inspect evidence, rationale, provenance, and the official anchors. Pilot excerpts that differ from the original response are visibly flagged.
4. **Human Review** records independent assessments and unresolved decisions. Reviewer identity, evidence, reason, verification status and critical-failure decision are stored separately from historical records.
5. **Results & Export** selects a worksheet source or human decisions and displays response or criterion summaries. Excel and CSV download the full selected source, including separate reviewer fields where present. Excel also includes review history. **Download source ZIP** packages the application.

The pilot tab contains 495 preliminary records. The second-review tab contains 632 preliminary records. Each tab is scored separately. Source flags and human adjudication have distinct fields. Scored-subset percentages exclude N/A and Pending. The app records C-05 rubric discrepancies and the unresolved V-023 source duplication concern. The expanded phase used six prompts per shared model conversation.

Live AI evaluation is a future enhancement. This release has no external AI runtime dependency.

## Reproduce browser verification

```bash
python -m pip install -r requirements-test.txt
python -m playwright install chromium
python verify.py /path/to/official-rubric.xlsx /path/to/testing-log.xlsx --output /tmp/evaluation-verification
```

To use an installed Chromium, append `--chromium /path/to/chromium`. Verification uses a disposable database. Sample exports produced by the suite include a clearly labeled software-test review.
