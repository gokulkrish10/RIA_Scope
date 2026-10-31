# Real-source repair checkpoint

Local branch: `codex/real-source-repair`, created from clean integration commit `8d1cf66448680df9afaafe870feaab2f0fdeb175`. Existing SQLite tables, migrations, frontend screens, API paths and authentication are preserved. No database migration, push, main/dev merge or deployment is part of this repair.

## Ownership and coordinated contract extension

`origin/feature/sethu` was checked again: `47479f0fe7b09e5e69448562ca2fa900f07ee7cc`, unchanged, with frontend work and no competing backend/source adapters. Sethu owns screens; Gokul owns the existing backend adapter boundary. The RBI adapter plugs into that boundary. This is repository-based coordination, not a claim that a message was sent to Sethu.

The user explicitly approved adding `text/html` to monitored document responses. Contract **1.1.0** adds that value to `DocumentMediaTypeSchema`; `UploadFileDescriptorSchema` still excludes HTML. Browser imports use the same schemas and now display the stored media type. A synthetic HTML version fixture exercises the addition. No field, endpoint or status was renamed. Sethu must update shared contracts and frontend together; older strict clients that only know three media types cannot consume these HTML responses.

## Diagnosis before parser changes

Fresh bounded retrieval and PDF.js inspection on 2026-10-31 established the following. All listed PDF final URLs equal their requested URLs, returned HTTP 200 and declared `application/pdf`. Each parsed successfully, with zero text items and image paint operators. This is an image-only/no-text-layer condition, not HTML saved as PDF, malformed bytes, or a PDF.js loading error. No OCR was assumed or added.

