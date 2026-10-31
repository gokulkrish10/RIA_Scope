# Regulatory Change Impact Agent — Level 1 API contract

Contract version: **1.0.0** (`CONTRACT_VERSION`). These schemas originated in the shared foundation. The endpoints are now implemented locally; see [LEVEL1_INTEGRATION.md](LEVEL1_INTEGRATION.md) for verified coverage and limitations. Direct reads and writes require the trusted server bearer token; browsers authenticate to the local gateway, which injects that token server-side. The authoritative executable definition is `src/shared/contracts/index.ts`; `API_CONTRACT` exports methods, paths, parameter/request schemas and status-to-response schemas. Never maintain separate interface copies in the frontend or backend.

## Wire conventions

- Base path: `/api/v1`. JSON keys and string enum values use camelCase. JSON responses are direct resource objects, except paginated resources and the error envelope below. JSON request bodies use `application/json`; only uploads use multipart.
- IDs are opaque **lowercase UUID strings**, not integers, database row IDs or reference numbers. Server-generated IDs are immutable. `documentId` identifies the logical document; `versionId`/`currentVersionId` identifies immutable content; `publicationId` identifies its regulatory catalog record. Evidence always identifies both document and version. `referenceNumber` is regulatory text and is not an ID.
- Every schema is strict: unknown keys are rejected. All object properties are required unless explicitly optional in the schema. Required nullable fields must appear as `null` when unknown; omission, empty strings and sentinel dates are invalid substitutes. Optional means omitted, not null. Arrays are always arrays, never null. Strings containing only whitespace are rejected.
- `SourceDateSchema`: valid Gregorian `YYYY-MM-DD` **or**, only when the source provides a known instant, `YYYY-MM-DDTHH:mm:ss.sssZ`. Preserve date-only precision. Source timezone conversion happens before serialization. `publicationDate`, `effectiveDate`, obligation `effectiveDate` and `complianceDeadline` are independent and nullable. No date inferred from download/discovery time.
- `UtcTimestampSchema`: exact millisecond UTC timestamp, e.g. `2026-10-31T04:30:00.000Z`. System discovery, creation, update, extraction, scheduling and job event times use this format. No offsets or local timestamps. Null extraction time means extraction has not succeeded.
- Countries use uppercase ISO 3166-1 alpha-2 codes, e.g. SA/AE/IN/ZA. Schema checks format; backend checks membership against configured jurisdictions. `region` is one of the four demonstration groups, never an inferred nationality. Regulator filtering uses stable `regulatorId`, never display-name matching.
- Public response types contain no database rows, credentials, environment settings, private object keys, filesystem paths or internal exceptions. `fileName` is a basename. URLs identify public source pages/documents, never signed storage downloads. The URL schema rejects embedded credentials and common credential query parameters; adapters must also ensure a URL contains no private information. Public query parameters such as `?id=42` are allowed. Schema validation is not authorization, network-destination validation or secret redaction.
- `202` means resources/job were durably accepted and IDs allocated. It does **not** mean monitoring, extraction or comparison succeeded. Return `Location: /api/v1/jobs/{jobId}` on every accepted operation. Returned `state: queued` is the acceptance snapshot; a subsequent read may already show running or terminal state.

## Core schemas and fields

Fields below are required unless marked `?`. `T | null` means explicitly nullable. Refer to the exported schemas for exact length limits and validation refinements.

