# Analysis integration checkpoint

Branch: `feature/gokul-backend`. Shared foundation: `306f0c94998a5c14717f5abccf319b08c20c8f3c`. Preserved text-ingestion checkpoint: `980b469ae0458096672deb4e76fef495c19f0e15` (local only). This guide supersedes earlier implementation-status lists, not the wire specification in [API_CONTRACT.md](API_CONTRACT.md).

SQLite, the original ingestion tables, shared contract schemas and frontend files are preserved. Additive migrations `002_analysis.sql` and `003_analysis_version_locks.sql` add versioned results, jobs, validated chunk caching, comparisons, explicit links and version locks. There is one backend and one worker entry point. No deployment or push is part of this checkpoint.

## Local configuration and commands

Use Node 22.13+ and `npm ci`. Keep the existing ignored `.env`; fill the names in `.env.example`. Never commit its values.

- `RIA_WRITE_TOKEN`: at least 32 characters, trusted server-side writes only.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`: explicitly configured temporary credentials. The adapter does not use a default credential chain.
- `AWS_REGION`, `BEDROCK_MODEL_ID`: explicit region and a model/inference profile that supports Converse forced tool choice. The profile must support that region. No automatic region/model fallback.
- `AWS_CREDENTIAL_EXPIRATION`: optional UTC timestamp for preflight expiry checking; AWS still rejects expired sessions if omitted. Refresh all credential values and restart the worker after expiry.
- `RIA_ANALYSIS_ENABLED=true` (default): enqueue structured extraction after text parsing and backfill previously ingested versions. Set false for the preserved text-only checkpoint. Explicitly queued analysis/comparisons still run.
- `RIA_SCHEDULER_ENABLED=true`: opt in to due-source monitoring; false by default.
- `RIA_REVIEWER_ID`: trusted local reviewer UUID, required for review writes. Until configured, they return 403. This single-operator checkpoint does not provide deployed end-user identity/authorization.

```sh
npm run backend:migrate
npm run backend:seed
npm run backend:start       # terminal 1, loopback only
npm run backend:worker      # terminal 2, same private SQLite/data directory
```

For an existing version or an explicit retry after correcting credentials/model settings:

```sh
npm run backend:analyze -- '<version UUID>'
```

This returns `{ "jobId": "<UUID>", "state": "queued" }`; the worker must run. Repeating a successful analysis with the same version/model reuses results. A failed terminal job requires an explicit retry; it is never automatically reported successful. There is no new HTTP analysis route or public analysis job kind.

## Implemented operations

All JSON request and response schemas come from `src/shared/contracts/index.ts` and `API_CONTRACT`. All writes need the bearer token. Reads are available on the loopback API.

| Method/path | Request → successful response | Other relevant status codes |
| --- | --- | --- |
| GET `/api/v1/sources` | pagination → SourceListResponse, 200 | 400 |
| PATCH `/api/v1/sources/:sourceId` | SourceUpdateRequest → SourceConfig, 200 | 400, 401, 404, 409 |
| POST `/api/v1/monitor-runs` | MonitorRequest → MonitorAcceptedResponse, 202 | 400, 401, 404, 409 |
| GET `/api/v1/jobs/:jobId` | JobStatus, 200 | 400, 404 |
| GET `/api/v1/monitor-runs/:jobId/result` | MonitorRunResult, 200 | 404, 409 |
| POST `/api/v1/publications/upload` | multipart file + metadata → UploadAcceptedResponse, 202 | 400, 401, 404, 409, 413, 415, 422 |
| GET `/api/v1/publications` | PublicationSearchQuery → PublicationListResponse, 200 | 400 |
| GET `/api/v1/publications/:publicationId` | PublicationDetail, 200 | 400, 404 |
| GET `/api/v1/publications/:publicationId/obligations` | PublicationObligationsResponse, 200 | 404, 409 not ready, 422 extraction failed |
| POST `/api/v1/publications/:publicationId/comparisons` | ComparisonRequest → ComparisonAcceptedResponse, 202 | 400, 401, 404, 409 |
| GET `/api/v1/comparisons/:comparisonId` | Comparison, 200, including queued/processing/blocked/failed | 400, 404 |
| POST `/api/v1/publications/:publicationId/predecessor` | PredecessorLinkRequest → ComparisonAcceptedResponse, 202 | 400, 401, 404, 409, 422 |
| PATCH `/api/v1/publications/:publicationId/review` | ReviewUpdateRequest → ReviewRecord, 200 | 400, 401, 403, 404, 409 |

Every error body uses ApiErrorSchema. A 202 and `state: queued` acknowledge the request; they do not prove execution success. Idempotent replay can return the existing job, which may already be terminal: always read it. Accepted responses include a Location header for job polling.

## Exact requests and polling

Run write examples only in a trusted backend terminal/server. Export the private environment without printing it. In these examples PUB, VERSION, JOB, COMP, REF, PREV_PUB and PREV_VERSION stand for UUIDs from actual responses; do not send the placeholder strings.

```sh
curl -sS http://127.0.0.1:4010/api/v1/sources
curl -sS http://127.0.0.1:4010/api/v1/monitor-runs \
  -H "Authorization: Bearer $RIA_WRITE_TOKEN" -H 'Content-Type: application/json' \
  --data '{"sourceIds":["8c0c0445-9ed4-4ebc-887e-54bb9dcd5291"]}'
