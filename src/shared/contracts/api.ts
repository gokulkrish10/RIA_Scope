import { z } from 'zod';
import { ApiErrorSchema, BusinessAreaSchema, ChangeClassSchema, CountryCodeSchema, DateOnlySchema, IdSchema, NonEmptyTextSchema, PaginationQuerySchema, ProcessingStateSchema, RelationshipStateSchema, ReviewStateSchema } from './common.js';
import { ComparisonAcceptedResponseSchema, JobStatusSchema, MonitorAcceptedResponseSchema, MonitorRequestSchema, MonitorRunResultSchema, UploadAcceptedResponseSchema } from './jobs.js';
import { ComparisonRequestSchema, ComparisonSchema, PredecessorLinkRequestSchema } from './comparisons.js';
import { PublicationDetailSchema, PublicationListResponseSchema, PublicationObligationsResponseSchema, ReviewRecordSchema, ReviewUpdateRequestSchema, UploadMetadataSchema } from './publications.js';
import { SourceConfigSchema, SourceListResponseSchema, SourceUpdateRequestSchema } from './sources.js';

const uniqueFilter = <T extends z.ZodType>(schema: T) => z.array(schema).min(1).max(100).refine(v => new Set(v).size === v.length, 'Filter values must be unique').optional();
export const PublicationSearchQuerySchema = PaginationQuerySchema.extend({
  q: NonEmptyTextSchema.max(200).optional(),
  country: uniqueFilter(CountryCodeSchema),
  regulatorId: uniqueFilter(IdSchema),
  businessArea: uniqueFilter(BusinessAreaSchema),
  changeClass: uniqueFilter(ChangeClassSchema),
  publicationDateFrom: DateOnlySchema.optional(),
  publicationDateTo: DateOnlySchema.optional(),
  processingState: ProcessingStateSchema.optional(),
  reviewState: ReviewStateSchema.optional(),
  relationshipState: RelationshipStateSchema.optional(),
}).refine(v => !v.publicationDateFrom || !v.publicationDateTo || v.publicationDateFrom <= v.publicationDateTo, 'publicationDateFrom must not follow publicationDateTo');
const integerQuerySchema = z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().safe());
const repeatedFilterKeys = new Set(['country', 'regulatorId', 'businessArea', 'changeClass']);
function decodeSearchParams(params: URLSearchParams, allowFilters: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    if (allowFilters && repeatedFilterKeys.has(key)) result[key] = values;
    else if (values.length !== 1) throw new z.ZodError([{ code: 'custom', path: [key], message: 'Scalar parameters must appear once' }]);
    else if (key === 'page' || key === 'pageSize') result[key] = integerQuerySchema.parse(values[0]);
    else result[key] = values[0];
  }
  return result;
}
export function parsePublicationSearchParams(params: URLSearchParams) {
  return PublicationSearchQuerySchema.parse(decodeSearchParams(params, true));
}
export function parsePaginationSearchParams(params: URLSearchParams) {
  return PaginationQuerySchema.parse(decodeSearchParams(params, false));
}
export const SourcePathSchema = z.strictObject({ sourceId: IdSchema });
export const PublicationPathSchema = z.strictObject({ publicationId: IdSchema });
export const JobPathSchema = z.strictObject({ jobId: IdSchema });
export const ComparisonPathSchema = z.strictObject({ comparisonId: IdSchema });
export const MULTIPART_FIELDS = { file: 'file', metadata: 'metadata' } as const;

// Transport specification only. These entries do not register routes or implement a server.
const commonErrors = { 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema, 429: ApiErrorSchema, 500: ApiErrorSchema };
export const API_CONTRACT = {
  listSources: { method: 'GET', path: '/api/v1/sources', query: PaginationQuerySchema, responses: { ...commonErrors, 200: SourceListResponseSchema } },
  updateSource: { method: 'PATCH', path: '/api/v1/sources/:sourceId', params: SourcePathSchema, body: SourceUpdateRequestSchema, responses: { ...commonErrors, 200: SourceConfigSchema, 404: ApiErrorSchema, 409: ApiErrorSchema } },
  triggerMonitor: { method: 'POST', path: '/api/v1/monitor-runs', body: MonitorRequestSchema, responses: { ...commonErrors, 202: MonitorAcceptedResponseSchema, 404: ApiErrorSchema, 409: ApiErrorSchema } },
  readJob: { method: 'GET', path: '/api/v1/jobs/:jobId', params: JobPathSchema, responses: { ...commonErrors, 200: JobStatusSchema, 404: ApiErrorSchema } },
  readMonitorResult: { method: 'GET', path: '/api/v1/monitor-runs/:jobId/result', params: JobPathSchema, responses: { ...commonErrors, 200: MonitorRunResultSchema, 404: ApiErrorSchema, 409: ApiErrorSchema } },
  uploadDocument: { method: 'POST', path: '/api/v1/publications/upload', contentType: 'multipart/form-data', metadata: UploadMetadataSchema, fields: MULTIPART_FIELDS, responses: { ...commonErrors, 202: UploadAcceptedResponseSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 413: ApiErrorSchema, 415: ApiErrorSchema, 422: ApiErrorSchema } },
  searchPublications: { method: 'GET', path: '/api/v1/publications', query: PublicationSearchQuerySchema, responses: { ...commonErrors, 200: PublicationListResponseSchema } },
  readPublication: { method: 'GET', path: '/api/v1/publications/:publicationId', params: PublicationPathSchema, responses: { ...commonErrors, 200: PublicationDetailSchema, 404: ApiErrorSchema } },
  readObligations: { method: 'GET', path: '/api/v1/publications/:publicationId/obligations', params: PublicationPathSchema, responses: { ...commonErrors, 200: PublicationObligationsResponseSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 422: ApiErrorSchema } },
  requestComparison: { method: 'POST', path: '/api/v1/publications/:publicationId/comparisons', params: PublicationPathSchema, body: ComparisonRequestSchema, responses: { ...commonErrors, 202: ComparisonAcceptedResponseSchema, 404: ApiErrorSchema, 409: ApiErrorSchema } },
  readComparison: { method: 'GET', path: '/api/v1/comparisons/:comparisonId', params: ComparisonPathSchema, responses: { ...commonErrors, 200: ComparisonSchema, 404: ApiErrorSchema } },
  linkPredecessor: { method: 'POST', path: '/api/v1/publications/:publicationId/predecessor', params: PublicationPathSchema, body: PredecessorLinkRequestSchema, responses: { ...commonErrors, 202: ComparisonAcceptedResponseSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 422: ApiErrorSchema } },
  updateReview: { method: 'PATCH', path: '/api/v1/publications/:publicationId/review', params: PublicationPathSchema, body: ReviewUpdateRequestSchema, responses: { ...commonErrors, 200: ReviewRecordSchema, 404: ApiErrorSchema, 409: ApiErrorSchema } },
} as const;
export type PublicationSearchQuery = z.infer<typeof PublicationSearchQuerySchema>;