| Schema | Fields |
| --- | --- |
| SourceConfig | `id`, `name`, `country`, `region`, `regulatorId`, `regulatorName`, `url`, `enabled`, `monitoringIntervalMinutes`, `lastMonitoredAt: timestamp \| null`, `nextMonitorAt: timestamp \| null`, `createdAt`, `updatedAt` |
| SourceUpdateRequest | `name?`, `url?`, `enabled?`, `monitoringIntervalMinutes?`; at least one supplied, none nullable |
| DiscoveredPublication | `id`, `sourceId: ID \| null`, `title`, `country`, `regulatorId`, `regulatorName`, `kind`, `referenceNumber: string \| null`, `publicationDate: SourceDate \| null`, `effectiveDate: SourceDate \| null`, `discoveredAt`, `sourceUrl: URL \| null` |
| PublicationSummary | All discovery fields plus `documentId`, `currentVersionId`, `businessAreas[]`, `processingState`, `processingError: ErrorInfo \| null`, `review: ReviewRecord`, `relationshipState`, `changeClasses[]`, `latestComparisonId: ID \| null`, `updatedAt` |
| PublicationDetail | All summary fields plus `summary: string \| null`, `versions: DocumentVersion[]` (at least one), `obligations: Obligation[]`, `references: RegulatoryReference[]` |
| DocumentVersion | `id` (version ID), `documentId`, `publicationId`, positive `versionNumber`, `fileName`, `mediaType`, positive `sizeBytes`, `ingestionMethod`, `sourceUrl: URL \| null`, `createdAt`, `extractedAt: timestamp \| null`, `processingState`, `processingError: ErrorInfo \| null` |
| SourceEvidence | `documentId`, `versionId`, nonblank `locator` (clause/section), `pageNumber?` (integer, 1-based), nonblank verbatim `excerpt`. No page number for text without pagination. If no numbered clause exists, use a stable locator such as `Paragraph 7`. |
| Obligation | `id`, `publicationId`, nonblank `text`, nonempty `businessAreas[]`, `applicableEntities[]`, `departments[]`, `regulatedActivities[]`, `effectiveDate: SourceDate \| null`, `complianceDeadline: SourceDate \| null`, nonempty `evidence[]` |
| RegulatoryReference | `id`, `referenceText`, `referenceNumber: string \| null`, `relation`, nonempty `evidence[]`, `resolution`; variant fields below |
| ReviewRecord | `state`, `note: string \| null`, `reviewedBy: ID \| null`, `updatedAt`. `reviewedBy` is required/non-null except for an untouched pending record. |
| ReviewUpdateRequest | `state`, `note: string \| null`, `expectedUpdatedAt` (review record timestamp); rejection needs a note |

Reference variants:

- `resolved`: `targetPublicationId` and `targetVersionId`, both non-null; no `reason` or candidates.
- `unresolved`: nonblank `reason`; no target IDs or candidates. Never substitute a guessed target ID or empty successful result.
- `ambiguous`: nonblank `reason` and at least two distinct `candidatePublicationIds`; no target IDs.

Only successful extraction exposes `summary`, obligations and references. Until then summary is null and arrays are empty **with an explicit queued/processing/failed state**. Failed processing requires `processingError.code: extractionFailed`; successful extraction may legitimately find zero obligations. Detail must contain its current version; obligation/reference evidence cites that version. Historical versions remain immutable.

## Enums and independent state dimensions

The enums are defined once in executable form in `common.ts` (format/ingestion enums in `publications.ts`). These lists document their wire values:

| Dimension | Exact values |
| --- | --- |
| Region | `ksa`, `uae`, `india`, `africa` |
| Business area | `ai`, `banking`, `lending`, `insurance`, `payments`, `otherBfsi` |
| Publication kind | `regulation`, `circular`, `amendment`, `consultation`, `guideline`, `other` |
| Processing state | `queued`, `processing`, `succeeded`, `failed` |
| Review state | `pending`, `inReview`, `approved`, `rejected` |
| Relationship state | `unchecked`, `notRequired`, `resolved`, `missingPredecessor`, `ambiguous` |
| Reference resolution | `unresolved`, `resolved`, `ambiguous` |
| Reference relation | `cites`, `amends`, `replaces`, `withdraws` |
| Comparison state | `queued`, `processing`, `succeeded`, `blocked`, `failed` |
| Job state | `queued`, `running`, `succeeded`, `blocked`, `failed` |
| Job kind | `monitor`, `ingestion`, `comparison` |
| Monitor outcome | `succeeded`, `partial`, `failed` |
| Source run state | `succeeded`, `failed` |
| Ingestion method | `monitor`, `upload` |

