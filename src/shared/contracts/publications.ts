import { z } from 'zod';
import {
  BusinessAreaSchema, ChangeClassSchema, CountryCodeSchema, ErrorInfoSchema, IdSchema,
  NonEmptyTextSchema, ProcessingStateSchema, PublicUrlSchema, PublicationKindSchema,
  ReferenceRelationSchema, ReferenceResolutionSchema, RelationshipStateSchema,
  ReviewStateSchema, SourceDateSchema, UtcTimestampSchema, paginatedResponseSchema,
} from './common.js';

export const UPLOAD_LIMITS = { maxFileBytes: 20 * 1024 * 1024, maxMetadataBytes: 16 * 1024, maxRequestBytes: 21 * 1024 * 1024, maxFiles: 1 } as const;
export const DocumentMediaTypeSchema = z.enum([
  'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/html',
]);
export const IngestionMethodSchema = z.enum(['monitor', 'upload']);
export const DocumentVersionSchema = z.strictObject({
  id: IdSchema,
  documentId: IdSchema,
  publicationId: IdSchema,
  versionNumber: z.number().int().positive(),
  fileName: NonEmptyTextSchema.max(255).refine(v => !/[\\/\u0000]/.test(v), 'Basename only'),
  mediaType: DocumentMediaTypeSchema,
  sizeBytes: z.number().int().positive(),
  ingestionMethod: IngestionMethodSchema,
  sourceUrl: PublicUrlSchema.nullable(),
  createdAt: UtcTimestampSchema,
  extractedAt: UtcTimestampSchema.nullable(),
  processingState: ProcessingStateSchema,
  processingError: ErrorInfoSchema.nullable(),
}).superRefine((v, ctx) => {
  if ((v.processingState === 'failed') !== (v.processingError !== null)) ctx.addIssue({ code: 'custom', path: ['processingError'], message: 'Only failed processing has an error' });
  if ((v.processingState === 'succeeded') !== (v.extractedAt !== null)) ctx.addIssue({ code: 'custom', path: ['extractedAt'], message: 'Only successful extraction has extractedAt' });
  if (v.processingError && v.processingError.code !== 'extractionFailed') ctx.addIssue({ code: 'custom', path: ['processingError', 'code'], message: 'Use extractionFailed' });
});
export const SourceEvidenceSchema = z.strictObject({
  documentId: IdSchema,
  versionId: IdSchema,
  locator: NonEmptyTextSchema.max(500),
  pageNumber: z.number().int().positive().optional(),
  excerpt: NonEmptyTextSchema.max(20_000),
});
export const ObligationSchema = z.strictObject({
  id: IdSchema,
  publicationId: IdSchema,
  text: NonEmptyTextSchema,
  businessAreas: z.array(BusinessAreaSchema).min(1),
  applicableEntities: z.array(NonEmptyTextSchema),
  departments: z.array(NonEmptyTextSchema),
  regulatedActivities: z.array(NonEmptyTextSchema),
  effectiveDate: SourceDateSchema.nullable(),
  complianceDeadline: SourceDateSchema.nullable(),
  evidence: z.array(SourceEvidenceSchema).min(1),
});
const referenceFields = {
  id: IdSchema,
  referenceText: NonEmptyTextSchema,
  referenceNumber: NonEmptyTextSchema.nullable(),
  relation: ReferenceRelationSchema,
  evidence: z.array(SourceEvidenceSchema).min(1),
};
export const RegulatoryReferenceSchema = z.discriminatedUnion('resolution', [
  z.strictObject({ ...referenceFields, resolution: z.literal(ReferenceResolutionSchema.enum.resolved), targetPublicationId: IdSchema, targetVersionId: IdSchema }),
  z.strictObject({ ...referenceFields, resolution: z.literal(ReferenceResolutionSchema.enum.unresolved), reason: NonEmptyTextSchema }),
  z.strictObject({ ...referenceFields, resolution: z.literal(ReferenceResolutionSchema.enum.ambiguous), reason: NonEmptyTextSchema, candidatePublicationIds: z.array(IdSchema).min(2).refine(ids => new Set(ids).size === ids.length, 'Candidates must be distinct') }),
]);
export const DiscoveredPublicationSchema = z.strictObject({
  id: IdSchema,
  sourceId: IdSchema.nullable(),
  title: NonEmptyTextSchema.max(1000),
  country: CountryCodeSchema,
  regulatorId: IdSchema,
  regulatorName: NonEmptyTextSchema.max(200),
  kind: PublicationKindSchema,
  referenceNumber: NonEmptyTextSchema.nullable(),
  publicationDate: SourceDateSchema.nullable(),
  effectiveDate: SourceDateSchema.nullable(),
  discoveredAt: UtcTimestampSchema,
  sourceUrl: PublicUrlSchema.nullable(),
});
export const ReviewRecordSchema = z.strictObject({
  state: ReviewStateSchema,
  note: NonEmptyTextSchema.max(4000).nullable(),
  reviewedBy: IdSchema.nullable(),
  updatedAt: UtcTimestampSchema,
}).refine(v => v.state === 'pending' || v.reviewedBy !== null, 'An active/completed review requires an actor')
  .refine(v => v.state !== 'rejected' || v.note !== null, 'Rejection requires a note');
