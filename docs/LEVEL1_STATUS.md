# Level 1 verification status — 31 October 2026

The integrated application now demonstrates the Level 1 journey with official publications from four regions, structured Bedrock extraction, a real historical RBI comparison, search, uploads, scheduling and human review. This is a **bounded demo scope**, not a claim that every item on each regulator's site is monitored or that model findings are legally approved.

## Official monitoring coverage

`npm run backend:seed` adds the following sources to the existing SQLite database without replacing prior source records. The source adapter parses an official listing, selects bounded verified links and runs through the existing worker, storage, extraction and deduplication pipeline. Monitored HTML is preserved privately and displayed only as extracted text. Manual upload remains PDF/DOCX/text.

The Ghana directives and Kenya current-listing sources are **disabled by default** because their known documents hit the analysis limit or lack a readable text layer. The isolated verification script enables them only inside its own temporary database to prove discovery, retrieval and honest failure. SAMA, DFSA, current RBI and Ghana notices are enabled for the four-region demo.

| Region | Source and actual listing | Isolated live result | Scope limit |
| --- | --- | --- | --- |
| Saudi Arabia | [SAMA circulars](https://rulebook.sama.gov.sa/en/sama-circulars) | 2 listed circulars, 2 HTML originals, 2 extracted versions; repeat run: 2 known, 0 new | First 2 listed circulars; linked annexes are not silently analyzed |
| UAE | [DFSA news](https://www.dfsa.ae/news) | 1 official amendment notice, 1 HTML original/extracted version; repeat: 1 known, 0 new | Notice body only, not the complete linked Rulebook amendment. CBUAE endpoints remained inaccessible (HTTP 403) |
| India | [RBI notifications](https://www.rbi.org.in/Scripts/NotificationUser.aspx) | 2 current listing notifications, 2 HTML originals/extracted versions; repeat: 2 known, 0 new | First 2 listed notifications; selected historical RBI pair is a separate source |
| Ghana | [Bank of Ghana notices](https://www.bog.gov.gh/notice/) | 1 current regulatory notice, linked official PDF extracted; repeat: 1 known, 0 new | First matching notice on the listing page; procurement entries are excluded |
| Ghana, additional | [Regulations and directives](https://www.bog.gov.gh/downloads/supervision-and-regulation-downloads/regulations-directives/) | 1 exposure draft PDF fetched and extracted (37 pages, 75,390 characters); repeat duplicate-free | Structured analysis produced 239 candidate obligations, above the existing 200-obligation schema limit. It failed explicitly; no partial result was published |
| Kenya, additional | [CBK circulars](https://www.centralbank.go.ke/policy-procedures/legislation-and-guidelines/circulars/) | 3 current PDF publications fetched; repeat: 3 known, 0 new | All 3 PDFs are image-only and fail extraction explicitly. The separate readable historical LIBOR checkpoint succeeds but is not general discovery |

The isolated final monitor report is `.data/level1-four-region-kK9YbO/report.json` (ignored, private). The second run created **no additional publication/version** in every row. Source monitor success means discovery and persistence succeeded; individual ingestion/extraction jobs have their own state. A Kenyan image-only failure never becomes an empty successful obligation result.

## Structured understanding and comparison

- Live Bedrock on the earlier isolated four-region run (`.data/level1-four-region-VQTKb9/analysis-report.json`) produced **3 SAMA, 4 DFSA, 4 RBI and 25 historical CBK** cited obligations on one stored version per source. Every accepted citation was checked against its exact persisted document version, locator, page when present and excerpt. The final Ghana notice produced **2** cited obligations and 2 references (`.data/level1-four-region-kK9YbO/analysis-report.json`). These are proposed model findings awaiting review.
- The Ghana 37-page exposure draft is correctly marked `consultation`; its later full extraction exceeded the shared 200-obligation response cap and failed without publishing a partial result. The worker now reports this exact limit instead of a generic retry error. A shorter official Ghana notice demonstrates the complete analysis path. Raising the shared limit or adding reviewed clause selection is a coordinated follow-up.
- The already verified [2022 RBI Digital Lending Guidelines](https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12382&Mode=0) and [2024 RBI Key Facts Statement circular](https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12663&Mode=0) remain the real historical comparison. The saved analysis contains 3 supported **proposed** changes for the explicitly referenced paragraphs 5.1, 5.2 and 8. The older circular carries later repeal/withdrawal notices and is not presented as currently in force. The comparison and `inReview` state were checked through Chrome and survived reload; details are in `docs/REAL_SOURCE_REPAIR.md`. No new model comparison was required to verify the additional source adapters.
- All six change classes and both deadline directions have labelled synthetic contract and analysis tests. This proves implementation support, not six real regulatory findings.

## Application capabilities and boundaries

The existing frontend shows sources and frequency controls, a searchable publication repository, country/regulator/date/business-area/change filters, publication metadata, cited obligations, unresolved predecessor handling, side-by-side comparison and review. The existing local gateway authenticates the operator and keeps the backend write token and reviewer identity server-side. Prior browser regression also covered PDF/DOCX/text uploads, scheduler activation, duplicate-free rerun, failures and review persistence. The new four-region browser proof displayed the newly ingested records and the Ghana notice's 2 cited obligations (`.data/level1-four-region-kK9YbO/browser-report.json`).

The source adapters deliberately select a bounded first page or first matching items. Full pagination, linked annex ingestion, every current Kenyan image-only PDF, broad CBUAE access and exhaustive legal comparison are **not** demonstrated. The dashboard can surface these failures; it cannot certify legal applicability. An evidence gap stays unresolved or failed, never `noMaterialChange`.

## Reproduce safely

Run `npm run check` and `npm run build` without live network/model calls. `npm run verify:four-region` creates an ignored isolated database, fetches official pages and repeats each monitor. Its output prints a report directory. `npm run verify:regional-analysis -- <report-directory> 'Ghana notices'` invokes live Bedrock for that one extracted document and can incur model charges. `npm run verify:four-region-browser -- <report-directory>` checks the existing UI with local loopback servers and Chrome. The last two commands require only the existing ignored operator/AWS environment; never put token or AWS credentials in browser code.

The normal application database was not changed by these verification scripts. To make the new sources visible in an operator database, run `npm run backend:seed` against that intended `RIA_DATA_DIR`, then start the backend and worker as documented in `docs/BACKEND_INGESTION.md`. Source IDs and API field names remain in the shared contracts; no endpoint or shared schema changed in this source expansion.

Final local checks: `npm run check` passed both type checks, 48 contract fixtures and **218 tests**; `npm run build` passed; `npm run verify:browser` passed its six synthetic UI/API checks; the final official-source browser check passed. None of these commands pushed, merged, deployed or changed the normal application database.