`kind: amendment` is document metadata, not a processing/review state. A newly discovered item uses `discoveredAt`, not a seventh change class. Relationship resolution is independent of processing success and human approval. `unchecked` means relationship analysis has not completed; `notRequired` means no amends/replaces/withdraws reference requires a predecessor; `resolved` means all such references are resolved. An unresolved ordinary citation alone need not block comparison. Missing/ambiguous predecessor states require corresponding references in detail.

### Six change classes

Every ChangeItem contains `id`, `classification`, a nonblank plain-English `explanation`, and `before`/`after` source evidence for side-by-side display.

| classification | Meaning | Additional rules |
| --- | --- | --- |
| `newObligation` | New obligation introduced | `before: null`, `after: SourceEvidence` |
| `modifiedObligation` | Existing obligation modified | Non-null before and after |
| `withdrawnOrSuperseded` | Obligation withdrawn or superseded | Before cites old requirement; after cites the explicit withdrawal/replacement clause |
| `deadlineChanged` | Compliance deadline extended or shortened | Non-null before/after; `deadlineDirection: extended \| shortened`; non-null `previousDeadline` and `updatedDeadline` |
| `clarification` | Additional clarification issued | Non-null before and after |
| `noMaterialChange` | No material change identified | Non-null before/after; must be the sole item in a successful comparison |

Only deadline changes carry direction/deadline fields. Deadlines must have matching precision and order consistent with the direction; equal dates are invalid. If precision cannot be reconciled from evidence, report comparison failure with details instead of inventing a date. Frontend highlights the supplied excerpts; no unstable character-offset diff format is part of Level 1.

Comparison fields: `id`, `publicationId`, `currentDocumentId`, `currentVersionId`, `predecessorPublicationId: ID | null`, `predecessorDocumentId: ID | null`, `predecessorVersionId: ID | null`, `createdAt`, `state`, `completedAt: timestamp | null`, `changes[]`, `issue: ErrorInfo | null`. All predecessor IDs are supplied together or all null; never self-reference.

- Queued/processing: no changes, null completion and issue.
- Succeeded: nonempty changes, completedAt, null issue. After evidence cites current version; before evidence cites predecessor version. An initial document with no predecessor can produce only new-obligation items.
- Blocked: no changes, completedAt, issue code `missingPredecessor` or `ambiguousPredecessor`, all predecessor IDs null, nonempty `unresolvedReferenceIds`. No success classification is inferred.
- Failed: no changes, completedAt, issue code `extractionFailed` or `comparisonFailed`. Distinct from a missing predecessor and from no material change.

Summary `changeClasses` is the unique set from the latest completed successful comparison for the current version. While a new comparison is queued/blocked/failed, expose `[]`; `latestComparisonId` identifies that latest attempt. Do not carry stale classes into filters. Comparison results and past job results are immutable snapshots, not live publication reads; read publication detail for current review state.

## Pagination and filtering

List endpoints return `paginatedResponseSchema(ItemSchema)` / inferred `PaginatedResponse<T>`:

```json
{ "items": [], "page": 1, "pageSize": 20, "total": 0, "hasNextPage": false }
```

`page` starts at 1; default 1. `pageSize` default 20, integer 1–100. `total` is the exact filtered count before pagination. `hasNextPage = page * pageSize < total`. A page beyond the last returns an empty array and false (200). Items and count must reflect a consistent query snapshot. Pages across separate requests are not a persistent snapshot; refresh on changes. No cursor or `data` wrapper.

Query parsing: `parsePublicationSearchParams(URLSearchParams)` or `parsePaginationSearchParams`. Do not use loose number coercion. Unknown keys, repeated scalar values, empty/duplicate filters, zero/negative/decimal pages, comma-separated arrays and invalid enums return 400. Defaulted numeric query schemas operate on already-decoded numbers; the helpers handle raw URLs.

