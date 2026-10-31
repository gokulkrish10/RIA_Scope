# Sethu integration guide

> Repair update: [REAL_SOURCE_REPAIR.md](REAL_SOURCE_REPAIR.md) records the approved monitored-HTML contract extension, source diagnostics and real RBI historical verification. Statements below describe the earlier checkpoint.

> Integration update: read [LEVEL1_INTEGRATION.md](LEVEL1_INTEGRATION.md) for the current combined application, authorization, startup and verification. Earlier implementation-status claims below describe the named input checkpoint. Direct API reads now require the trusted server token; browser access goes through the authenticated local gateway.

The shared contract is ready for independent frontend/backend work. **No HTTP endpoint is implemented in this checkout.** Use validated fixtures for screens until the backend implements the matching operation in `API_CONTRACT`.

## Imports and ownership

```ts
// Example from a module under src/client/. Adjust only the relative path if needed.
import {
  API_CONTRACT,
  PublicationDetailSchema,
  PublicationListResponseSchema,
  JobStatusSchema,
  ApiErrorSchema,
  type PublicationDetail,
  type PublicationSummary,
  type JobStatus,
} from '../shared/contracts/index.js';
import {
  publicationFixture,
  missingPredecessorPublicationFixture,
  extractionFailedPublicationFixture,
  publicationPageFixture,
  blockedJobFixture,
} from '../shared/fixtures/index.js';
```

The `.js` specifiers are intentional TypeScript ESM conventions; NodeNext and modern bundlers resolve the `.ts` source. No path alias, frontend framework or backend framework is imposed. Only Zod is a runtime dependency. Shared modules have no Node imports, database clients, credentials, private paths or application initialization. Keep server adapters outside `src/shared`.

Do not redefine these payloads with local interfaces, string enums or `as PublicationDetail` casts. Every named public type is inferred from its corresponding runtime schema. Parse network data as `unknown` at the boundary. UI-specific view models may derive from parsed contracts; database models must be mapped to public objects and then validated before serialization. Do not return ORM objects directly.

The Zod schema exports are the source of truth. `API_CONTRACT` binds schemas to routes/statuses and is metadata, not a server/router. Request bodies use the operation's `body` schema; raw list URL parameters use the supplied parser helpers. Upload bytes require a multipart adapter plus the metadata/file descriptor schemas.

## Implementation status

| Surface | Status |
| --- | --- |
| Shared schemas, inferred types and endpoint registry | Implemented |
| Synthetic fixtures and validation scripts | Implemented |
| Contract tests and Node/browser type checking | Implemented |
| Source listing/updating | Planned HTTP routes |
| Monitor trigger, job reads, monitor result reads | Planned HTTP routes and workers |
| PDF/DOCX/text upload and extraction | Planned HTTP route and worker |
| Publication search/detail/obligations | Planned HTTP routes |
| Comparison request/read and predecessor linking | Planned HTTP routes and worker |
| Review update | Planned HTTP route and authentication integration |
| Database, storage, scheduler, credentials, UI/screens | Not created by this task |

Exact operation paths, request/response schemas, status codes and multipart limits are in [API_CONTRACT.md](API_CONTRACT.md). Use the registry instead of inventing a second route naming scheme.

## Frontend usage

Fetch and parse a publication; a 200 detail response can still represent failed extraction:

```ts
async function readPublication(publicationId: string): Promise<PublicationDetail> {
  const path = API_CONTRACT.readPublication.path.replace(
    ':publicationId', encodeURIComponent(publicationId),
  );
  const response = await fetch(path);
  const payload: unknown = await response.json();
  if (!response.ok) {
    const failure = ApiErrorSchema.parse(payload);
    throw new Error(`${failure.error.code}: ${failure.error.message}`);
  }
  return PublicationDetailSchema.parse(payload);
}
```

Use repeated query parameters, not CSV. The same wire format works in browser fetch and the backend parser:

```ts
const query = new URLSearchParams({ page: '1', pageSize: '20' });
query.append('country', 'SA');
query.append('country', 'IN');
query.append('businessArea', 'ai');
query.append('changeClass', 'deadlineChanged');
const response = await fetch(`${API_CONTRACT.searchPublications.path}?${query}`);
const payload: unknown = await response.json();
if (!response.ok) throw ApiErrorSchema.parse(payload);
const page = PublicationListResponseSchema.parse(payload);
// page.items, page.total and page.hasNextPage drive the list.
```

Trigger monitoring with `{}` (all enabled sources) or `{sourceIds:[...]}`, parse `MonitorAcceptedResponseSchema`, then poll the returned job ID. On each poll parse `JobStatusSchema`:

```ts
function jobMessage(job: JobStatus): string {
  switch (job.state) {
    case 'queued': return 'Waiting to start';
    case 'running': return 'Processing';
    case 'blocked': return job.error.message; // Offer predecessor recovery.
    case 'failed': return job.error.message;  // Do not render as zero results.
    case 'succeeded':
      if (job.result.kind === 'monitor') {
        return job.result.monitorRun.outcome === 'partial'
          ? 'Monitoring completed with source failures'
          : 'Monitoring completed; check document processing jobs';
      }
      return job.result.kind === 'ingestion' ? 'Document extracted' : 'Comparison ready';
  }
}
```

Stop polling at succeeded/blocked/failed. Suggested starting interval is 1–2 seconds; honor 429 Retry-After. Monitoring discovers publications and schedules ingestion—it does not guarantee extracted obligations. Follow the result's per-source ingestionJobIds; a succeeded ingestion job may still have a missing predecessor relationship.

