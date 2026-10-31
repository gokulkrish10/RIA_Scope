# Local Level 1 presentation

Use local `dev` and **one terminal, one command**:

```sh
cd /Users/sst/Downloads/GokulHackathons/Azentio_Onsite/RIA
npm run demo
```

Open **http://127.0.0.1:5173/#repository**. Sign in using the values of `RIA_FRONTEND_USER` and `RIA_FRONTEND_PASSWORD` in your ignored `.env`. Keep that terminal open. **Ctrl+C stops the frontend, backend and worker together.** Do not also run `backend:start`, `backend:worker` or `npm run dev`.

The launcher uses `.data/level1-demo/ria.sqlite` and its private `originals` directory for every component. It ignores stale `RIA_DATA_DIR`, `PORT` and `RIA_API_ORIGIN` exports. Restarting preserves uploads and reviews. A port conflict produces an explicit error instead of silently switching ports. Stop the older RIA terminal before restarting; the launcher never kills unrelated processes.

Prerequisites: installed npm dependencies, Python 3 for first-time evidence preparation, and server-only `RIA_WRITE_TOKEN`, `RIA_FRONTEND_USER`, `RIA_FRONTEND_PASSWORD`, `RIA_REVIEWER_ID`. Existing authentication and configured reviewer identity remain enforced. Never put these values in browser code or chat.

## What this demo contains

Seven previously verified official publications, six sources, five countries across the four required regions, 90 cited obligations and one saved RBI comparison with three proposed changes. These are stored results of earlier real Bedrock runs, not a fresh model call during presentation. The banner says **SAVED-EVIDENCE DEMO**. Data mode **Live API** means the UI reads the real local backend; it does not imply a model is currently running.

| Publication | Saved obligations | Scope |
| --- | ---: | --- |
| RBI Guidelines on Digital Lending (2022) | 44 | Historical; preserve later repeal notices |
| RBI Key Facts Statement (KFS) for Loans & Advances (2024) | 8 | Historical comparison awaiting substantive review |
| SAMA Integration with the Security Council Resolutions Notification System | 3 | Official circular body |
| DFSA Notice of Amendments to Legislation: October 2026 | 4 | Notice body, not all linked rulebook amendments |
| RBI ISIL/Al-Qaida sanctions-list update | 4 | Current-listing verification snapshot |
| CBK historical LIBOR circular | 25 | Readable selected historical document, not general listing discovery |
| Bank of Ghana Unlicensed Digital Credit Services Providers notice | 2 | Official notice PDF |

The preparation script copies only selected completed records and their hash-verified originals from `.data/rbi-history-repair`, `.data/level1-four-region-VQTKb9` and `.data/level1-four-region-kK9YbO`. It preserves IDs, evidence, dates, human review states and unresolved references. It excludes failed/test uploads and pending jobs from the new copy. It refuses to overwrite an existing output. Original verification databases are untouched. These private evidence folders are ignored by Git; a fresh clone needs the saved evidence copied separately or its own ingestion run. The script fails clearly if the evidence is absent; it never invents regulatory results.

Older `level1-presentation` and `level1-presentation-v1` copies are retained under `.data/archive/demo-cleanup-20261031/`. They are no longer the active demo. Other verification data and manual test data remain preserved.

## Five-minute presentation

1. **Publication repository:** show the seven official records. Filter **Country = IN**, search `Key Facts`, then **Apply filters**. Open **Key Facts Statement (KFS) for Loans & Advances**.
2. **Publication overview:** show reference `DOR.STR.REC.13/13.03.00/2024-25`, publication date `2024-04-15`, and **Document versions & identifiers**. The preserved original is monitored HTML; the app displays escaped excerpts, never downloaded HTML scripts.
3. **Structured obligations:** show the eight requirements. Expand **Supporting source evidence** and explain that each quote identifies its exact document version and clause.
4. **Historical comparison:** show the saved three old/new clause pairs and highlights. Two proposed items concern withdrawn/superseded paragraphs 5.1 and 5.2; one concerns modified paragraph 8. Say: **“Historical analysis pending human review, not current-law certification.”**
5. **Human review:** keep **In Review**, enter `Presentation: citation display checked; substantive review pending.`, click **Save review**, then refresh. The note remains; reviewer identity comes from server configuration.
6. If time permits, clear filters and show one SAMA, DFSA and Ghana record. Return to the RBI comparison for questions.

Direct RBI page: `http://127.0.0.1:5173/#publication/1d94a2af-7aeb-447a-906a-cf86ca79f35d`.