`GET /publications` supports:

| Query key | Wire representation / behavior |
| --- | --- |
| `q` | Optional nonblank string, maximum 200 characters; case-insensitive substring across title, reference number and extracted text; OR across those fields |
| `country` | Optional repeated uppercase codes, e.g. `country=SA&country=IN` |
| `regulatorId` | Optional repeated UUIDs |
| `businessArea` | Optional repeated BusinessArea values |
| `changeClass` | Optional repeated ChangeClass values |
| `publicationDateFrom`, `publicationDateTo` | Optional date-only inclusive bounds; from <= to. Compare source date portion, UTC calendar date for source timestamps. Unknown dates are excluded only when a bound is supplied. |
| `processingState`, `reviewState`, `relationshipState` | Optional single exact enum value |
| `page`, `pageSize` | Pagination described above |

Repeated filters have 1–100 unique entries. OR within a key, AND across different keys. Omit a filter to mean all; `[]`, `all`, CSV and null are not accepted wire values. Sources list only accepts page/pageSize. Publication sort is fixed `discoveredAt DESC, id ASC`; sources sort `name ASC, id ASC` using deterministic code-point ordering. No undocumented sort parameter. Business area filtering uses extracted applicability; change-class filtering excludes pending/failed/blocked comparisons because those have no classifications.

## Error envelope and status semantics

All non-2xx responses use `ApiErrorSchema`:

```json
{
  "error": {
    "code": "validationError",
    "message": "Invalid request.",
    "retryable": false,
    "details": [{ "path": ["publicationDate"], "message": "Expected a calendar date or UTC timestamp." }]
  },
  "requestId": "00000000-0000-4000-8000-000000000050",
  "timestamp": "2026-10-31T04:30:05.000Z"
}
```

`ErrorInfo` is the inner `{code,message,retryable,details}` reused by job/processing/comparison failures. `details` is always present (possibly empty); each path is a string/integer segment array relative to the submitted payload/query. Errors must not echo secrets, raw documents, SQL or stack traces. Frontends branch on code, not message. `requestId` correlates server diagnostics.

| HTTP status | Error codes / meaning |
| --- | --- |
| 400 | `validationError`: malformed JSON/query/UUID, unknown fields, invalid metadata/schema |
| 401 / 403 | `unauthorized` / `forbidden` if authentication/authorization is configured |
| 404 | `notFound`: resource/source/regulator/reference absent or wrong resource kind |
| 409 | `conflict`, `resultNotReady`, `jobFailed`, `jobBlocked` as documented per operation |
| 413 | `payloadTooLarge`: file, metadata or total request limit exceeded |
| 415 | `unsupportedMediaType`: unsupported/mismatched document or multipart content type |
| 422 | `validationError` for corrupt/encrypted upload detected synchronously; `extractionFailed` for an already failed version |
| 429 | `rateLimited`; include `Retry-After` seconds |
| 500 | `internalError`; sanitized unexpected server failure |

Additional domain ErrorCode values used in resource/job results: `sourceUnavailable`, `extractionFailed`, `missingPredecessor`, `ambiguousPredecessor`, `comparisonFailed`. Complete enum: `ErrorCodeSchema`. A 200 read of a **failed job/comparison** is a successful resource read, not successful processing. The resource state carries the outcome. A 202 can never be displayed as “processing complete”. Every endpoint supports common 400/401/403/429/500 responses; tables below list operation-specific responses too. Authentication, scheduling durability, deduplication, authorization and database referential integrity must be implemented server-side; schemas alone cannot enforce them.

## Endpoint specification

All paths below include the base prefix. Path parameters use the exported `SourcePathSchema`, `PublicationPathSchema`, `JobPathSchema`, or `ComparisonPathSchema`. No GET request bodies. JSON bodies are required for POST/PATCH (use `{}` where permitted). Except for uploads and ordinary HTTP infrastructure headers, no custom request headers are required.

