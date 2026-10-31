# Sethu Level 1 frontend handoff

Branch: `feature/sethu` (pulled `origin/main`; already up to date). Changes are local and uncommitted. No push or deployment was performed. Shared contracts and fixtures are unchanged; no contract changes require coordination. The only added dependency is Vite (development build/preview tooling), with its lockfile. No prior screens existed in this checkout.

## Implemented screens

- Repository: search; country, regulator, date bounds, business area and classification filters; independent processing/review/relationship filters; bounded pagination; honest unknown dates and consultation labels.
- Sources: all configured sources, official URLs, enable/frequency edits, run one/all enabled sources, per-source discovery/new/known counts and errors. Ingestion is tracked separately from discovery. Sources are fully paginated when loading the catalog.
- Upload: PDF/DOCX/TXT, 20 MiB validation from shared schema, extension fallback only for absent MIME, real transfer progress, validated user metadata and accepted-job polling. No fake completion.
- Detail: source links, immutable version identifiers, obligations, affected entities/departments/activities, independent dates, inspectable clause/page excerpts, reference resolution and ambiguous candidates.
- Comparison: current/previous document and version IDs; before/after excerpts with escaped word highlighting; plain-English explanations; all six shared classifications and both deadline directions. Processing, blocked, failed, and explicit no-material-change outcomes remain distinct. Automatic comparisons poll jobs; an active comparison opened from detail refreshes until terminal.
- Recovery: upload predecessor → successful ingestion → link original reference/current version to accepted predecessor IDs → track new comparison. Stored predecessor IDs can also be linked without an upload. Failed ingestion never links a predecessor. Recovery is held in memory for the active session.
- Review: all four contract states, nullable notes/rejection validation, optimistic concurrency using the review timestamp. A 409 reloads current detail for reconciliation, without replaying the approval.

## Live integration

`src/client/api.ts` uses `API_CONTRACT` methods/paths, inferred types, request schemas, validated response schemas, error envelopes and multipart field names. Same-origin credentials are used. Network payloads enter as unknown. No private credentials, worker, scraper, database client or alternate API is present.

Operations wired: listSources, updateSource, triggerMonitor, readJob, readMonitorResult, searchPublications, readPublication, uploadDocument, requestComparison, readComparison, linkPredecessor, updateReview. Obligations come from the validated detail response; no duplicate obligations fetch is needed. Polling stops on succeeded/blocked/failed, honors 429 Retry-After seconds and is cancelled on data-mode changes. Refreshing a pending publication or comparison also refreshes its detail.

Run `npm ci`, `npm run check`, `npm run build`, then `npm run dev`. Default backend target is `http://127.0.0.1:3000`; configure `RIA_API_ORIGIN` before starting Vite if needed. Keep `/api/v1` same-origin in production hosting.

## Verification steps

1. In synthetic mode, open the repository, change each scenario, and confirm its independent state badges. Search a nonmatching title and filter another country to see an empty result. Clear filters.
2. Open the completed fixture and inspect obligation excerpts, version identifiers and side-by-side deadline evidence. Expand the six separate classification examples; they are not attributed to the publication.
3. Open missing/ambiguous scenarios. Verify the unresolved relationship message and upload-recovery action. Open failed/queued scenarios; no successful obligations result should appear.
4. Open Sources and inspect four synthetic regional sources. Preview successful, partial and failed run outcomes; these are clearly labelled static fixtures. Mutations remain disabled.
5. With Gokul's backend running, select Live API. Configure a source and refresh; confirm persistence. Run monitoring and confirm acceptance appears before completion, source outcomes are independent and ingestion jobs appear separately.
6. Upload each supported format, test an empty/oversize/unsupported file, and inspect returned ingestion job and publication. Confirm transfer completion does not imply extraction success.
7. Recover a missing predecessor by upload or stored IDs. Confirm a new comparison ID is allocated and old blocked results remain unchanged.
8. Save a review, then test stale review timestamps from two tabs. Confirm a conflict reloads current detail without auto-approving it.

## Gokul coordination / remaining backend work

All HTTP endpoints remain planned in this checkout. Live extraction, monitoring, persistence and reviewer authentication cannot be verified until they are implemented. Four `example.org` fixture sources are not official production configurations. Configure actual KSA/UAE/India/Africa sources server-side.

The existing contract does not expose these requested features; the frontend does not invent replacements:

- Original private-file access: agree an authorized download operation returning a short-lived access URL (or streamed bytes), keyed by publication/version and authorized server-side. Current public source URLs remain usable.
- Source history: SourceConfig has last attempt and next schedule, but no last-success/error/history resource. UI reports last success/current outcome only from monitoring runs observed in this session. Agree a source-history read if persistent history is needed.
- Job stages: JobStatus has state/times/result/error but no current stage/progress fields. UI shows the exact state and real upload transfer progress only.
- Ingestion retry: no retry operation exists. UI offers a new readable upload after failed extraction. Comparison reruns are supported.
- Upload regulator catalog: current UI derives regulator/country from configured sources. Independent manual-only regulators need an agreed catalog operation; no hardcoded production regulator IDs are introduced.
- Runtime frontend bundling is Vite with TypeScript, since no Next.js application existed. Integrating these screens into Gokul's eventual Next.js host needs an agreed mount/build adapter; shared payloads and API paths require no changes.

## Validation

`npm ci` passed. `npm run check` passed: strict Node/browser typechecks, 47 synthetic fixture validations and 146 tests (including six frontend transport/view tests). Frontend modules are included in the strict browser typecheck without Node ambient types. Added tests cover exact requests, repeated filters, malformed payload rejection, structured errors/retry delay, unavailable backend HTML, source-date precision and safe evidence highlighting. `npm run build` produces the production assets using Vite. No HTTP/worker/database end-to-end success is claimed.

Visual/interactive browser QA remains unverified: the in-app browser timed out connecting to localhost, and Windows computer-use ended because it could not confidently determine the current browser URL. UI automation was stopped. The Vite server starts successfully, but that alone does not verify rendered layout or browser interactions. Use the manual verification steps above before the demo.