curl -sS "http://127.0.0.1:4010/api/v1/jobs/$JOB"
curl -sS "http://127.0.0.1:4010/api/v1/monitor-runs/$JOB/result"
curl -sS "http://127.0.0.1:4010/api/v1/publications/$PUB"
curl -sS "http://127.0.0.1:4010/api/v1/publications/$PUB/obligations"
```

Monitoring discovers documents and returns text-ingestion job IDs for newly discovered publications. Those original jobs retain their text-stage semantics. Structured extraction then runs in a separate persisted internal job using the existing public `ingestion` kind. Publication `processingState` reflects queued/processing/failed analysis once queued; the obligations endpoint returns 409 until a structured result exists, or 422 on failure. Refresh the publication and obligations after the original ingestion job succeeds. Do not equate that job's historical success snapshot with complete structured readiness. The CLI exposes an analysis job ID for direct polling; a discoverable structured-analysis job ID is a documented future contract proposal.

### Upload a missing predecessor

Supply exactly one `file` binary part and one `metadata` JSON text field. File limit: 20 MiB; metadata: 16 KiB UTF-8; whole request: 21 MiB. Supported pairs: `.pdf` + `application/pdf`, `.docx` + `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `.txt` + `text/plain`. PDF/DOCX signatures and text UTF-8 are checked; parsing runs in the existing bounded isolated extractor. Image-only PDFs fail explicitly; no OCR is added. Duplicate original bytes for the same configured source return 409.

```sh
curl -sS http://127.0.0.1:4010/api/v1/publications/upload \
  -H "Authorization: Bearer $RIA_WRITE_TOKEN" \
  -F 'file=@/absolute/path/predecessor.txt;type=text/plain' \
  -F 'metadata={"title":"Predecessor title","regulatorId":"af8b2367-c260-41d8-aa9b-d142c75a83ca","country":"KE","kind":"circular","referenceNumber":"EXACT/REFERENCE/NUMBER","publicationDate":null,"effectiveDate":null,"sourceId":null}'
```

Response shape: `{ "jobId": "<UUID>", "publicationId": "<UUID>", "documentId": "<UUID>", "versionId": "<UUID>", "state": "queued" }`. Use the returned IDs after text ingestion succeeds. Manual uploads currently require an existing configured source with the same regulator/country; a missing catalog entry returns 404. A null public sourceId stays null; internal source association is not exposed. Uploads create publications, not replacements of existing versions; URL ingestion continues to version changed bytes.

### Compare, resolve and rerun

```sh
curl -sS "http://127.0.0.1:4010/api/v1/publications/$PUB/comparisons" \
  -H "Authorization: Bearer $RIA_WRITE_TOKEN" -H 'Content-Type: application/json' \
  --data "{\"currentVersionId\":\"$VERSION\",\"predecessorVersionId\":null}"
curl -sS "http://127.0.0.1:4010/api/v1/jobs/$JOB"
curl -sS "http://127.0.0.1:4010/api/v1/comparisons/$COMP"
```