### 1. List and update sources

| Method and exact path | Request | Success | Other operation-specific statuses |
| --- | --- | --- | --- |
| GET `/api/v1/sources` | PaginationQuerySchema via parsePaginationSearchParams | 200 SourceListResponseSchema | Common errors |
| PATCH `/api/v1/sources/:sourceId` | SourceUpdateRequestSchema | 200 SourceConfigSchema | 404 missing source; 409 conflicting source configuration |

Updates permit name, public URL, enabled and interval only. Omitted properties are unchanged; null is invalid. Country/region/regulator identity is configured server-side, not mutable through this patch. Interval integer 15–43,200 minutes. Disabled sources have null nextMonitorAt; enabled sources may be unscheduled (null) while scheduler catches up. lastMonitoredAt is the most recent attempted cycle, including failures. Changes do not mutate historical discoveries. Backend validates URL destination policy before fetching.

### 2. Trigger monitoring

`POST /api/v1/monitor-runs`, JSON `MonitorRequestSchema`:

```json
{ "sourceIds": ["00000000-0000-4000-8000-000000000020"] }
```

Omit sourceIds (`{}`) to run all enabled sources; otherwise supply 1–100 distinct configured/enabled source IDs. Unknown source: 404. Disabled source, no enabled sources, or overlapping active run for any selected source: 409 conflict, with no partial acceptance. Success: **202 MonitorAcceptedResponseSchema** `{jobId,state:"queued"}`. Common errors also apply.

Each successful source run commits discoveries and creates one ingestion job for each newly discovered publication. Known publications are counted, not re-enqueued. Backend deduplicates by source/canonical identifier and content version; changed bytes may create a new document version/ingestion job through its ingestion pipeline, without duplicate publication records. This Level 1 monitor response reports only new publications; `alreadyKnownCount` includes discoveries of already catalogued publications. Processing of revised known documents must remain visible via their publication detail/currentVersionId, not an invented “new publication”.

### 3. Read job status and monitoring result

| Method and exact path | Request | Success | Other operation-specific statuses |
| --- | --- | --- | --- |
| GET `/api/v1/jobs/:jobId` | JobPathSchema | 200 JobStatusSchema, including nonterminal/blocked/failed states | 404 missing job |
| GET `/api/v1/monitor-runs/:jobId/result` | JobPathSchema | 200 MonitorRunResultSchema, including partial/failed outcome | 404 missing job or non-monitor kind; 409 resultNotReady while queued/running; 409 jobFailed if catastrophic failure left no run result |

JobStatus: `id`, `kind`, `state`, `createdAt`, `startedAt: timestamp | null`, `completedAt: timestamp | null`, `error: ErrorInfo | null`, `result: JobResult | null`.

- queued: all execution times, error and result null.
- running: startedAt non-null; completion, error and result null.
- succeeded: both execution times non-null, error null, non-null result of matching kind.
- blocked: terminal comparison job with issue code missingPredecessor/ambiguousPredecessor and blocked Comparison result. A retry creates a new job; do not wait indefinitely on this one.
- failed: completion and error required; result may be null only when work could not produce a domain result. Domain result, if present, must also be failed. StartedAt can be null if execution never started.

JobResult is `{kind:"monitor",monitorRun}`, `{kind:"ingestion",publication}`, or `{kind:"comparison",comparison}`. Jobs never silently transition from terminal back to queued. Poll at a suggested 1–2 seconds while queued/running, back off on 429, stop at any terminal state. No progress percentage or cancellation API is specified.

