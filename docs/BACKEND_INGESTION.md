# Backend ingestion checkpoint

Implemented on `feature/gokul-backend`, based on shared foundation `306f0c94998a5c14717f5abccf319b08c20c8f3c`. Shared schemas, types, fixtures, endpoint names and enum values remain unchanged. No frontend files, Bedrock integration or second application backend were added. Sethu confirmed through Gokul that her adapter work has not started; there were no existing adapters to overwrite.

The older “all endpoints planned” implementation notes in the foundation documents describe that earlier commit. This document records the current backend implementation; `docs/API_CONTRACT.md` remains the wire specification.

## What works

| Operation | Endpoint | Result |
| --- | --- | --- |
| List configured sources | GET `/api/v1/sources` | 200 SourceListResponseSchema |
| Trigger monitoring | POST `/api/v1/monitor-runs` | 202 MonitorAcceptedResponseSchema + Location header; requires backend write token |
| Read job | GET `/api/v1/jobs/:jobId` | 200 JobStatusSchema, including queued/running/failed/succeeded |
| Read monitor result | GET `/api/v1/monitor-runs/:jobId/result` | 200 MonitorRunResultSchema; 409 resultNotReady until terminal |
| Search/list publications | GET `/api/v1/publications` | 200 PublicationListResponseSchema |
| Read publication and document versions | GET `/api/v1/publications/:publicationId` | 200 PublicationDetailSchema |

Every response is parsed through its shared schema before serialization. Error responses use ApiErrorSchema. Bad IDs/query/body return 400; missing resources return 404; unauthorized writes return 401; overlapping source runs return 409. A monitor run can succeed while its later ingestion job fails. Poll the `ingestionJobIds` returned for newly discovered publications separately.

Not implemented at this checkpoint: HTTP source updates, multipart manual uploads, obligations endpoint, review updates, historical comparison/predecessor operations, Bedrock, OCR and structured obligation extraction. Unimplemented operations return an error, not empty successful data. Do not connect those UI actions yet.

## Run locally

Requirements: Node **22.13+** (verified here on 26.3.0), npm, filesystem access for SQLite and private originals, and outbound HTTPS to configured official hosts. SQLite comes from `node:sqlite`. PDF.js requires the pinned `@napi-rs/canvas` dependency, including its native binary for your platform; `npm ci` installs it. There is no Python, external database or cloud credential requirement.

Create a private `.env` with a generated token without printing it:

```sh
npm ci
node --input-type=module -e 'import {writeFileSync} from "node:fs"; import {randomBytes} from "node:crypto"; writeFileSync(".env", "RIA_WRITE_TOKEN=" + randomBytes(32).toString("hex") + "\nRIA_DATA_DIR=.data/ria\nPORT=4010\nRIA_SCHEDULER_ENABLED=false\n", {flag:"wx",mode:0o600});'
npm run backend:migrate
npm run backend:seed
```

`flag: wx` prevents overwriting an existing `.env`. If one exists, retain it and add the missing settings using `.env.example`. The example intentionally has an empty token so it cannot become a working shared credential by accident. Seed is idempotent and never overwrites an existing source/configuration.

Run in separate terminals:

```sh
npm run backend:start
```

```sh
npm run backend:worker
```

The API binds only `127.0.0.1:4010`. The worker drains persisted jobs until stopped. `npm run backend:worker-once` claims at most one ready job; repeat to process the monitor and each ingestion job. Graceful worker shutdown finishes its current bounded attempt; an interrupted process is recovered after lease expiry. No server process is left running by the verification script.

Set `RIA_SCHEDULER_ENABLED=true` **on the worker** to enqueue due enabled sources. It is off by default. Source frequency defaults to daily for the seeded source. Scheduled due checks and source locks are transactional; several worker processes on the same local database are supported. SQLite WAL is intended for a single host/local disk, not a shared network filesystem or horizontally distributed deployment.

## Exact requests for Sethu

Read requests are available without credentials on the loopback server:

```sh
curl -sS http://127.0.0.1:4010/api/v1/sources
curl -sS 'http://127.0.0.1:4010/api/v1/publications?country=KE&page=1&pageSize=20'
curl -sS 'http://127.0.0.1:4010/api/v1/publications?q=LIBOR&processingState=succeeded'
```

From a **trusted backend terminal**, load the locally generated `.env` and trigger the seeded official source:

```sh
set -a
. ./.env
set +a
curl -sS -i http://127.0.0.1:4010/api/v1/monitor-runs \
  -H "Authorization: Bearer $RIA_WRITE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"sourceIds":["8c0c0445-9ed4-4ebc-887e-54bb9dcd5291"]}'
```

The 202 body is exactly `{ "jobId": "<allocated UUID>", "state": "queued" }`. Set JOB_ID to that returned ID:

```sh
JOB_ID='<jobId returned by POST>'
curl -sS "http://127.0.0.1:4010/api/v1/jobs/$JOB_ID"
curl -sS "http://127.0.0.1:4010/api/v1/monitor-runs/$JOB_ID/result"
```

After the worker completes discovery, use `sources[0].ingestionJobIds[0]` for a **newly discovered** publication and `sources[0].discoveredPublications[0].id` for its detail:

```sh
INGESTION_JOB_ID='<returned ingestion job ID>'
PUBLICATION_ID='<returned publication ID>'
curl -sS "http://127.0.0.1:4010/api/v1/jobs/$INGESTION_JOB_ID"
curl -sS "http://127.0.0.1:4010/api/v1/publications/$PUBLICATION_ID"
```

On a duplicate-free rerun, `alreadyKnownCount` increases, `discoveredPublications` and `ingestionJobIds` are empty, and the stored document/version IDs remain the same. Changed bytes on a known publication produce a new version and ingestion job internally; by the existing contract, monitor result ingestion IDs describe only **new publications**. Refresh the publication detail to watch a changed known publication's current version. No additional public fields or endpoints were invented to expose internal progress.

Frontend connection: configure Sethu's development/server proxy to forward `/api/v1` to `http://127.0.0.1:4010`. That **server-side proxy** must add the write Authorization header from its private environment. Never embed RIA_WRITE_TOKEN in browser code, localStorage, `VITE_*`, `NEXT_PUBLIC_*`, fixtures, or a client-readable config. The backend does not enable broad CORS; using a same-origin proxy avoids changing frontend API paths. Authentication for deployed end users is a later coordinated step, not a browser-shipped shared token.

Import schemas and types from `src/shared/contracts/index.ts`, exactly as in the Sethu guide. Date-only values remain strings, and null dates stay null. No endpoint returns database rows, original paths, hashes, extraction-process diagnostics or credentials.

## Ingestion and persistence design

`migrations/001_ingestion.sql` creates sources, jobs, monitoring runs/source results, source locks, publications, document versions, ingestion tasks and job event history. Migrations run under a transaction, record a SHA-256 checksum and reject edits to an already applied migration. Foreign keys, unique publication identity/version constraints, WAL, busy timeout and full synchronous commits are enabled.

Journey:

1. Trigger transaction validates configured/enabled sources, snapshots their adapter configuration, creates a queued job and locks the selected sources. 202 is returned only after commit.
2. A worker atomically claims a ready job with `BEGIN IMMEDIATE`, a random claim token and a 60-second lease. A heartbeat extends the lease; every publication/result write checks the token and expiry.
3. The adapter discovers candidate metadata. The worker downloads originals, validates format/size and writes private content-addressed blobs. Only then can a public DocumentVersion truthfully contain its positive `sizeBytes`.
4. Each source batch commits publications, document versions, ingestion jobs and its monitor result **together**. If a download fails, that batch commits no publications or ingestion jobs. A completed source batch is skipped on crash recovery; other source results remain independently visible in the final run result.
5. Ingestion jobs verify stored hashes, extract text in an isolated child process, and persist text/page boundaries. Success/failure is atomically saved with the document version and a schema-valid immutable job-result snapshot.
6. Monitoring completion releases source locks. Repeated attempts reuse the same job while publicly running; terminal jobs never silently requeue.

Publication identity is `(sourceId, adapter canonicalKey)`. For CBK numbered circulars the key is normalized issuer/circular reference; otherwise it is the official download URL. Within a publication, `(publicationId, SHA-256)` is unique. Unchanged content creates no version or ingestion task. Changed content creates the next version while keeping previous metadata and originals. A return to a previously seen hash selects that already preserved version as current, rather than duplicating it. Originals are globally content-addressed, so even different catalog records with the same bytes share one private blob. Explicitly rerunning monitoring after failed extraction may create a new ingestion job for the same version; it does not duplicate the publication/version. Earlier job-result snapshots remain unchanged.

Files are mode 0600 under mode 0700 storage directories, written through temporary files and atomically renamed after syncing. Database files live outside served paths and are ignored by Git. Blobs from a failed/aborted source batch may remain unreferenced; retention/garbage collection is not implemented. Do not delete blobs merely because a failed attempt did not commit: another concurrent run may reference the same content hash. No original-download/static-file route exists.

Operational progress (`discovering`, `downloading`, `sourceCommitted`, `extracting`, `retryWaiting`, attempt numbers and safe failures) is stored in private `job_events`, not added to the public JobStatus enum. Safe inspection:

```sql
SELECT id, kind, state, stage, attempts, max_attempts, available_at, lease_until FROM jobs;
SELECT job_id, at, stage, detail_json FROM job_events ORDER BY sequence;
```