Comparison acceptance: `{ "jobId": "<UUID>", "comparisonId": "<UUID>", "publicationId": "<UUID>", "state": "queued" }`. Poll jobs at a modest interval (for example 1–2 seconds) until succeeded/blocked/failed. GET comparison remains 200 for a persisted failure; inspect its state and issue, not HTTP status alone.

Explicit reference number + issuing authority must match stored metadata and cited source text. Similar titles are never substituted. Missing predecessors produce blocked/missingPredecessor with nonempty unresolvedReferenceIds; multiple exact matches produce blocked/ambiguousPredecessor. The publication's references and relationshipState are the agreed relationship read operations.

After uploading/identifying the exact predecessor:

```sh
curl -sS "http://127.0.0.1:4010/api/v1/publications/$PUB/predecessor" \
  -H "Authorization: Bearer $RIA_WRITE_TOKEN" -H 'Content-Type: application/json' \
  --data "{\"currentVersionId\":\"$VERSION\",\"referenceId\":\"$REF\",\"predecessorPublicationId\":\"$PREV_PUB\",\"predecessorVersionId\":\"$PREV_VERSION\"}"
```

This verifies ownership, exact reference/known authority, text readiness and cycles, persists the source evidence, and atomically queues a new comparison. Previous blocked/failed comparison records remain historical records. Alternatively POST comparisons again to rerun automatic resolution after a newly uploaded exact match. A specified predecessorVersionId must already have a supporting resolved reference; it cannot force comparison against an arbitrary similar document.

### Search, source frequency and review

```sh
curl -sS 'http://127.0.0.1:4010/api/v1/publications?country=KE&businessArea=banking&changeClass=deadlineChanged&page=1&pageSize=20'
curl -sS 'http://127.0.0.1:4010/api/v1/publications?publicationDateFrom=2020-01-01&publicationDateTo=2026-12-31&relationshipState=missingPredecessor'
curl -sS http://127.0.0.1:4010/api/v1/sources/8c0c0445-9ed4-4ebc-887e-54bb9dcd5291 \
  -X PATCH -H "Authorization: Bearer $RIA_WRITE_TOKEN" -H 'Content-Type: application/json' \
  --data '{"monitoringIntervalMinutes":60,"enabled":true}'
curl -sS "http://127.0.0.1:4010/api/v1/publications/$PUB/review" \
  -X PATCH -H "Authorization: Bearer $RIA_WRITE_TOKEN" -H 'Content-Type: application/json' \
  --data '{"state":"inReview","note":null,"expectedUpdatedAt":"<review.updatedAt from fresh detail>"}'
```

Repeat country/regulatorId/businessArea/changeClass keys for OR within one filter; different filters combine with AND. Date range is inclusive on publication date, never effective/discovery date. Unknown dates are excluded only when a date range is requested. Null source dates stay null. Pagination remains page/pageSize/total/hasNextPage, with stable discovery-time/ID ordering. Source URL edits must stay on the configured official origin and source writes conflict with active monitoring locks.

Reviews start at pending. New/revised analysis and comparison requests reset review. expectedUpdatedAt prevents stale writes (409); rejection requires a note. Completing review requires successful processing, and approval additionally requires resolved/notRequired relationships and a successful latest comparison when one exists. The actor comes only from the server configuration; Sethu must not supply a browser actor or embed the bearer token. Review controls still need frontend wiring and deployed user identity design.

## Evidence, failure and retry semantics

The model uses a forced `record_analysis` structured tool response through Bedrock Converse; that tool executes no actions. Outputs derive from shared Zod schemas and must pass validation before persistence. Evidence must point to the exact immutable document/version and deterministic persisted page/text-segment locator, with a contiguous verbatim excerpt. The Bedrock tool uses internal quote IDs selected from server-owned persisted text. The adapter expands those IDs to exact SourceEvidence objects and validates the resulting shared-schema shape. The model cannot rewrite citation text or choose arbitrary version IDs. Unknown/malformed quote IDs, wrong-side comparison citations, invented text or wrong versions reject the result. No fuzzy text repair is performed. PDF page numbers are retained; TXT/DOCX locations use numbered text blocks when there is no trustworthy pagination. Unknown dates remain null. Consultations/drafts and proposed obligations are visibly labelled proposed; no invented public status fields are added.