export const PublicationSummarySchema = DiscoveredPublicationSchema.extend({
  documentId: IdSchema,
  currentVersionId: IdSchema,
  businessAreas: z.array(BusinessAreaSchema),
  processingState: ProcessingStateSchema,
  processingError: ErrorInfoSchema.nullable(),
  review: ReviewRecordSchema,
  relationshipState: RelationshipStateSchema,
  changeClasses: z.array(ChangeClassSchema).refine(v => new Set(v).size === v.length, 'Change classes must be unique'),
  latestComparisonId: IdSchema.nullable(),
  updatedAt: UtcTimestampSchema,
}).superRefine((v, ctx) => {
  if ((v.processingState === 'failed') !== (v.processingError !== null)) ctx.addIssue({ code: 'custom', path: ['processingError'], message: 'Only failed processing has an error' });
  if (v.processingError && v.processingError.code !== 'extractionFailed') ctx.addIssue({ code: 'custom', path: ['processingError', 'code'], message: 'Use extractionFailed' });
  if (v.changeClasses.length && (v.latestComparisonId === null || v.processingState !== 'succeeded' || !['resolved', 'notRequired'].includes(v.relationshipState))) ctx.addIssue({ code: 'custom', path: ['changeClasses'], message: 'Classifications require a successful, resolved comparison' });
});
export const PublicationDetailSchema = PublicationSummarySchema.safeExtend({
  summary: NonEmptyTextSchema.nullable(),
  versions: z.array(DocumentVersionSchema).min(1),
  obligations: z.array(ObligationSchema),
  references: z.array(RegulatoryReferenceSchema),
}).superRefine((v, ctx) => {
  const current = v.versions.find(version => version.id === v.currentVersionId);
  if (!current || current.processingState !== v.processingState) ctx.addIssue({ code: 'custom', path: ['currentVersionId'], message: 'Current version must exist and match processing state' });
  if (v.versions.some(version => version.publicationId !== v.id || version.documentId !== v.documentId)) ctx.addIssue({ code: 'custom', path: ['versions'], message: 'Versions must belong to this publication and document' });
  if (new Set(v.versions.map(version => version.id)).size !== v.versions.length || new Set(v.versions.map(version => version.versionNumber)).size !== v.versions.length) ctx.addIssue({ code: 'custom', path: ['versions'], message: 'Version IDs and numbers must be unique' });
  if (v.obligations.some(o => o.publicationId !== v.id)) ctx.addIssue({ code: 'custom', path: ['obligations'], message: 'Obligations must belong to this publication' });
  const evidence = [...v.obligations.flatMap(o => o.evidence), ...v.references.flatMap(r => r.evidence)];
  if (evidence.some(e => e.documentId !== v.documentId || e.versionId !== v.currentVersionId)) ctx.addIssue({ code: 'custom', path: ['obligations'], message: 'Extraction evidence must cite the current document version' });
  if (v.processingState !== 'succeeded' && (v.obligations.length || v.references.length || v.summary !== null)) ctx.addIssue({ code: 'custom', path: ['processingState'], message: 'Only successful extraction can expose extracted content' });
  const predecessorRefs = v.references.filter(r => r.relation !== 'cites');
  if (v.relationshipState === 'resolved' && (!predecessorRefs.length || predecessorRefs.some(r => r.resolution !== 'resolved'))) ctx.addIssue({ code: 'custom', path: ['relationshipState'], message: 'All predecessor references must be resolved' });
  if (v.relationshipState === 'notRequired' && predecessorRefs.length) ctx.addIssue({ code: 'custom', path: ['relationshipState'], message: 'notRequired cannot have predecessor references' });
  if (v.relationshipState === 'missingPredecessor' && !predecessorRefs.some(r => r.resolution === 'unresolved')) ctx.addIssue({ code: 'custom', path: ['references'], message: 'Missing predecessor requires an unresolved predecessor reference' });
  if (v.relationshipState === 'ambiguous' && !predecessorRefs.some(r => r.resolution === 'ambiguous')) ctx.addIssue({ code: 'custom', path: ['references'], message: 'Ambiguous relationship requires candidate references' });
});
export const ReviewUpdateRequestSchema = z.strictObject({
  state: ReviewStateSchema,
  note: NonEmptyTextSchema.max(4000).nullable(),
  expectedUpdatedAt: UtcTimestampSchema,
}).refine(v => v.state !== 'rejected' || v.note !== null, 'Rejection requires a note');

