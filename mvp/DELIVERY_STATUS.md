# Delivery status

## Completed & verified

- FastAPI and SQLite with five interactive English-language pages.
- Workbook preview, import, idempotency, study filters and exact source comparison. Chromium and workbook checks verified 36 prompts, 108 verbatim responses (36 per evaluated model), and 20 criteria. The original workbooks were read only.
- Source audit preserves the V-023 duplication concern, the C-05 workbook discrepancy and separate counts of 495 and 632 historical judgments.
- Independent human review and versioned review history. Chromium saved and restored a labeled software-test decision in a disposable database. The working study contains no software-test decisions.
- Result filters, scoring arithmetic and Excel/CSV download. The sample workbook contains pending entries and one labeled software-test review. It contains no live Judge results.
- Judge response validation tests cover evidence substrings, applicability and critical-flag constraints.

## Implemented but not yet verified

- Live Gemini HTTP request and provider response parsing under real service credentials. The local missing-key state was verified in Chromium.
- Real Judge-based review confirmation and amendment. Independent review persistence was verified in Chromium.

## Blocked (credentials/access)

- Live representative trials require a usable server-side Gemini API key, model access and HTTPS egress to `generativelanguage.googleapis.com`. The current cloud instance has no configured key or allowlisted Gemini hostname.
- This workspace has no HTTP deployment portal. The supported fallback is a verified local launch.

## Not implemented

- Public or multi-user hosting with authentication.
- Approved external reference catalog and independently automated clinical or legal fact checking. Researchers can record verification status and source details in review.
- Automatic retry scheduling and parallel Judge batches. A failed request can be retried as a new versioned run.
