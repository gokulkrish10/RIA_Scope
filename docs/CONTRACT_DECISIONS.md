# Scope, inspection and coordination decisions

Inspected on 2026-10-31:

- Working directory: `/Users/sst/Downloads/GokulHackathons/Azentio_Onsite/RIA`.
- Git was clean and empty, on unborn `master`, with no commits or remote. No screens, backend, package manifest, contracts or repository-specific instructions existed in the checkout. No existing work was overwritten.
- Applicable parent/user instruction: call `headroom_compress` before reasoning over large file contents, command output, logs or search results. The supplied brief was passed through that tool before deriving the contract.
- Brief: user attachment `Pasted text.txt`, headed “Regulatory Change Impact Agent”, Level 1 “Monitor, Discover and Understand Regulatory Changes”. This is the only supplied release brief; no separate release/version marker was present. The broader problem statement's internal-policy recommendations are outside this contract's Level 1 scope.
- Local Git author identity was configured. The task authorizes a local commit only. No remote push, shared-branch merge or deployment is part of this work.

## Brief-to-contract coverage

| Released Level 1 requirement | Contract surface |
| --- | --- |
| Four geographic regions and configurable sources | SourceConfig; four synthetic fixtures (SA, AE, IN, ZA); interval and enabled updates |
| Monitoring and duplicate distinction | MonitorRequest, per-source counts, discovered publications and ingestion job IDs |
| Manual PDF/DOCX/text ingestion | Multipart `file` + `metadata`, upload limits, upload acceptance and ingestion jobs |
| Issuer, jurisdiction and separate dates | DiscoveredPublication and UploadMetadata |
| Structured obligations, applicability and deadlines | Obligation and source-version evidence |
| References to earlier circulars | RegulatoryReference resolved/unresolved/ambiguous variants |
| Six classes and side-by-side clauses | ChangeItem; explicit deadlineDirection and before/after evidence |
| Searchable dashboard | PublicationSearchQuery and PublicationSummary |
| Human review and unresolved relationships | ReviewRecord, ReviewUpdateRequest and relationshipState |
| Missing predecessor recovery | Upload, poll ingestion, link predecessor, poll new comparison job |

## Decisions to coordinate before implementation

These defaults make independent implementation possible now; they are not blockers for using the fixtures. Change the schemas, documentation and fixtures together if the team chooses differently.

1. **API base and IDs:** `/api/v1`, lowercase UUID strings, camelCase JSON and enum values. No pre-existing convention was available. Keep these names when adding framework routes; do not introduce snake_case response fields or numeric database IDs.
2. **Countries and regulators:** South Africa (`ZA`) is a synthetic fourth-region example, not a selected production source. Agree the actual African country and at least four official public source URLs. Source entries provide regulator IDs/names for UI filters; there is no regulator-management endpoint in Level 1. Backend must validate country membership and regulator/source consistency against its configured catalog.
3. **Limits:** 20 MiB per file, 16 KiB metadata, 21 MiB entire multipart request; monitoring interval 15–43,200 minutes; default page size 20, maximum 100. Adjust shared constants/schemas first if infrastructure requires different limits.
4. **Review identity and authorization:** reviewer identity comes from server authentication; it is never supplied by the client. Authentication infrastructure is not implemented here. Review updates use the review record's `updatedAt` as an optimistic concurrency token. Approval requires extraction success and resolved/notRequired predecessor relationships.
5. **Comparison scope:** one immutable current/predecessor version pair per comparison. Multiple predecessor references are resolved individually. A document without predecessor references can produce a baseline comparison of new obligations; no obligations and no predecessor yields 409, not fabricated `noMaterialChange`. Multi-document aggregate comparisons are outside Level 1.
6. **Async completion:** monitoring only discovers/deduplicates and schedules ingestion. It does not wait for extraction. A completed monitor job may have `outcome: partial`; consumers inspect source results and ingestion jobs. A missing predecessor blocks a comparison and requires a new job after recovery.
7. **Source date precision:** null means unknown, date-only remains a date, known instants normalize to UTC milliseconds. Ambiguous source timezone must be resolved before a time is published; retain only the known date if time is uncertain. Never fabricate an effective date.

There are no existing API conflicts to migrate. If Sethu has unshared code elsewhere, compare its adapters with this contract before wiring it in; the smallest coordinated change is to map existing UI/server internals at their API boundary. Do not rewrite screens or create a parallel server. Integration with unprovided code cannot be verified here.

Zod was compatible because no conflicting dependencies existed. The lockfile pins Zod and the development toolchain. Schema construction follows the [official Zod API](https://zod.dev/api); only Zod is a runtime dependency of the shared layer.
