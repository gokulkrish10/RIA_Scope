import { z } from 'zod';

export const CONTRACT_VERSION = '1.0.0' as const;
export const IdSchema = z.uuid().regex(/^[0-9a-f-]+$/, 'Use lowercase UUIDs');
export const NonEmptyTextSchema = z.string().min(1).refine(v => v.trim().length > 0, 'Must not be blank');
export const DateOnlySchema = z.iso.date();
export const UtcTimestampSchema = z.iso.datetime({ precision: 3 });
// Source dates retain their precision. Never turn a date-only value into midnight UTC.
export const SourceDateSchema = z.union([DateOnlySchema, UtcTimestampSchema]);
export const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 country code');
export const PublicUrlSchema = z.url({ protocol: /^https?$/ }).refine(value => {
  const url = new URL(value);
  const secretKeys = /^(access_token|token|api_key|apikey|key|signature|x-amz-credential|x-amz-signature)$/i;
  return !url.username && !url.password && ![...url.searchParams.keys()].some(key => secretKeys.test(key));
}, 'Use a public HTTP(S) URL without embedded credentials or credential query parameters');

export const RegionSchema = z.enum(['ksa', 'uae', 'india', 'africa']);
export const BusinessAreaSchema = z.enum(['ai', 'banking', 'lending', 'insurance', 'payments', 'otherBfsi']);
export const PublicationKindSchema = z.enum(['regulation', 'circular', 'amendment', 'consultation', 'guideline', 'other']);
export const ProcessingStateSchema = z.enum(['queued', 'processing', 'succeeded', 'failed']);
export const ReviewStateSchema = z.enum(['pending', 'inReview', 'approved', 'rejected']);
export const RelationshipStateSchema = z.enum(['unchecked', 'notRequired', 'resolved', 'missingPredecessor', 'ambiguous']);
export const ReferenceResolutionSchema = z.enum(['unresolved', 'resolved', 'ambiguous']);
export const ReferenceRelationSchema = z.enum(['cites', 'amends', 'replaces', 'withdraws']);
export const ChangeClassSchema = z.enum([
  'newObligation', 'modifiedObligation', 'withdrawnOrSuperseded',
  'deadlineChanged', 'clarification', 'noMaterialChange',
]);
export const DeadlineDirectionSchema = z.enum(['extended', 'shortened']);
export const ComparisonStateSchema = z.enum(['queued', 'processing', 'succeeded', 'blocked', 'failed']);
export const JobStateSchema = z.enum(['queued', 'running', 'succeeded', 'blocked', 'failed']);
export const JobKindSchema = z.enum(['monitor', 'ingestion', 'comparison']);
export const MonitorOutcomeSchema = z.enum(['succeeded', 'partial', 'failed']);
export const SourceRunStateSchema = z.enum(['succeeded', 'failed']);
export const ErrorCodeSchema = z.enum([
  'validationError', 'notFound', 'conflict', 'payloadTooLarge', 'unsupportedMediaType',
  'unauthorized', 'forbidden', 'rateLimited', 'internalError', 'sourceUnavailable',
  'extractionFailed', 'missingPredecessor', 'ambiguousPredecessor', 'comparisonFailed',
  'resultNotReady', 'jobFailed', 'jobBlocked',
]);
export const ApiErrorDetailSchema = z.strictObject({
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  message: NonEmptyTextSchema,
});
export const ErrorInfoSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: NonEmptyTextSchema,
  retryable: z.boolean(),
  details: z.array(ApiErrorDetailSchema),
});
export const ApiErrorSchema = z.strictObject({
  error: ErrorInfoSchema,
  requestId: IdSchema,
  timestamp: UtcTimestampSchema,
});

export const PaginationQuerySchema = z.strictObject({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});
export function paginatedResponseSchema<T extends z.ZodType>(itemSchema: T) {
  return z.strictObject({
    items: z.array(itemSchema),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
    total: z.number().int().nonnegative(),
    hasNextPage: z.boolean(),
  }).superRefine((value, ctx) => {
    const expectedLength = Math.min(value.pageSize, Math.max(0, value.total - (value.page - 1) * value.pageSize));
    if (value.items.length !== expectedLength) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Items must match page, pageSize and total' });
    if (value.hasNextPage !== (value.page * value.pageSize < value.total)) ctx.addIssue({ code: 'custom', path: ['hasNextPage'], message: 'Inconsistent pagination' });
  });
}

export type Id = z.infer<typeof IdSchema>;
export type SourceDate = z.infer<typeof SourceDateSchema>;
export type BusinessArea = z.infer<typeof BusinessAreaSchema>;
export type ChangeClass = z.infer<typeof ChangeClassSchema>;
export type ProcessingState = z.infer<typeof ProcessingStateSchema>;
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export type RelationshipState = z.infer<typeof RelationshipStateSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;
export type PaginatedResponse<T> = z.infer<ReturnType<typeof paginatedResponseSchema<z.ZodType<T>>>>;
