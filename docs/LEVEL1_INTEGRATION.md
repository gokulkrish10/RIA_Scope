# Local Level 1 integration checkpoint

> Repair update: [REAL_SOURCE_REPAIR.md](REAL_SOURCE_REPAIR.md) records the approved monitored-HTML contract extension, source diagnostics and real RBI historical verification. Statements below describe the earlier checkpoint.

This is a verified local integration, **not completed Level 1 coverage**. The UI, API, SQLite persistence and worker run together. Four-region production discovery and a real historical/current comparison with validated document citations remain blocked/incomplete.

## Inputs and preservation

- Active integration branch: `codex/level1-integration`.
- Backend input: `36075123cc23a3699e3ac8f5cea5186ec35c7936` — reviewed and locally committed analysis work from `feature/gokul-backend`.
- Frontend input: `47479f0fe7b09e5e69448562ca2fa900f07ee7cc` — fetched `origin/feature/sethu`, author `sethu-7 <sethu7praveen@gmail.com>`, subject “UI implementations”. It was the only new matching remote branch; no branch was guessed.
- Common foundation: `306f0c94998a5c14717f5abccf319b08c20c8f3c`.
- Local merge: `017ecc5`. Conflicts were README, package.json and package-lock.json. Both sets of scripts/dependencies were retained, Vite pinned to 8.3.5, and Node >=22.13 retained for SQLite. Screens and contracts had no textual merge conflicts.

No main/dev merge, push or deployment occurred. No environment secrets, SQLite, originals, browser screenshots or `.data` verification artifacts are committed. Only the credential-free `.env.example` template is tracked. The backend input preserves the previous ingestion checkpoint; Sethu's input branch is untouched. Shared contract schemas and synthetic fixtures remain byte-for-byte equal to the common foundation.

## Run the combined application

Use Node 22.13+ (verification used 26.3.0). Keep the ignored `.env`; compare its variable names with `.env.example` without publishing its values.

```sh
npm ci
npm run backend:migrate
npm run backend:seed
npm run backend:start       # terminal 1: 127.0.0.1:4010
npm run backend:worker      # terminal 2: same private data directory
npm run dev                 # terminal 3: authenticated local Vite frontend
```

The browser opens the Vite loopback URL and prompts for the local workspace account:

- `RIA_FRONTEND_USER` / `RIA_FRONTEND_PASSWORD` are the separate local operator login (password minimum 20 characters). They are loaded only by the Node gateway; no injected frontend environment config is used.
- `RIA_WRITE_TOKEN` is the backend bearer credential (minimum 32 characters). The gateway injects it for `/api/v1` on the server; browser requests do not contain it.
- `RIA_REVIEWER_ID` is the trusted UUID associated with this one local operator. The API supplies it; browser actor IDs are not accepted. The existing local environment now contains a configured reviewer UUID and generated operator password. Find them only in your private environment, not Git/chat.
- `RIA_API_ORIGIN` defaults to `http://127.0.0.1:4010` and must remain a loopback HTTP origin.
- Temporary AWS credentials, explicit region and model ID remain server-only as described in ANALYSIS_INTEGRATION.md.
- `RIA_SCHEDULER_ENABLED=true` enables due-source scheduling on the running worker. Source frequency is edited through the UI/API. It is off by default; saving a frequency does not start a worker.
- `RIA_ANALYSIS_ENABLED=false` permits text-only ingestion. The UI then shows structured analysis as pending instead of an empty successful obligations result. This mode cannot complete structured analysis.

The default UI mode is now **Live API**. Explicit synthetic mode retains Sethu's visible demo banner and disables mutations; network failures never switch to fixtures. A prior browser choice of synthetic mode is respected.

```sh
npm run build
npm run preview -- --port 4180
```

The local production preview also requires the operator login and proxies to the backend. `dist` alone is static output: it does not contain authentication or the API gateway. A deployed host, TLS, identity provider, permissions, session policy and storage authorization design remain future work; Vite preview is not a production deployment architecture.

## Integration changes and screen coverage