MonitorRunResult: `jobId`, `outcome`, `startedAt`, `completedAt`, nonempty `sources[]`. Each source result includes `sourceId`, `state`, `publicationsFound`, `alreadyKnownCount`, `discoveredPublications[]`, `ingestionJobIds[]` and `error: ErrorInfo | null`. Found = already known + new discoveries. Ingestion IDs align one-to-one and by index with newly discovered publications. A failed source has sourceUnavailable error, zero counts and empty arrays; commit/rollback the source batch atomically. `outcome` is succeeded if all sources succeed, failed if all fail, partial otherwise. Partial discovery means the monitor job itself completed (`succeeded`) but the UI **must** show partial source failure. Monitor completion does not imply ingestion completion. Follow returned ingestion jobs separately.

### 4. Upload a document

`POST /api/v1/publications/upload`, `multipart/form-data` with boundary:

| Field name | Required value |
| --- | --- |
| `file` | Exactly one binary file part; no arrays or alternate field names |
| `metadata` | Exactly one UTF-8 JSON text form field matching UploadMetadataSchema |

UploadMetadata fields: `title`, `country`, `regulatorId`, `kind`, `referenceNumber: string | null`, `publicationDate: SourceDate | null`, `effectiveDate: SourceDate | null`, `sourceId: ID | null`. Display regulator name comes from the server catalog. SourceId may be null for manual uploads; when supplied, country and regulator must match that source.