export const UploadMetadataSchema = z.strictObject({
  title: NonEmptyTextSchema.max(1000),
  country: CountryCodeSchema,
  regulatorId: IdSchema,
  kind: PublicationKindSchema,
  referenceNumber: NonEmptyTextSchema.nullable(),
  publicationDate: SourceDateSchema.nullable(),
  effectiveDate: SourceDateSchema.nullable(),
  sourceId: IdSchema.nullable(),
});
// Metadata-only validation; adapters must independently inspect actual bytes and MIME signatures.
export const UploadFileDescriptorSchema = z.strictObject({
  fileName: DocumentVersionSchema.shape.fileName,
  mediaType: DocumentMediaTypeSchema.exclude(['text/html']),
  sizeBytes: z.number().int().min(1).max(UPLOAD_LIMITS.maxFileBytes),
}).refine(v => {
  const extensions = { 'application/pdf': '.pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'text/plain': '.txt' };
  return v.fileName.toLowerCase().endsWith(extensions[v.mediaType]);
}, 'Filename extension must match mediaType');
export const PublicationListResponseSchema = paginatedResponseSchema(PublicationSummarySchema);
export const PublicationObligationsResponseSchema = z.strictObject({
  publicationId: IdSchema,
  versionId: IdSchema,
  processingState: z.literal(ProcessingStateSchema.enum.succeeded),
  obligations: z.array(ObligationSchema),
}).refine(v => v.obligations.every(o => o.publicationId === v.publicationId && o.evidence.every(e => e.versionId === v.versionId)), 'Obligations and evidence must match the response publication/version');

export type DiscoveredPublication = z.infer<typeof DiscoveredPublicationSchema>;
export type PublicationSummary = z.infer<typeof PublicationSummarySchema>;
export type PublicationDetail = z.infer<typeof PublicationDetailSchema>;
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;
export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;
export type Obligation = z.infer<typeof ObligationSchema>;
export type RegulatoryReference = z.infer<typeof RegulatoryReferenceSchema>;
export type ReviewUpdateRequest = z.infer<typeof ReviewUpdateRequestSchema>;
export type UploadMetadata = z.infer<typeof UploadMetadataSchema>;