Comparisons use verified old/current versions, cited before/after text and a plain-English proposed explanation. All six shared classes are supported, including deadlineChanged with extended/shortened direction. A known predecessor with insufficient supported clauses fails comparisonFailed, never noMaterialChange. Baseline comparisons without predecessor references may contain only evidenced new obligations. Public review stays pending until a human reviews it.

Internal progress events, up to three job attempts (with at most one schema-correction retry per model result), exponential retry delay, atomic SQLite claims, heartbeat leases and claim-token checks prevent stale workers from overwriting newer work. Per-version locks prevent concurrent analysis/comparison jobs from duplicating model extraction. Validated chunks survive model failures; invalid output never enters the cache. Cache identity includes model configuration, prompt and exact version/text input. Comparison requests reuse successful identical requests; failed/blocked requests can be retried. Original files, SQLite rows, internal model status, storage paths and credentials never appear in public responses.

Example HTTP error envelope (synthetic IDs):

```json
{"error":{"code":"extractionFailed","message":"AWS temporary credentials were rejected or expired. Refresh all three credential values and expiration, restart the worker, and retry.","retryable":false,"details":[]},"requestId":"11111111-1111-4111-8111-111111111111","timestamp":"2026-10-31T07:00:00.000Z"}
```

A failed job instead has `state: failed`, ErrorInfo in `error`, and the schema-defined result. A blocked comparison has `state: blocked`, an issue such as missingPredecessor and reference IDs requiring resolution. Extraction failures return actionable configuration/access/citation errors without raw AWS responses or secrets. No fake success is substituted when credentials are absent/expired.

## Frontend imports and handoff

```ts
import {
  API_CONTRACT, PublicationDetailSchema, JobStatusSchema,
  ComparisonSchema, PublicationObligationsResponseSchema, ApiErrorSchema,
} from '../shared/contracts/index.js'; // adjust relative prefix only
import { highlightDiff } from '../shared/presentation/diff.js';

const publication = PublicationDetailSchema.parse(await response.json());
const fragments = highlightDiff(change.before?.excerpt ?? '', change.after.excerpt);
// Render fragment.text as escaped text. kind is equal | removed | added.
```

The deterministic helper preserves exact before/after text and groups the changed token span. The same fragments are persisted privately. There is no invented JSON diff field. Configure a trusted same-origin server proxy for `/api/v1` to loopback; inject the write bearer token on that server only, with user authorization before exposing writes. Do not ship it in browser bundles, localStorage, VITE_* or NEXT_PUBLIC_* values. Contracts and the diff helper have no server/database/AWS imports.

Paste to Sethu's coding agent:

> Work on Sethu's frontend branch from shared foundation 306f0c94998a5c14717f5abccf319b08c20c8f3c. Import schemas/types and API_CONTRACT from src/shared/contracts/index.ts; do not invent fields, statuses or routes. Read docs/ANALYSIS_INTEGRATION.md for current backend behavior. Poll accepted job IDs, distinguish blocked/failed/succeeded, refresh publication/obligations for structured readiness, render pending review and unresolved references explicitly, and import highlightDiff from src/shared/presentation/diff.ts for cited old/new text. Use a trusted server proxy for writes; never put RIA_WRITE_TOKEN or AWS credentials in browser code. Coordinate source-adapter ownership before adding regional adapters.

## Verification and remaining scope

Verification results are recorded below after running the final checks. `npm run check` runs both TypeScript projects, synthetic fixture validation and all tests. `npm run verify:live-analysis` requires temporary credentials and the private official original produced by `npm run verify:real-ingestion`; it creates an isolated private verification database and closes its local HTTP server. Pass an existing `.data/analysis-verification-<number>` directory as its only argument to resume that isolated verification and reuse validated chunks. It never writes production data. Live comparison inputs are explicitly synthetic unless otherwise stated; they do not establish an actual regulatory amendment.