| Screen/operation | Connection and verified behavior |
| --- | --- |
| Repository | Shared search/publication schemas; actual country/regulator/date/business-area/change-class/state filters and pagination. Browser exercised empty search and persisted change-class filter. |
| Sources | Actual list/PATCH/monitor/job/result operations. Fixed upstream port, authenticated writes, persisted interval configuration. |
| Upload | Actual multipart file + metadata endpoint. Browser TXT upload/recovery passed. Backend regression tests cover DOCX/PDF extraction, signatures, limits and invalid payloads. No fake upload completion. |
| Publication detail | Actual publication read plus obligations-read readiness check. A successful original text-ingestion job no longer implies semantic readiness; 409 shows pending and polls. |
| Evidence/comparison | Actual comparison request/read and predecessor-link operations. Old/new excerpts use the shared browser-safe `highlightDiff` helper, escaped before rendering. |
| Recovery | UI upload → text ingestion → exact reference link → new comparison. Old blocked comparison remains persisted. No arbitrary similar document substitution. |
| Review | Actual PATCH with expectedUpdatedAt, trusted server actor and persistent review state. Synthetic flow approved; live regulatory document only moved to inReview, explicitly pending substantive review. |
| Errors | Contract error envelopes remain visible. Browser tested missing publication, missing predecessor and failed unauthorized/cross-origin/private-file requests. Backend tests cover extraction/model/lease failures and stale review conflicts. |

The browser API client still imports `API_CONTRACT` and inferred schemas. There is no second backend and no invented domain route, job kind, field or status.

## Authorization evaluation

**Tested:** direct API reads and writes now require the trusted bearer token; unauthenticated source/publication/detail/obligation/job/comparison operations return 401. The local frontend gateway requires its own Basic operator login, replaces upstream authorization server-side, strips upstream cookies, rejects foreign origins/site contexts and unexpected hosts, and denies `.env`, `.data`, SQLite, `.git`, `.aws`, credentials and private-key paths. Tests and built-asset scans found no configured backend/AWS/operator secrets in browser bundles.

The local gateway and API bind to loopback. This is single-operator local authorization, not tenant/user-level production access control. A configured reviewer maps to the local account; no browser-supplied reviewer header or body field determines identity. Public official-document links lead to the regulator's public site. Private originals have **no download endpoint** and are not exposed through static serving; the UI explicitly says original-file access is unavailable. An authorized publication/version-scoped download API requires coordinated design before adding it.

Read authentication is an intentional coordinated integration behavior change on this branch: all reads and writes are gated and the merged gateway supplies the credential. Existing shared schemas already define 401/403 envelopes; no wire-schema change was needed. Earlier checkpoint examples with anonymous curl reads must now add the server bearer header from a trusted terminal.

## Actual verification results

| Check | Result | Limits |
| --- | --- | --- |
| Backend before merge: `npm run check` | Passed: 188 tests, 47 fixtures, both typechecks | Backend input only |
| Combined `npm run check` | Passed: 197 tests, 47 fixtures, Node/browser typechecks | Unit/integration regression, not four-region completeness |
| `npm run build` | Passed; production assets emitted | No deployment |
| `npm run verify:browser` | Passed in headless installed Google Chrome; real UI/HTTP/gateway/SQLite/worker | Explicitly synthetic source transport and model, never regulatory evidence |
| `npm run verify:live-browser` | Passed with real CBK HTTPS retrieval and actual Bedrock calls | Existing narrow LIBOR configuration only; no real historical pair |
| Production preview Chrome check | Passed: authenticated repository/detail, 25 obligations, persisted inReview, no page errors | Local preview against isolated live database |
| `npm run verify:sources` | Probe completed with blocked/failed rows below | This command reports readiness; exit success is not an assertion of regional completion |

The synthetic browser test exercised: monitoring acceptance → discovery → persisted text/analysis → cited obligations → blocked missing predecessor → TXT upload → predecessor linking → comparison → highlighted old/new clauses → review save → browser reload. It also tested search/filtering, frequency writes, a due scheduler tick and duplicate-free rerun, structured notFound error, direct API/proxy authentication and private-file denial. Its inputs and explanations are labelled SYNTHETIC. Artifact report: `.data/browser-verification-1793431706690/report.json`; screenshot `comparison-review.png`.