## Boundaries and retries

- HTTPS only, explicit adapter host allowlist, public IPv4 DNS resolution pinned to the connection, normal TLS verification, all redirects revalidated, maximum three redirects. Private IPs/metadata endpoints and credentials in URLs are rejected. IPv6-only official hosts are not supported yet.
- Listing cap 4 MiB, file cap 20 MiB, maximum 100 candidate documents per source attempt, individual fetch deadline 30 seconds, whole worker attempt deadline 180 seconds. The verified checkpoint scans one selected document. Compressed HTTP transport is rejected; original PDF/DOCX bytes remain intact.
- Text extraction runs in a child process with no inherited environment credentials, 256 MiB JS heap limit, 45-second deadline and 16 MiB output-buffer cap. PDF max 300 pages; extracted text max 2,000,000 characters. DOCX ZIP metadata is bounded to 2,000 entries/40 MiB declared expanded bytes; only document XML/content types are read. UTF-8 text rejects invalid encoding/NULs. Scanned, encrypted, corrupt and over-limit documents fail explicitly. Native parser memory is not an OS-level sandbox; hostile-file isolation beyond this local checkpoint remains deployment work.
- Transient network/429/5xx failures use up to three work attempts, exponential 1s/2s backoff, persisted availability and safe error events. Permanent 4xx, format/size failures and parser failures terminate immediately. Expired leases are reclaimable; a recovery claim past the budget only terminalizes the job without more external work. An old claimant cannot commit after takeover.
- Error messages are sanitized; raw subprocess errors, private file paths and upstream bodies are not returned to clients. Source failures use sourceUnavailable. Version/ingestion failures use extractionFailed, per the existing enums.

## Real verification and current limitations

`npm run verify:real-ingestion` creates an isolated private database, starts a temporary loopback API, triggers the worker against the live [CBK circulars listing](https://www.centralbank.go.ke/policy-procedures/legislation-and-guidelines/circulars/), reads job/list/detail/result endpoints, verifies original hash and extracted text, and repeats the run. It closes the server and database afterwards. It never reads or changes your normal `.data/ria` database. Its original files/report remain in ignored `.data/verification-*` for local inspection.

Verified **2026-10-31 at 12:19:45 IST** against the [official LIBOR guidance PDF](https://www.centralbank.go.ke/uploads/banking_circulars/1583576875_CBK%20Guidance%20on%20Libor%20Transition.pdf): 220,804 bytes, 8 pages, 12,954 extracted characters; SHA-256 `73ed07237c791d9f34da9861a56e84a566b9a08d64eb7e1692aa1d952423c87c`. First run and second run both passed; the second retained **one publication, one document version, one ingestion task**. Source listing only exposes year-level information, so publication/effective dates remain null rather than fabricated dates.

The listing's first/newest circular was also attempted. It was downloaded/stored but contained no extractable text, and its ingestion job/version correctly failed with extractionFailed. OCR is not part of this checkpoint. Accordingly, `CBK_CHECKPOINT_OPTIONS` explicitly scopes the seeded adapter to **“Central Bank of Kenya Guidance on LIBOR Transition”**, maximum one document. This verifies the mechanics against a real source; it is not a claim of full CBK/latest-publication coverage. Source scope can be expanded server-side after OCR/adapter coverage is agreed.

Text extraction success is **not regulatory understanding**. Publication detail intentionally has `summary: null`, empty obligations/references/businessAreas/changeClasses, and `relationshipState: unchecked`. Do not label empty obligation arrays “no obligations found” in this checkpoint. The obligations endpoint is not yet implemented; it will be connected when structured extraction is ready. Business-area/change-class filters consequently return zero matches until that work exists. Country/regulator/date/search/processing/review/relationship filters are wired to the available metadata, and text search uses the persisted extracted text.

Other limitations: only the Kenya adapter is configured (four-region coverage remains later work); SQLite is local-only; no Bedrock, review/identity workflow, cloud storage, original-file retention policy, or deployment is included. No frontend or shared contract changes are needed for the working endpoints above.

## Validation

```sh
npm run check                    # strict Node/browser types, 47 fixtures, all contract/backend tests
npm run test:backend             # local deterministic ingestion/worker/API tests
npm run verify:real-ingestion    # opt-in live network + real loopback HTTP verification
git diff -- src/shared          # expected empty
```

Deterministic tests cover text/PDF/DOCX extraction, corrupted/binary input, private storage, repeat-run deduplication, changed-document versioning, failed downloads, source-batch atomicity, bounded retries, multi-connection claims, expired lease fencing, crash recovery, scheduler duplication prevention, token protection, schema-valid APIs, query semantics and network size/host boundaries. The live source test is separate so ordinary test runs are repeatable and offline.