Allowed extension/MIME pairs: `.pdf` / `application/pdf`, `.docx` / `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `.txt` / `text/plain` (UTF-8; optional BOM). Extensions are case-insensitive. Limit: **1–20,971,520 file bytes**, **16,384 metadata bytes**, **22,020,096 total request bytes**, one file, two named parts, no extra/duplicate parts. Exported `UPLOAD_LIMITS` and `MULTIPART_FIELDS` are authoritative. `UploadFileDescriptorSchema` validates basename/size/extension/MIME metadata; backend must independently count streamed bytes, validate signatures/DOCX structure and UTF-8, reject corrupt/encrypted/unsupported documents, and bound decompression/extraction resources. These operations are not implemented by Zod.

Responses: **202 UploadAcceptedResponseSchema** `{jobId,state:"queued",publicationId,documentId,versionId}`. 400 malformed multipart/metadata/duplicate or unknown parts; 404 unknown source/regulator; 409 duplicate content already catalogued or inconsistent source/country/regulator; 413 limit exceeded; 415 unsupported/mismatched format; 422 corrupt/encrypted document detected before acceptance. Common errors apply.

After acceptance, any extraction failure is persisted as a failed ingestion job with extractionFailed and a failed publication/current version. Never return an empty successful obligations result for it. Static upload path must be registered before `/:publicationId` in routers that match in declaration order.

### 5–6. Search, read detail and obligations

| Method and exact path | Request | Success | Other operation-specific statuses |
| --- | --- | --- | --- |
| GET `/api/v1/publications` | PublicationSearchQuerySchema via parsePublicationSearchParams | 200 PublicationListResponseSchema | Common errors |
| GET `/api/v1/publications/:publicationId` | PublicationPathSchema | 200 PublicationDetailSchema in any processing state | 404 missing publication |
| GET `/api/v1/publications/:publicationId/obligations` | PublicationPathSchema | 200 PublicationObligationsResponseSchema | 404 missing publication; 409 resultNotReady while queued/processing; 422 extractionFailed after extraction failure |

Obligations response: `{publicationId,versionId,processingState:"succeeded",obligations:Obligation[]}`. It is deliberately not paginated for Level 1 and only available after successful extraction. An empty obligations array here means extraction succeeded and found no obligations. Detail returns current-version obligations/references plus metadata for all document versions; it does not expose raw document bytes or private storage URLs.

Example search: `/api/v1/publications?country=SA&country=IN&businessArea=ai&changeClass=deadlineChanged&publicationDateFrom=2026-01-01&page=1&pageSize=20`.

### 7. Request and read a historical comparison

| Method and exact path | Request | Success | Other operation-specific statuses |
| --- | --- | --- | --- |
| POST `/api/v1/publications/:publicationId/comparisons` | ComparisonRequestSchema | 202 ComparisonAcceptedResponseSchema | 404 missing publication/version; 409 stale currentVersionId, version not owned by publication, already active comparison, or baseline with no obligations |
| GET `/api/v1/comparisons/:comparisonId` | ComparisonPathSchema | 200 ComparisonSchema, including blocked/failed states | 404 missing comparison |

Request `{currentVersionId,predecessorVersionId: ID | null}`. Explicit predecessor selects a stored historical version; null requests automatic reference resolution (or a baseline if no predecessor is required). Response `{jobId,state:"queued",comparisonId,publicationId}`. IDs exist at acceptance; the worker validates extraction readiness and relationships. Failed extraction produces failed comparison/job with extractionFailed; still-running extraction may be waited for by the worker. Missing/ambiguous predecessor produces blocked comparison/job with unresolved reference IDs. Never return succeeded with an empty changes array. Current and predecessor versions are immutable; retries allocate new comparison/job IDs. Common errors apply.

Each comparison targets one pair. Explicit selection must agree with the intended referenced regulation; backend checks cross-resource integrity and prevents self-reference/cycles. If several predecessor references exist, resolve/link them individually and compare selected pairs. Publication relationship state remains missing/ambiguous until all required relationships are established.

### 8. Supply a missing predecessor and rerun

1. Upload predecessor using the **same** `/api/v1/publications/upload` operation and metadata fields; there is no second upload backend or special binary field.
2. Poll that ingestion job. Continue only when succeeded; retain/report failed extraction explicitly.
3. `POST /api/v1/publications/:publicationId/predecessor` with PredecessorLinkRequestSchema:

```json
{
  "referenceId": "00000000-0000-4000-8000-000000000007",
  "currentVersionId": "00000000-0000-4000-8000-000000000003",
  "predecessorPublicationId": "00000000-0000-4000-8000-000000000004",
  "predecessorVersionId": "00000000-0000-4000-8000-000000000006"
}
```

If already catalogued, skip upload and use the existing predecessor IDs. The endpoint atomically links this predecessor reference and queues a **new** comparison/job for the supplied pair. Success **202 ComparisonAcceptedResponseSchema**. 404 missing publication/reference/version; 409 stale current version, unrelated/cross-owned reference or version, self/cyclic relationship, reference is only a citation, active comparison, or still-processing predecessor; 422 extractionFailed for failed predecessor/current version. Common errors apply. Same existing link is permitted to rerun once no comparison is active; no silent duplicate active job. The old blocked comparison and job remain immutable. All required references must be resolved before publication-level classifications are exposed. Read the new comparison ID, not the old blocked result.

### 9. Update review state

`PATCH /api/v1/publications/:publicationId/review`, ReviewUpdateRequestSchema `{state,note,expectedUpdatedAt}`. Returns **200 ReviewRecordSchema**, with server-authenticated reviewer and a fresh UTC updatedAt. Server compares expectedUpdatedAt against the **review record's** updatedAt, not publication updatedAt; stale values return 409 conflict. Re-read and let the reviewer resolve the conflict rather than silently retrying approval.

Permitted transitions: any review state to any review state (including reopening as pending/inReview and revising the note in the same state). Rejected requires a nonblank note. Approved/rejected require processing success; approved also requires relationship resolved/notRequired. Invalid transitions under those conditions return 409. Missing publication: 404. Common errors apply. Client never submits reviewer identity. Human review does not mutate extracted obligations, source evidence or change classification. A new document version resets review to pending; backend must ensure review timestamps advance so stale clients cannot approve a new version accidentally.

## Validation boundary

Run `npm run check`. It type-checks Node and browser imports, validates all fixtures including JSON round trips, and tests rejection of invalid enums, dates, evidence, job results, errors, pagination and unresolved relationships. Runtime schema checks validate a single payload; backend services additionally enforce catalog membership, cross-resource ownership, immutable version lineage, deduplication, concurrency, state transitions, actual file bytes and safe public serialization. No end-to-end HTTP/worker/database test is claimed because those components do not exist yet.