Live browser evidence: `.data/live-browser-1793431738059/report.json`, completed `2026-10-31T07:29:30.663Z`. Actual monitoring fetched the [official CBK LIBOR guidance PDF](https://www.centralbank.go.ke/uploads/banking_circulars/1583576875_CBK%20Guidance%20on%20Libor%20Transition.pdf), SHA-256 `73ed07237c791d9f34da9861a56e84a566b9a08d64eb7e1692aa1d952423c87c`, 220804 bytes. Bedrock Haiku 4.5 via the configured Australia profile produced **25 obligations and 25 validated source citations** in this run. Publication `94d3453e-19f9-4637-95ff-09fd27a38889`, version `ba6e6c46-76f6-4d1f-b323-0faf559674c0`. The browser rendered all 25, saved `inReview`, reloaded that persisted state, and reran monitoring with one publication/one version. This differs from the prior 26-obligation run: model-generated analysis is not deterministic and still needs human review. `preview-report.json` records the production-preview check. These records are isolated verification data, not normal `.data/ria` records.

### Four-region discovery and retrieval

Private evidence: `.data/source-readiness-1793431806355/report.json` and content-hashed originals. The source probe uses the same bounded official fetcher and extractor as the application. Sources are listed below with current observations, not promises of production support.

| Region | Actual observation | Level 1 gap |
| --- | --- | --- |
| KSA | [SAMA circular listing](https://rulebook.sama.gov.sa/en/sama-circulars) fetched as HTML (432242 bytes). Two linked, evidenced historical/current original PDFs downloaded below. Both failed text extraction. | No KSA source adapter/configuration or scheduler discovery integration. Needs listing/detail traversal, trustworthy metadata and readable extraction/OCR. |
| UAE | [CBUAE banking rulebook](https://rulebook.centralbank.ae/en/rulebook/banking) returned HTTP 403 from the application fetcher. | Listing and document retrieval blocked; no adapter. An approved accessible official feed/source or access approach must be agreed. No protection was bypassed. |
| India | [RBI notifications listing](https://rbi.org.in/Scripts/NotificationUser.aspx) fetched HTML with actual PDF links. Following its first rbidocs PDF link returned 45725 bytes of `text/html`, not a PDF (`pdfSignature=false`); extraction failed. | No India adapter; document retrieval must handle/reject the upstream HTML/challenge response explicitly, not claim PDF ingestion. |
| Kenya (selected African country) | Existing CBK adapter ran **without title filter**, discovered and downloaded three different listed circulars: No. 1/2026, No. 1/2024, No. 2/2025. All three failed text extraction. | General bounded listing parsing/retrieval is evidenced, but recent-document analysis needs readable text/OCR. The normal seed remains the narrow LIBOR checkpoint and is not general coverage. Completeness/pagination and historical backfill are not established. |

The three Kenyan original hashes are `2e0a19a4523c0b8cb7c259f283bb8233062b30509e82d39cc540677be7ae044f`, `a25d06cdde1ebb6902d2ac057d2270e2a760a6d589a6f22758bda1eaa7afb9ed`, `25b4fa438eb538c4a7e9b37b293086793c0592832acd82acd425d349c07591c5`. RBI's non-PDF response hash is `d8f9b78a1e5f008a0481baae533a4798577f652efa896966820089ac82edaf63`. The application never treats these extraction failures as successful empty results.

### Real historical/current pair

Found an explicit official relationship: [SAMA circular 472038084, 23 December 2025](https://rulebook.sama.gov.sa/en/mechanism-assigning-debt-collection-operations-banks-and-finance-companies-finance-debt-collection) supersedes named earlier circulars including [45077226, 2 July 2024](https://rulebook.sama.gov.sa/en/assignment-debt-collection-operations-banks-and-finance-companies-debt-collection-entities-licensed). Both official pages identify the supersession; this is not a similarity-based guess.

- Earlier original: [SAMA_EN_10045_VER1.pdf](https://rulebook.sama.gov.sa/sites/default/files/en_net_file_store/SAMA_EN_10045_VER1.pdf), 2076899 bytes, SHA-256 `9b994d3113ec8e3e04328d1c04d4de7f7cbedd23f45e44f29cc0096f76bd0d6f`.
- Current original: [SAMA_EN_10866_VER1.pdf](https://rulebook.sama.gov.sa/sites/default/files/en_net_file_store/SAMA_EN_10866_VER1.pdf), 78215 bytes, SHA-256 `a9788b063af35509bbfca9feb475d5f34760bd495d3fee991e7e7f82b9f9fdf0`.

**Blocked:** both fail the current PDF extractor with no usable text. A supported OCR path or a coordinated, provenance-preserving HTML-document ingestion contract is needed. We did not replace original PDF evidence with an invented/transcribed clause, relabel HTML as TXT, or classify this pair with synthetic findings. The previously successful live-model comparison remains clearly labelled synthetic; there is still no verified real historical comparison with persisted valid clause citations.

## Contract coordination and prioritized blockers

1. **P0 — regional ingestion/readable evidence.** Implement and verify KSA/UAE/India adapters and broaden Kenya's normal configuration only after retrieval/extraction works. Sethu's commit contains UI work, not competing adapters; Gokul retains backend adapter ownership. Agree source ownership and accessible official sources together. UAE 403, RBI non-PDF responses and scanned PDFs are concrete blockers.
2. **P0 — real pair verification.** Obtain reliable, located source text for the evidenced SAMA pair (or another official pair), validate the explicit relationship, run extraction/comparison and inspect citations through the UI. Current synthetic passing comparisons do not satisfy this requirement.
3. **P1 — deployable authorization and document access.** Local single-operator gates are tested. Multiuser identity, authorization scopes/roles, reviewer identity per session, TLS, session lifecycle, audited private-original access and production hosting remain unimplemented/untested. Do not expose the Vite preview on a shared network.
4. **P1 — job discovery/retry.** Existing `JobStatus` has no public structured-analysis job ID/stage/progress field on publications or monitor results, and no analysis retry endpoint. The UI polls the existing detail/obligations endpoints and handles 409 honestly; explicit analysis retry is a trusted CLI operation. Agree a version-targeted analysis operation and discoverable job reference before adding public fields.
5. **P1 — insufficient evidence.** Contract `blocked` comparison supports missing/ambiguous predecessors, not known-predecessor insufficient-clause evidence. The backend currently returns failed/comparisonFailed. Agree an insufficientEvidence issue/state and matching fixtures before changing both clients. Never use noMaterialChange as fallback.
6. **P2 — additional contract/UI scope.** Typed document/requirement status, source run history, manual-only regulator catalog and authorized original downloads need coordinated schemas. Proposed consultation labels and current independent processing/relationship/review states remain intact.

Untested: cross-browser/mobile interaction, long-running scheduler reliability, deployed/multiuser authorization, complete regional pagination/backfill and real historical comparison. UI TXT upload/recovery is browser-tested; PDF monitoring and backend PDF/DOCX upload/extraction regressions passed, but every upload format has not separately been exercised through the browser. Failed source/readiness probes are reported above rather than hidden by passing tests.

## Sethu handoff

> The combined work is local on codex/level1-integration; it has not been pushed. Inputs are backend 36075123cc23a3699e3ac8f5cea5186ec35c7936 and your frontend 47479f0fe7b09e5e69448562ca2fa900f07ee7cc. Keep importing src/shared/contracts/index.ts and API_CONTRACT; their fields/statuses/routes are unchanged. Read docs/LEVEL1_INTEGRATION.md before further changes. The browser now uses a local operator login and the server-only proxy supplies the backend bearer token. Never add that token or reviewer IDs to browser requests. Structured readiness uses the existing obligations endpoint, and comparison highlights use src/shared/presentation/diff.ts. Coordinate any new analysis-job, insufficient-evidence or download schema with Gokul. Passing UI/regression tests does not close the listed regional/real-pair gaps.