Do not use `changeClasses: []` to mean no material change: only an explicit successful comparison with `noMaterialChange` has that meaning. Show processing failures, missing predecessor and ambiguous candidates separately from review badges. Keep date-only strings intact when displaying/filtering them; `new Date('YYYY-MM-DD')` can shift the visible day in some timezones. Only format source timestamps as instants.

Upload example from a browser (using a selected `File`):

```ts
import {
  MULTIPART_FIELDS, UploadMetadataSchema, UploadFileDescriptorSchema,
  UploadAcceptedResponseSchema,
} from '../shared/contracts/index.js';
import { uploadMetadataFixture } from '../shared/fixtures/index.js';

async function upload(file: File) {
  // Demo metadata only: use actual catalog IDs and user-entered metadata in the app.
  const metadata = UploadMetadataSchema.parse(uploadMetadataFixture);
  UploadFileDescriptorSchema.parse({
    fileName: file.name, mediaType: file.type, sizeBytes: file.size,
  });
  const body = new FormData();
  body.append(MULTIPART_FIELDS.file, file);
  body.append(MULTIPART_FIELDS.metadata, JSON.stringify(metadata));
  const response = await fetch(API_CONTRACT.uploadDocument.path, {
    method: API_CONTRACT.uploadDocument.method, body,
  });
  // Let the browser supply multipart Content-Type and boundary.
  const payload: unknown = await response.json();
  if (!response.ok) throw ApiErrorSchema.parse(payload);
  return UploadAcceptedResponseSchema.parse(payload); // Acceptance, not extraction success.
}
```

`File.type` may be empty or unreliable. The UI should explain unsupported/missing type metadata and may derive the supported declared MIME from the extension before validation; the backend always inspects actual bytes. Do not bypass server size or content checks because frontend validation passed.

Missing predecessor flow: upload → poll ingestion to succeeded → POST the original publication's `/predecessor` with `referenceId`, `currentVersionId`, `predecessorPublicationId`, `predecessorVersionId` → poll the **new** comparison job → read its comparison. An already stored predecessor skips upload. No separate predecessor upload endpoint or multipart flag exists.

Review flow: PATCH `/publications/:publicationId/review` with `state`, `note` (nullable except rejection) and `expectedUpdatedAt: publication.review.updatedAt`. Parse ReviewRecordSchema. On 409, re-read the publication and ask the reviewer to reconcile; never silently replay approval. Do not send a reviewer ID; the server supplies authenticated identity.

## Backend usage

```ts
import {
  API_CONTRACT, SourcePathSchema, SourceUpdateRequestSchema,
  SourceConfigSchema, parsePublicationSearchParams,
} from '../shared/contracts/index.js';

// Framework-neutral boundary examples; these do not create a server.
function parseSourceUpdate(params: unknown, body: unknown) {
  return {
    params: SourcePathSchema.parse(params),
    request: SourceUpdateRequestSchema.parse(body),
  };
}
function parseSearch(requestUrl: string) {
  return parsePublicationSearchParams(new URL(requestUrl).searchParams);
}
function serializeSource(publicDto: unknown) {
  return SourceConfigSchema.parse(publicDto);
}
// Register the existing application's route at API_CONTRACT.updateSource.path.
```

Translate Zod issues into `ApiErrorSchema` with `validationError`, a request UUID, UTC timestamp and safe `{path,message}` details. Avoid exposing raw error objects. Allocate persisted publication/document/version/job IDs before returning upload 202. Enforce referential integrity and stale-version/review checks in the transaction. Do not let a queued job's HTTP acceptance be stored as processing success.

## Validation and fixture scenarios

```sh
npm ci
npm run typecheck          # Strict TypeScript + browser build without Node ambient types
npm run validate:fixtures  # Validate every registered fixture and JSON wire form
npm run test:contracts     # Contract compatibility and rejection tests
npm run check             # All three
```

`package-lock.json` pins dependencies. Scripts use `node --import tsx` to avoid the standalone tsx CLI's IPC socket requirement in restricted environments. Tests are local and require no server, accounts, network or database after dependencies are installed. The package supports Node 22+; this work was validated with the available Node 26.3.0 runtime.

Fixtures cover four synthetic regions, successful detail, queued/failed extraction, missing and ambiguous predecessors, all six classifications, both deadline directions, queued/running/terminal jobs, partial/failed monitor runs, acceptance payloads, pagination, review and errors. All are visibly synthetic and must never be presented as real regulator findings.

The browser import check covers both shared contracts and fixtures. These tests do not establish HTTP availability, real extraction accuracy or monitoring capability. Add endpoint/worker integration tests in the eventual application; keep contract tests as the shared compatibility gate.

## Handoff to paste into your coding agent

> Implement my frontend against the shared Level 1 contract in `src/shared/contracts/index.ts`. First read `docs/API_CONTRACT.md` and `docs/SETHU_INTEGRATION.md`, inspect my existing screens and preserve them. Import the exported Zod schemas and their inferred types; do not invent or duplicate API fields, enum/status values, IDs, routes or response wrappers. Use `API_CONTRACT` for endpoint definitions and `src/shared/fixtures/index.ts` for validated mock data. All HTTP endpoints are currently planned, not implemented in this contract-only checkout. Distinguish 202 acceptance from job/processing success; render failed extraction, missing/ambiguous predecessors, review state and comparison classifications separately. Keep source date-only values intact. Use the documented upload → ingestion → predecessor-link → new-comparison flow. Run `npm run check`. If my unshared UI or an existing backend conflicts, report the smallest adapter change and update the shared contract only in coordination with Gokul. Do not create a second backend or replace my screens.
