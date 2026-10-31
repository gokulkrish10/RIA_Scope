# Bedrock and scenario test guide

The production backend already uses `BedrockModel` in the worker. The shared Zod schemas, exact stored-text citations, versioned SQLite results, retry handling and review states remain unchanged. `RIA_ANALYSIS_ENABLED=false` in the manual demo stops automatic analysis after text extraction; it does not remove the Bedrock integration.

## Automated checks

Run `npm run check` for both TypeScript projects, 48 validated synthetic wire fixtures and the full unit/integration suite. Run `npm run build` for the frontend production build. Tests use isolated databases and synthetic model responses, so neither command invokes Bedrock or an official website.

| Scenario | Automated evidence | Boundary |
| --- | --- | --- |
| Source monitoring, atomic claim, failure/retry and schedule | `tests/backend.test.ts` | Official source availability requires a separate live run. |
| PDF, DOCX, text, corrupt/image-only files, HTML source routing, duplicate rerun and changed version | `tests/backend.test.ts`, `tests/source-repair.test.ts` | Manual uploads are not monitored publications; image-only PDF text needs a separate OCR design. |
| Shared fields, dates, error envelopes, pagination, enums and all six change classes with both deadline directions | `tests/contracts.test.ts`, `tests/analysis-validation.test.ts` | Class examples are synthetic; a real comparison should contain only supported classes. |
| Bedrock Converse forced tool request, server-owned quote IDs, invalid citations, expired credentials and access errors | `tests/analysis-validation.test.ts` | Mock transport verifies the request and response boundary without model charges. |
| Structured extraction, unknown dates, consultation proposals, missing/ambiguous predecessor, linking, comparison, idempotence, retries, persistence, review and filters | `tests/analysis-integration.test.ts` | A live model may make a different semantic proposal; human review is required. |
| API/gateway authorization and safe browser rendering | `tests/analysis-integration.test.ts`, `tests/gateway.test.ts`, `tests/client.test.ts` | Browser journey and deployed identity require separate verification. |

`npm run verify:browser` is a separate synthetic UI/API journey. It passed on 31 October 2026, covering monitoring, extraction, cited obligations, missing-predecessor linking, comparison, persisted review, search, scheduling and authorization. `npm run verify:rbi-history` is a separate official RBI pair check that can fetch documents and invoke Bedrock; do not run it just to repeat unit tests. The saved RBI result is historical analysis pending review, not a statement of current law.

## One controlled real Bedrock check

Set only the server-side environment names `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `BEDROCK_MODEL_ID`; `AWS_CREDENTIAL_EXPIRATION` enables an early expiry check. Do not put these in browser variables or committed files. The smoke command requires an explicit `--live` flag and can incur model charges:

```sh
npm run verify:bedrock-smoke -- --live
```

It sends one short, clearly labelled synthetic clause through the actual Bedrock Converse adapter. It checks that the model identifies the written-receipt duty, cites a verbatim stored-text segment, and leaves unspecified dates null. It writes a private ignored report under `.data/bedrock-smoke-*/report.json`; it does not touch the manual demo SQLite database, run monitoring, or claim regulatory validity. A failed request remains a failure; no fabricated result is saved.

Verified on 31 October 2026: `bedrock:ap-southeast-2:au.anthropic.claude-haiku-4-5-20251001-v1:0:analysis-v4` returned one cited synthetic obligation with null effective date and deadline. The private report is `.data/bedrock-smoke-1793439993284/report.json`. An initial sandboxed attempt failed with a generic request error; the network-enabled attempt passed. No credentials appear in the report.

## Analyze one document in the isolated demo

Keep the worker on the copied data directory with automatic backfill and scheduling off. `RIA_ANALYSIS_ENABLED=false` still lets it process an explicitly queued analysis job:

```sh
RIA_DATA_DIR=.data/manual-rbi-demo RIA_ANALYSIS_ENABLED=false RIA_SCHEDULER_ENABLED=false npm run backend:worker
```

In a second trusted terminal, take the exact version UUID from **Publication detail → Document versions & identifiers**, then queue that one version:

```sh
RIA_DATA_DIR=.data/manual-rbi-demo npm run backend:analyze -- '<version UUID>'
```

The command returns a `jobId`. Poll authenticated `GET /api/v1/jobs/:jobId` through the local frontend gateway; `queued` means accepted, `succeeded` means structured analysis completed, and `failed` contains an actionable error. Refresh the publication to view obligations and citations. The worker may make more than one model request if bounded retries or schema correction are needed. `RIA_ANALYSIS_ENABLED=true` enables automatic backfill of **every** unanalysed version in that database, so use it only when that scope is intended. Keep `RIA_SCHEDULER_ENABLED=false` unless deliberately testing the scheduler.

Unit tests and the synthetic smoke do not establish four-region listing discovery, OCR for image-only documents, or legal correctness of a real comparison. Those remain separate Level 1 checks.

The manual isolated RBI scheduler test also fired on 31 October 2026 at 15:17:25 IST: monitor job `d7f07145-1380-403e-90ea-f2133b551681` succeeded, found two selected documents and marked both already known. The source interval was restored to 1,440 minutes in `.data/manual-rbi-demo`; the next due time is 1 November 2026. This is evidence for scheduling and deduplication on the selected pair, not general RBI discovery.