| Official file | Bytes | Signature | Pages | Image operations per page | Outcome |
| --- | ---: | --- | ---: | --- | --- |
| [Kenya Circular 1/2026](https://www.centralbank.go.ke/uploads/banking_circulars/1614513480_Banking%20Circular%20No.%201%20of%202026%20-%20Changes%20to%20CBK%20Discount%20(Overnight)%20Window%20Facility.pdf) | 69,595 | `%PDF-1.4` | 1 | 5 | Explicit extraction failure: images, no text layer |
| [Kenya Circular 1/2024](https://www.centralbank.go.ke/uploads/banking_circulars/538716971_Banking%20Circular%20No.%201%20of%202024%20-%20Changes%20to%20the%20CBK%20Discount%20(Overnight)%20window%20facility.pdf) | 61,569 | `%PDF-1.5` | 1 | 3 | Same condition |
| [Kenya Circular 2/2025](https://www.centralbank.go.ke/uploads/banking_circulars/1591700962_Banking%20Circular%20No.%202%20of%202025%20-%20Changes%20to%20the%20CBK%20Discount%20(Overnight)%20Window%20Facility.pdf) | 57,426 | `%PDF-1.4` | 1 | 5 | Same condition |
| [SAMA 45077226](https://rulebook.sama.gov.sa/sites/default/files/en_net_file_store/SAMA_EN_10045_VER1.pdf) | 2,076,899 | `%PDF-1.7` | 1 | 2 | Same condition |
| [SAMA 472038084](https://rulebook.sama.gov.sa/sites/default/files/en_net_file_store/SAMA_EN_10866_VER1.pdf) | 78,215 | `%PDF-1.4` | 2 | 2, 2 | Same condition |

The [previous RBI listing-linked PDF URL](https://rbidocs.rbi.org.in/rdocs/notification/PDFs/NT30314AC275308034E98A5E239A91CEAA5A7.PDF) instead returned HTTP 200, `text/html`, 43,173 bytes, an HTML signature and a human-verification/CAPTCHA page. The file extension is not evidence of PDF content. The [UAE banking page](https://rulebook.centralbank.ae/en/rulebook/banking) returned HTTP 403, `text/html`, 118 bytes. Neither response is passed to Bedrock; no challenge or access control was bypassed.

Private reproducible diagnostics: `.data/download-diagnostics-1793432760530/report.json` and its immutable originals. Each row records requested/final URL, HTTP status, declared type, byte count, signature, original hash and extraction error; PDFs also record per-page text/image counts. Network errors before a response cannot supply an HTTP status. Reports contain no authentication headers, cookies, credentials or response-body excerpts. Unknown query parameter values are redacted in persisted job diagnostics. Updated extraction errors distinguish image-only PDFs, protected PDFs, invalid/over-limit documents, blocked HTML and unverified landing pages.

## Routing and provenance

- Route by bytes, not URL suffix. Valid PDF bytes still use the isolated PDF parser; DOCX ZIP/XML and UTF-8 text retain existing handling.
- HTML is accepted only through a verified source-specific extractor. The current implemented body selector is RBI `#NotificationUser #doublescroll`; it requires a document title and reference number. It excludes navigation, scripts, controls and footers, retains clauses, table rows, footnotes, explicit repeal notices and status watermark asset URLs. An asset observation is labelled as such; its filename is never interpreted as an effective date.
- A landing page may supply one explicitly advertised, allowlisted official PDF link. Zero or multiple candidates are rejected rather than guessed. Login, CAPTCHA and access-denied content fail closed. Other regulators' HTML body selectors remain unimplemented.
- Raw fetched HTML is preserved under its SHA-256 private storage key. Regulatory text, reference links and status markers produce a separate internal deduplication hash; session fields/navigation changes do not create versions. Changed regulatory content does create a version. All fetch originals remain preserved, including duplicate fetches; public responses contain neither storage paths nor hashes.
- HTML citation locators identify the persisted body block/numbered clause/anchor and segment. Evidence is validated as an exact substring of that stored extracted text with matching document/version IDs. Parsed text is never arbitrary cleaned model output. Linked annexes are not silently fetched or invented; their absence limits the analysis scope.

## Real RBI historical pair

| Role in this comparison | Official source | Reference | Document date | Extracted characters |
| --- | --- | --- | --- | ---: |
| Previous | [Guidelines on Digital Lending](https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12382&Mode=0) | DOR.CRE.REC.66/21.07.001/2022-23 | 2022-09-02 | 17,749 |
| Selected successor | [Key Facts Statement for Loans & Advances](https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12663&Mode=0) | DOR.STR.REC.13/13.03.00/2024-25 | 2024-04-15 | 7,291 |

Both returned HTTP 200 regulatory HTML at the supplied URLs. Fresh diagnostic originals were 135,124 and 120,887 bytes; web session fields make raw response size/hash vary. The earlier page explicitly says it has been repealed and points to 2025 directions. Both pages also have a withdrawal watermark asset. Neither document is presented as currently in force.

The 2024 repeal table explicitly identifies the older circular and paragraphs 5.1/5.2. Its footnote separately modifies paragraph 8. The browser selects the stored predecessor using that extracted reference; exact reference-number/authority/version ownership and citation validation still apply. Other missing earlier regulations remain unresolved. A successful comparison of this selected pair does not imply all historical relationships are resolved.

The first live model result passed structural/citation checks but semantic inspection found an unsupported deadline extension between different transition/commencement obligations, plus an existing fees rule labelled new. It was rejected for review, retained in private `report-initial-semantic-review-needed.json`, and not treated as verified regulatory evidence. General guards now require explicit extension/shortening/replacement language in the current deadline citation and reject pairing post-contract cooling-off with pre-contract offer validity. Instructions require matching the same obligation and checking existing predecessor requirements before calling anything new. This guard is intentionally conservative and is not a substitute for human semantic review. Model/pipeline identity advanced to `analysis-v4` so the earlier result is not silently reused. Comparison caching also includes the comparison-instruction and clause-selection revision, independently of source versions. A bounded correction attempt receives the rejected model response plus validation feedback; a failure never becomes an empty success.

Broad comparisons also exposed unsupported inference about missing annexes and produced an explicit insufficient-evidence failure. The final pipeline selects numbered clauses only from the resolved reference number or an explicit title-plus-amendment statement in the current stored text. For this pair it automatically identifies paragraphs 5.1, 5.2 and 8, includes the repeal-table introduction and amendment footnote, and supplies their exact persisted predecessor clauses. Neither expected classifications nor explanations are hardcoded. Missing named clauses and unsupported clause ranges fail explicitly. This is a limited partial-amendment comparison, not an exhaustive comparison of all incorporated materials. Earlier trial databases/reports remain privately archived under `.data/rbi-history-repair-before-locator-fix`; the final fresh run corrects table-row locators without rewriting old citations.

## Run and inspect

```sh
npm run check
npm run build
npm run verify:download-diagnostics
npm run verify:browser       # clearly synthetic source/model; real UI/API/SQLite
npm run verify:rbi-history   # live official sources + live Bedrock + Chrome
```

Live verification uses the existing ignored environment configuration, including temporary AWS credentials, region/model, trusted backend token, local operator credentials and reviewer UUID. No browser receives the backend token. The real verification resumes the final `.data/rbi-history-repair` database; after correcting credentials/model errors use `npm run verify:rbi-history -- --retry-analysis`. Originals, SQLite, reports and screenshots stay ignored. The script closes its servers/browser when finished.

For interactive inspection of this verification database, set `RIA_DATA_DIR=.data/rbi-history-repair` in the trusted shell for **both** backend and worker, then run the existing backend/start, backend/worker and frontend/dev commands. Keep the configured local gateway authentication. The two seeded RBI URLs are expressly labelled “selected historical notifications (not general discovery).” Manual uploads retain `ingestionMethod: upload` and are never counted as monitoring success.

Browser API flow stays unchanged: `POST /api/v1/monitor-runs`, poll `GET /api/v1/jobs/:jobId`, read publications and obligations, `POST /api/v1/publications/:id/predecessor` with the stored reference/current/predecessor IDs, poll its job, read `GET /api/v1/comparisons/:id`, then `PATCH /api/v1/publications/:id/review` with `state: inReview`, a historical-review note and `expectedUpdatedAt`. Reviewer identity comes exclusively from the server environment. Automatic structured-analysis job discovery and a dedicated insufficient-evidence state remain contract gaps; existing honest errors/unresolved states remain in use.

## Coverage and remaining work

Coverage is reported by stage, not inferred from successful unit tests. Selected documents are not broad monitoring coverage. The earlier LIBOR result and synthetic comparison stay separately labelled in `LEVEL1_INTEGRATION.md`.

| Region | Listing discovery | Document retrieval | Text extraction | Analysis |
| --- | --- | --- | --- | --- |
| KSA | Listing HTML fetched in integration probe; no general listing adapter | Two official SAMA PDFs fetched | Both image-only PDFs fail explicitly; SAMA HTML-body extraction remains a gap | Not completed for those documents |
| UAE | Blocked: official endpoint HTTP 403 | Not established | Not established | Not completed |
| India | Separate unfiltered listing probe discovered IDs 13749 and 13748 from actual official links; originals and diagnostics are preserved in `.data/repair-diagnostics/rbi-listing.json`. The selected historical pair alone is **not** listing-discovery evidence | Both historical HTML documents and the two independently discovered current notifications fetched; earlier PDF endpoint serves CAPTCHA | Both historical bodies extracted and persisted with locators; current listing candidates recognized by the same body extractor | Live analysis/comparison results recorded separately below |
| Kenya | Existing adapter discovered three unfiltered circular links | All three PDFs fetched | All three image-only files fail explicitly; earlier official LIBOR guidance successfully extracted | Earlier live LIBOR analysis verified; no analysis of these three image-only documents |

Remaining priorities: substantive review of the real historical comparison; additional explicitly referenced predecessors/linked annexes; verified accessible text or separately scoped OCR for the image-only files; SAMA-specific body/listing adapter; permitted UAE access; sustained listing discovery and region-specific regression coverage. No production authorization or four-region completion claim is made.

## Verification outcome

- `npm run check`: both TypeScript configurations passed; 48 synthetic contract fixtures validated; 209 tests passed, zero failed/skipped. New cases cover the observed image-only PDF failure mode, challenge HTML masquerading as PDF, body/locator extraction, unknown dates, monitored HTML versus upload types, private diagnostics, deduplication/changed-content versioning, unsupported deadline inference, mismatched period duties, explicit clause scope and comparison-cache revision.
- `npm run build`: production Vite build passed, 111 modules, JavaScript bundle 147.64 kB.
- `npm run verify:browser`: all six synthetic UI/API/SQLite regression checks passed on the final code. Includes direct/proxy authentication and private-file denial, monitoring, missing-predecessor upload/link, diff rendering, review persistence, search/filter, frequency/scheduler, duplicate-free rerun and error states. These synthetic sources/model are never presented as live regulatory evidence. Artifacts: `.data/browser-verification-1793433408470`.
- `npm run verify:download-diagnostics`: nine official responses examined; individual failures remain failures as detailed above.
- `npm run verify:rbi-history`: **passed**, completed `2026-10-31T07:57:30.636Z`, live `bedrock:ap-southeast-2:au.anthropic.claude-haiku-4-5-20251001-v1:0:analysis-v4`. Both structured extraction jobs and the comparison job succeeded on their first attempts in the final fresh run. The 2022 document yielded **44** obligations and the 2024 document **8**; every obligation/change citation was checked against its exact persisted version and locator. The limited comparison produced **3 proposed items**: withdrawal/supersession of paragraphs 5.1 and 5.2, and modification of paragraph 8 supported by footnote 1. No unrelated deadline extension or offer-validity/cooling-off pairing was accepted.
- Real Chrome rendered both documents, obligations/citations and supported old/new clauses. Review saved as `inReview` and survived reload. A second actual monitor run retained exactly **2 publications / 2 versions** and the review; an identical comparison request reused its stored comparison ID. Originals and later-status markers are preserved. The displayed comparison panel was visually inspected.
- Final private artifacts: `.data/rbi-history-repair/report.json`, `comparison-panel.png`, `historical-comparison-review.png`, `previous-obligations.png`, `current-obligations.png`, private SQLite and originals. Earlier model failures, broad-scope candidates and the explicit insufficient-evidence result remain archived under `.data/rbi-history-repair-before-locator-fix`. Model outputs can vary; the counts above refer to this named final run, not all trial runs.

### Exact local records and requests for Sethu

The following IDs belong to the final verification database. Use the existing authenticated frontend proxy/client and shared schemas; do not put the bearer token or reviewer ID into browser code.

```text
GET /api/v1/publications/3ca2dc23-a70f-4725-abb2-d019c3cbf915
GET /api/v1/publications/1d94a2af-7aeb-447a-906a-cf86ca79f35d/obligations
GET /api/v1/jobs/19f2458e-76e2-4806-b720-017fe19e28d9
GET /api/v1/comparisons/5dda2072-ce8b-4dbf-b152-2939f5c6e5ee
```

Link/rerun through the existing operation:

```http
POST /api/v1/publications/1d94a2af-7aeb-447a-906a-cf86ca79f35d/predecessor
Content-Type: application/json

{
  "referenceId": "491530d5-aa5e-4093-8f78-53a87251fa66",
  "currentVersionId": "32311e01-3303-48b9-85cb-f178e93a9864",
  "predecessorPublicationId": "3ca2dc23-a70f-4725-abb2-d019c3cbf915",
  "predecessorVersionId": "33818d5c-3026-4de1-9b5c-a51251d3b702"
}
```

The response is HTTP 202 with `jobId`, `comparisonId`, `publicationId` and `state: queued`; poll the returned job even when a successful result is reused. Review uses the detail response's current `review.updatedAt` as `expectedUpdatedAt`, `state: inReview` and a historical-review note. Other predecessor references remain unresolved; this verification does not approve the publication or establish current applicability.

Handoff: “Use shared contracts 1.1.0 from this local repair branch. Monitored versions may be `text/html`; uploads remain PDF/DOCX/text. Preserve the existing proxy and server-owned reviewer identity. Use the final RBI database/IDs above to inspect cited historical analysis; comparison scope is only the explicitly referenced clauses. Do not invent endpoints, statuses or current-applicability claims.”

The main application database and the original integration commit remain untouched. Verification servers shut down after each run. No secrets/private artifacts are staged. The backend read/write bearer token, local operator gateway and trusted environment reviewer identity remain in place.