| Level 1 item | Current state / remaining work |
| --- | --- |
| Four-region listing discovery | Not complete. Only the preserved narrow official CBK LIBOR source is verified. No duplicate regional adapters added. Agree ownership with Sethu first. |
| Frequency/scheduler | Persisted source frequency PATCH and opt-in due scheduler work; local worker must remain running. No managed scheduler/deployment. |
| PDF/DOCX/text upload | Multipart API and bounded parser path implemented. Manual sources require a configured regulator/country. Image-only OCR remains missing. |
| Search/filters | Existing contract filters implemented, including extracted business areas and successful change classes. No semantic search added. |
| Review controls | Backend PATCH, pending resets, server actor and optimistic concurrency implemented. Frontend controls and deployed user authorization remain. |
| Structured contract gaps | Separate analysis readiness/job discovery, typed requirement/document status, server diff and insufficientEvidence issue need agreement; see ANALYSIS_CONTRACT_PROPOSALS.md. |
| Comparison scale | Explicit failure above 80,000 combined characters; clause selection for larger documents is future work. Extraction chunks are bounded, with no partial result published on failure. |

### Verified results — 2026-10-31

- `npm run check`: **passed** — TypeScript server/browser checks, **47** synthetic fixtures and **188** tests (0 failed/skipped). Coverage includes all six classes plus both deadline directions, null dates, proposed consultations, invalid citations/quote IDs, missing/ambiguous predecessors, persisted linking/comparison/review, idempotency, bounded correction/retries, concurrent version locks, expired-lease fencing, upload validation, original database preservation and ingestion regressions.
- `npm run verify:live-analysis -- .data/analysis-verification-1793430998916`: **passed**, completed `2026-10-31T07:19:21.585Z`. This resumed isolated failed attempts using validated chunks; earlier invalid model responses remained failures and were never published.
- Live model: `au.anthropic.claude-haiku-4-5-20251001-v1:0`, region `ap-southeast-2`, adapter identity suffix `analysis-v3`. The initial US profile was invalid in Sydney; the ignored local config now uses the documented Australia profile for the same model/region. [AWS model/profile documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html).
- Official source: [CBK Guidance on LIBOR Transition PDF](https://www.centralbank.go.ke/uploads/banking_circulars/1583576875_CBK%20Guidance%20on%20Libor%20Transition.pdf), original SHA-256 `73ed07237c791d9f34da9861a56e84a566b9a08d64eb7e1692aa1d952423c87c`. The verified ingestion artifact was uploaded/parsed again in the isolated database, then analysed live: **26 obligations, 27 exact stored-text citations, review pending**. Publication `28ec7cb4-7300-46dc-84e7-bf04cb381aaa`, version `3805254f-325a-40f0-8762-b2a22773d1a8`, successful analysis job `5adcda75-42a9-4061-8cf6-1369ec0b2233`.
- Live comparison: **synthetic inputs, actual Bedrock calls**, not an actual historical regulatory amendment. Stored previous version `33b250d3-6b1d-4ff5-ac45-d9d814af0dcb` and current version `fdd69792-14ff-47e2-8264-9de828805ec7` produced comparison `491f829f-d121-4604-b1e3-5810a4a74575`, job `868723e6-5e4e-4e11-b55b-f6b182f48d4a`, class `deadlineChanged` with extended direction and cited old/new text. Review pending; repeated request reused the successful job. A real historical regulatory pair still needs to be supplied/verified.
- Private evidence: `.data/analysis-verification-1793430998916/report.json`, isolated SQLite and originals. These are ignored local verification artifacts, not committed fixtures or seeded application records. The verification server was closed. To inspect these IDs locally, explicitly select that isolated directory with `RIA_DATA_DIR` when starting the backend; ordinary `.data/ria` will not contain them.
- `git diff --check`: passed. Shared contracts/fixtures and frontend files are unchanged. Changed safe files were scanned against configured credential/token values with no matches; `.env` and `.data` remain ignored. No production operation, push, merge or deployment occurred.

No live-model credential blocker remains for this run. Sessions can expire: refresh temporary credentials and restart the worker before subsequent live work. Review writes on the ordinary local server still require `RIA_REVIEWER_ID`; tests used an explicitly synthetic server-side reviewer identity. Four-region discovery, a real historical pair, frontend controls, deployed authorization and the proposed shared-contract additions remain outside this verified checkpoint.
