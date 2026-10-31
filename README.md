# ReguLens — Regulatory Change Impact Agent

** Monitor, discover and understand regulatory changes.** Built for Azentio Build Labs.

ReguLens helps BFSI compliance teams collect official regulatory publications, extract structured obligations with source citations, compare supported clauses with earlier regulations, and record human review. It combines a searchable dashboard, configurable source adapters, a persistent background worker and Amazon Bedrock analysis.

[GitHub repository](https://github.com/gokulkrish10/RIA_Scope) · [API contract](docs/API_CONTRACT.md) · [Presentation walkthrough](docs/LEVEL1_DEMO_PRESENTATION.md)

## What works

- **Monitoring:** official-source adapters for Saudi Arabia, UAE, India and Africa; manual runs, configurable intervals and a scheduler in the regular worker.
- **Ingestion:** PDF, DOCX and UTF-8 text uploads; monitored regulatory HTML; private original storage, text extraction, content-hash deduplication and document versions.
- **Understanding:** Bedrock extracts obligations, business areas, affected entities/activities, dates and earlier references. Accepted citations must match the exact stored version and excerpt.
- **Historical comparison:** explicit reference/authority matching, predecessor linking, cited old/new clauses, deterministic highlights and proposed explanations.
- **Dashboard and review:** country, regulator, date, business-area, change-class and state filters; human review notes with a server-configured reviewer and stale-update protection.

Six supported change classes: new obligation, modified obligation, withdrawn/superseded obligation, deadline changed (extended or shortened), clarification, and no material change. Synthetic fixtures exercise every class; real findings are displayed only when supported by evidence.

**Acceptance is not completion.** A queued job has been saved for the worker. Text extraction, AI analysis, relationship resolution and human review are separate stages. A missing predecessor or failed extraction is never presented as “no material change.”

## Quick start: existing presentation machine

From the repository directory:

```sh
npm run demo
```

Open [http://127.0.0.1:5173/#repository](http://127.0.0.1:5173/#repository) and sign in with your local operator account. One process starts the authenticated frontend, backend and worker against `.data/level1-demo`. Keep its terminal open; Ctrl+C stops all three. Do not also start separate application terminals in this mode.

The prepared snapshot starts with **7 official publications, 90 cited obligations and one real RBI historical comparison containing 3 proposed changes**. Uploads and review changes persist, so counts may increase during a presentation. Default demo mode uses saved real Bedrock results; new uploads extract text only, new AI requests are disabled, and automatic scheduling is paused. Manual **Run now** still contacts the official website.

**The saved database and original documents are private local artifacts, not included in Git.** `demo:prepare` can build the snapshot only when the earlier verification folders are available; it never overwrites an existing demo. On a fresh clone, use the setup below. A missing snapshot is not replaced with invented results.

The [presentation walkthrough](docs/LEVEL1_DEMO_PRESENTATION.md) provides the exact clicks, documents and upload fixture for a five-minute demo.

## Fresh-clone setup

Requirements: Node.js **22.13+**, npm, local writable disk for SQLite, and outbound HTTPS for official-source retrieval. Python 3 is needed only for preparing the saved presentation copy. Browser verification uses an installed Google Chrome. This project uses Vite and vanilla TypeScript, Node.js, SQLite, Zod, PDF.js and the AWS Bedrock Runtime SDK.

```sh
git clone https://github.com/gokulkrish10/RIA_Scope.git
cd RIA_Scope
npm ci
cp -n .env.example .env
chmod 600 .env
```

Keep an existing `.env`; the copy command does not overwrite it. Fill the private environment locally:

| Variable | Purpose |
| --- | --- |
| `RIA_WRITE_TOKEN` | Generate a random backend token, at least 32 characters. Server-only. |
| `RIA_FRONTEND_USER` | Local operator sign-in name. |
| `RIA_FRONTEND_PASSWORD` | Local operator password, at least 20 characters. |
| `RIA_REVIEWER_ID` | Generate a UUID for the trusted local reviewer. Required for review writes. |
| `RIA_DATA_DIR` | Regular backend data directory; default `.data/ria`. Use the same value for API and worker. |
| `PORT` | Regular API port; default `4010`. |
| `RIA_API_ORIGIN` | Frontend proxy target; default `http://127.0.0.1:4010`. |
| `RIA_SCHEDULER_ENABLED` | `false` initially; `true` on the regular worker enables scheduled monitoring. |
| `RIA_ANALYSIS_ENABLED` | `false` for initial text-only operation; `true` enables automatic analysis/backfill in the regular worker. |

Never commit `.env`, put credentials in `VITE_`/`NEXT_PUBLIC_` variables, or paste them into browser code. You can confirm local exclusion with `git check-ignore .env`.

Initialize the database and source catalog:

```sh
npm run backend:migrate
npm run backend:seed
```

These commands apply additive SQLite migrations and idempotently seed source configurations; they do not download publications. The initial publication repository is empty.

Start the regular application in **three terminals**, all from this checkout with the same `.env`:

```sh
# Terminal 1 — API
npm run backend:start
```

```sh
# Terminal 2 — text-ingestion worker
RIA_ANALYSIS_ENABLED=false npm run backend:worker
```

```sh
# Terminal 3 — authenticated frontend
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), sign in and select **Live API**. Upload a readable document, or select **Sources & monitoring → Run now** for one enabled source. A normal startup does not automatically switch to fixture data when the API fails.

Use **Sources & monitoring** to set an interval between **15 and 43,200 minutes**. For scheduled runs, restart the regular worker with `RIA_SCHEDULER_ENABLED=true`. Both demo launch modes intentionally leave scheduling paused.

## Real Bedrock analysis

The existing server-only adapter uses Bedrock Converse with structured tool output and validates the result before saving it. Configure temporary credentials and an explicit compatible region/model:

`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `BEDROCK_MODEL_ID`, and optionally `AWS_CREDENTIAL_EXPIRATION` for local UTC-expiry checks. The model/inference profile must support Converse forced tool choice and the selected region. Missing, expired or rejected credentials produce an actionable failure, not synthetic success.

On the prepared presentation machine, stop `npm run demo`, then explicitly enable new model work:

```sh
npm run demo:live
```

This retains the same demo database, enables analysis after new uploads and permits requested comparisons. It can incur model charges. It does not automatically backfill old text-only uploads.

To analyze or retry one existing version, take its UUID from **Publication detail → Document versions & identifiers** and run in a trusted terminal:

```sh
# While demo:live is running on the presentation database:
RIA_DATA_DIR=.data/level1-demo npm run backend:analyze -- '<version UUID>'
```

For the regular application, use the same command without the `RIA_DATA_DIR` override so it follows your configured database. The CLI returns a job ID; the worker processes it. To automatically analyze new and previously unanalysed versions in the regular application, restart that worker with `RIA_ANALYSIS_ENABLED=true` after configuring AWS.

In the **regular worker**, `RIA_ANALYSIS_ENABLED=false` disables automatic enqueue/backfill but still processes explicitly queued analysis/comparison jobs. It is not a global model-call block. The default **saved demo** explicitly blocks and does not execute model jobs.

## Data flow and architecture

```text
Official source / manual upload
    → persisted monitoring or ingestion job
    → bounded retrieval, private original, extracted text and document version
    → Bedrock structured extraction + exact citation validation
    → explicit predecessor resolution and supported clause comparison
    → dashboard and human review
```

- **Storage:** SQLite holds metadata, jobs, extracted text with locations, hashes, versions, analysis and comparisons. Original bytes are stored privately under the selected data directory. Repeated content is deduplicated; changed monitored content creates a new version. `.data/`, SQLite files, downloaded originals and generated reports are ignored by Git.
- **Matching:** earlier documents are matched by normalized explicit reference number and issuing authority, with a manual link path for supported predecessors. This is not semantic/vector retrieval; a similar title is not sufficient evidence.
- **Analysis:** bounded text segments and supported old/current clause text reach Bedrock. Unknown dates remain null and consultations remain proposed. Unsupported citations or over-limit results fail explicitly. No OCR or silent partial result is substituted.
- **Security:** direct API reads and writes require the backend bearer token. The loopback frontend gateway requires its own operator login and injects that token server-side. Reviewer identity is configured on the server, never supplied by the browser. Monitored HTML is preserved privately; displayed text is escaped. Challenge/login/error pages are rejected. Private-original downloads have no public API.

```text
src/client/                 Integrated dashboard and browser API client
src/shared/contracts/       Zod schemas, inferred types and endpoint registry
src/shared/fixtures/        Labelled synthetic contract responses
src/shared/presentation/    Browser-safe deterministic text diff
src/backend/                SQLite, API, worker, adapters, storage and analysis
scripts/                    Startup, demo preparation and verification commands
tests/                      Contract, backend, analysis, security and client tests
```

Both frontend and backend must import `API_CONTRACT` and schemas/types from `src/shared/contracts/index.ts`. Shared contract version is **1.1.0**. Do not independently rename fields, statuses or routes. The [API contract](docs/API_CONTRACT.md) defines all 13 operations, multipart fields, validation limits, pagination, errors and coordination gaps.

## Official-source evidence and limits

The following describes **previously verified results on 31 October 2026**, not a fresh availability check or exhaustive coverage of a regulator's website. The four-region demo uses SAMA, DFSA, RBI and Bank of Ghana notices.

| Region/source | Listing → retrieval → text | Saved real AI evidence | Limit |
| --- | --- | --- | --- |
| Saudi Arabia — [SAMA circulars](https://rulebook.sama.gov.sa/en/sama-circulars) | 2 circulars discovered, HTML fetched and extracted | 3 cited obligations on one selected circular | First 2 listed items; linked annexes excluded |
| UAE — [DFSA news](https://www.dfsa.ae/news) | 1 amendment notice discovered, HTML fetched and extracted | 4 cited obligations | Notice body only; CBUAE access was blocked with HTTP 403 |
| India — [RBI notifications](https://www.rbi.org.in/Scripts/NotificationUser.aspx) | 2 current notifications discovered, fetched and extracted | 4 cited obligations on one selected notice | First 2 listing items; historical pair is a separate source |
| Africa — [Bank of Ghana notices](https://www.bog.gov.gh/notice/) | 1 regulatory notice discovered, official PDF fetched and extracted | 2 cited obligations | First matching notice; procurement excluded |
| Additional — Kenya current circulars | 3 PDFs discovered and fetched; text extraction failed | No successful analysis for those image-only PDFs | Separate historical LIBOR PDF has 25 cited obligations; it is not general discovery |
| Additional — Ghana directives | Exposure-draft PDF fetched and text extracted | Analysis failed above the 200-obligation cap | No partial success; this source is disabled by default |

Repeated verified monitoring created no additional publication/version for unchanged content. Private reports remain in `.data/level1-four-region-VQTKb9` and `.data/level1-four-region-kK9YbO` on the verification machine.

The real historical comparison uses the [2022 RBI Digital Lending Guidelines](https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12382&Mode=0) and [2024 RBI KFS circular](https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12663&Mode=0). The saved result contains three proposed changes for explicitly referenced earlier paragraphs 5.1, 5.2 and 8. It preserves later-status notices and remains **historical analysis pending human review**, not current-law certification. Other unresolved references can leave the publication marked **Missing Predecessor** even when this pair has a successful comparison.

Remaining boundaries: no exhaustive listing pagination or linked-annex analysis, no OCR, no vector search, no public original-file download, and no production multi-user/tenant authorization. Insufficient clause evidence fails explicitly; it is not “no material change.” The API also lacks job-history listing and a dedicated discoverable structured-analysis trigger/state; see the contract notes.

## Validation and production build

```sh
npm run check           # Both TypeScript checks, fixture validation, unit/integration tests
npm run build           # Frontend production output in dist/
npm run verify:browser  # Chrome UI/API journey with synthetic source/model responses
```

With the private saved verification data available:

```sh
npm run verify:demo     # Separate copy: saved real citations, uploads, review and restart
```

Verified baseline: **220 tests, 48 contract fixtures, both type checks and production build pass**. Browser checks cover monitoring, predecessor upload/link, comparison, review persistence, search, scheduling, errors and authorization using synthetic transport/model responses. The separate saved-demo check revalidates **104 citations** and exercises TXT/DOCX/PDF uploads, unreadable-PDF failure and full restart persistence without new regulator or model calls.

Live verification is separate: `npm run verify:four-region` contacts official sites; `npm run verify:bedrock-smoke -- --live` makes a paid model request with labelled synthetic input; `npm run verify:rbi-history` can fetch official documents and invoke Bedrock. Do not treat unit-test success as proof of current external availability or legal correctness.

For a local production preview, keep the regular API and worker running and run `npm run preview -- --port 4180` after the build. `dist/` contains frontend assets only; the authenticated gateway and API are still required. This repository has **no public deployment URL**. Vite preview and loopback Basic authentication are for local use, not a production hosting design.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Upload remains queued | Keep `npm run demo` open, or ensure the regular worker is running with the API's exact `RIA_DATA_DIR`. Avoid repeated uploads. |
| Processing succeeded, no obligations | Text extraction succeeded. Check the separate AI stage; saved demo mode intentionally pauses new AI analysis. |
| Missing Predecessor | Inspect unresolved references. Supply/link the supported earlier document in analysis-enabled mode; do not substitute a similar document. |
| Port 4010/5173 already in use | Stop the older RIA terminal with Ctrl+C before starting another stack. |
| Login fails | Use `RIA_FRONTEND_USER` / `RIA_FRONTEND_PASSWORD`, not the backend write token. |
| Bedrock fails | Read the job error; check temporary credentials, expiry, explicit region/model and model permissions. Retry the exact version after correcting the cause. |
| Demo preparation cannot find data | Use fresh-clone setup or obtain the saved private evidence; it is intentionally not in Git. |


