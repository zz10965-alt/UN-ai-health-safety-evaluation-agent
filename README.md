# AI Safety Evaluation Assistant

A browser-only MVP for presenting the AI safety evaluation workflow. The website has five sections: Overview, Data & Rubric, Evaluation Workspace, Human Review, and Results & Export.

The published site opens with 4 synthetic prompts, 12 handwritten sample responses, and 3 illustrative criteria. The examples have no relationship to the unpublished study answers. In **Data & Rubric**, users who have the original workbooks can import both to inspect 36 prompts, 108 original responses, 20 official criteria, and the two preliminary evaluation sets. The files and full responses stay in the current browser tab. The app can produce Excel and CSV files for the selected source.

Human review decisions persist in browser-local storage for the dataset. They do not sync across devices or browser profiles. Reloading clears private imports from memory. Reimport the exact same files to see their saved decisions. A reviewer’s label, reason, and any pasted quotation are part of the saved decision. Use a trusted browser profile when working with private records.

## GitHub Pages

The repository owner selects **Settings → Pages → Build and deployment → Source → GitHub Actions**. The Pages workflow builds on pushes to `main` and can also be run from the Actions tab. After deployment it checks the returned live URL in Chromium. Only the generated static website and the tracked source archive are deployed.

## Build and verify

```bash
npm --prefix web ci --ignore-scripts
npm --prefix web run build
```

Serve `web/dist` with any static HTTP server. For browser verification, install `mvp/requirements-test.txt`, install Chromium with `python -m playwright install chromium`, and run:

```bash
python web/verify.py http://127.0.0.1:8000/
```

The browser verification script can also test private imports with `--rubric path/to/rubric.xlsx --study path/to/testing-log.xlsx` and the `openpyxl` requirement from `mvp/requirements.txt`. The published app itself needs only a browser. The optional legacy local server is documented in [mvp/README.md](mvp/README.md).

No original research workbooks, private corpus, credentials, databases, or dependency directories belong in the tracked repository or Pages artifact.