**Missing Predecessor** can remain on the RBI document: its 2022 predecessor is resolved, while other references are not. The saved comparison covers the supported pair only. This is an honest evidence gap, not a broken upload. Do not change that state to make the presentation look complete.

## Upload demonstration

Generate safe files once with `node --import tsx scripts/create-manual-fixtures.ts`. Open **Upload publication**:

- File: `.data/manual-fixtures/manual-upload.txt` (or `manual-upload.docx`, `manual-upload.pdf`).
- Publication title: `SYNTHETIC presentation upload`.
- Issuing source: **RBI — current notifications listing** (India). The dropdown now includes source names so the historical and current RBI sources can be distinguished.
- Publication type: **Circular**. Reference number: `SYNTH-PRESENTATION-1`. Leave dates blank.
- Click **Upload & process** once. The message follows queued → running → succeeded, then opens the publication. Dates remain **Unknown**. The worker runs inside the same demo process, so a second worker terminal is unnecessary.

In default demo mode, success means **original stored and readable text extracted**. Fresh AI analysis is paused; the detail screen says this explicitly. It does not fabricate obligations or fill blank metadata. Use the saved official records to show AI results. Uploading adds a record to the demo copy, so do it last if you want a clean seven-record opening screen.

Negative test (use a separate verification copy before presentation): `unreadable.pdf` must end **Failed** with an extraction error, never an empty successful AI result. Manual HTML remains unsupported.

## Optional fresh Bedrock demonstration

Stop the current demo with Ctrl+C, then explicitly opt in:

```sh
npm run demo:live
```

This uses the **same database and UI** and enables the existing real Bedrock extraction/comparison pipeline. New successful uploads queue AI analysis, and requested comparisons use Bedrock. Configure temporary `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_CREDENTIAL_EXPIRATION`, `AWS_REGION`, `BEDROCK_MODEL_ID` in the ignored local environment first. Local credential validation runs before startup; model access and output validity are checked by the existing pipeline. This mode may incur charges and was **not invoked during cleanup**.

Existing text-only uploads are not automatically reanalyzed merely by changing mode. For a specific existing version, an operator can use the existing `backend:analyze` command with `RIA_DATA_DIR=.data/level1-demo` and its exact version UUID. See [ANALYSIS_INTEGRATION.md](ANALYSIS_INTEGRATION.md). Do not re-upload repeatedly while a job is running.

Default saved mode blocks new comparison/predecessor-link requests immediately with the existing `403 forbidden` envelope and disables their UI controls. It still allows reads, local uploads and review saves. No schemas or endpoint paths changed. Normal backend startup retains its previous behavior.

## Monitoring, scheduling and boundaries

**Run now** / **Run enabled sources** intentionally contact official websites and create separately tracked monitoring/ingestion jobs. Availability is external and can fail. Do not click these merely to show the saved demo. Both demo launch modes pause the automatic scheduler, clearly labelled in the banner; saving a frequency alone will not run scheduled monitoring in demo mode. Use the regular worker with `RIA_SCHEDULER_ENABLED=true` in an isolated database to demonstrate scheduling as documented in [BACKEND_INGESTION.md](BACKEND_INGESTION.md).

See [LEVEL1_STATUS.md](LEVEL1_STATUS.md) for previously verified listing/fetch/extraction/analysis coverage. Discovery is bounded, not exhaustive. CBUAE access was blocked; DFSA supplies UAE evidence. Current Kenya PDFs were image-only; the displayed CBK historical circular is a different readable source. No OCR or automatic legal certification is claimed. All six change classes have labelled synthetic tests, not six proven real changes.

## Verification of this cleanup

- `npm run check`: both TypeScript checks, 48 shared fixtures, 220 passing tests.
- `npm run build`: production build passed.
- `npm run verify:demo`: Chrome against an isolated copy, seven saved records, **104 obligation/comparison citations** revalidated against exact stored text; three RBI changes; protected API/private files; TXT/DOCX/PDF uploads; unreadable-PDF failure; search/country filter; human review; full stop/restart persistence. No stuck ingestion jobs. No regulator fetches or paid model calls.
- `npm run verify:browser`: existing synthetic UI/API regression, including monitoring, predecessor upload/link, comparison, scheduling and duplicate-free reruns. This is synthetic transport/model evidence, separate from the saved real RBI result.

Reports and screenshots remain private under `.data/demo-verification-*`. These checks do not certify current law or fresh external source availability.
