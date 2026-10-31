import { z } from 'zod';
import { ChangeClassSchema, ComparisonStateSchema, DeadlineDirectionSchema, ErrorInfoSchema, IdSchema, NonEmptyTextSchema, SourceDateSchema, UtcTimestampSchema } from './common.js';
import { SourceEvidenceSchema } from './publications.js';

const changeFields = { id: IdSchema, explanation: NonEmptyTextSchema };
const pairedClauses = { before: SourceEvidenceSchema, after: SourceEvidenceSchema };
export const ChangeItemSchema = z.discriminatedUnion('classification', [
  z.strictObject({ ...changeFields, classification: z.literal(ChangeClassSchema.enum.newObligation), before: z.null(), after: SourceEvidenceSchema }),
  z.strictObject({ ...changeFields, ...pairedClauses, classification: z.literal(ChangeClassSchema.enum.modifiedObligation) }),
  z.strictObject({ ...changeFields, ...pairedClauses, classification: z.literal(ChangeClassSchema.enum.withdrawnOrSuperseded) }),
  z.strictObject({
    ...changeFields, ...pairedClauses, classification: z.literal(ChangeClassSchema.enum.deadlineChanged),
    deadlineDirection: DeadlineDirectionSchema,
    previousDeadline: SourceDateSchema,
    updatedDeadline: SourceDateSchema,
  }).superRefine((v, ctx) => {
    const samePrecision = (v.previousDeadline.length === 10) === (v.updatedDeadline.length === 10);
    const ordered = v.deadlineDirection === 'extended' ? v.updatedDeadline > v.previousDeadline : v.updatedDeadline < v.previousDeadline;
    if (!samePrecision || !ordered) ctx.addIssue({ code: 'custom', path: ['updatedDeadline'], message: 'Deadlines must have matching precision and agree with deadlineDirection' });
  }),
  z.strictObject({ ...changeFields, ...pairedClauses, classification: z.literal(ChangeClassSchema.enum.clarification) }),
  z.strictObject({ ...changeFields, ...pairedClauses, classification: z.literal(ChangeClassSchema.enum.noMaterialChange) }),
]);
const comparisonFields = {
  id: IdSchema,
  publicationId: IdSchema,
  currentDocumentId: IdSchema,
  currentVersionId: IdSchema,
  predecessorPublicationId: IdSchema.nullable(),
  predecessorDocumentId: IdSchema.nullable(),
  predecessorVersionId: IdSchema.nullable(),
  createdAt: UtcTimestampSchema,
};
const unfinishedFields = { ...comparisonFields, completedAt: z.null(), changes: z.array(ChangeItemSchema).length(0), issue: z.null() };
export const ComparisonSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...unfinishedFields, state: z.literal(ComparisonStateSchema.enum.queued) }),
  z.strictObject({ ...unfinishedFields, state: z.literal(ComparisonStateSchema.enum.processing) }),
  z.strictObject({ ...comparisonFields, state: z.literal(ComparisonStateSchema.enum.succeeded), completedAt: UtcTimestampSchema, changes: z.array(ChangeItemSchema).min(1), issue: z.null() }),
  z.strictObject({ ...comparisonFields, state: z.literal(ComparisonStateSchema.enum.blocked), completedAt: UtcTimestampSchema, changes: z.array(ChangeItemSchema).length(0), issue: ErrorInfoSchema, unresolvedReferenceIds: z.array(IdSchema).min(1) }),
  z.strictObject({ ...comparisonFields, state: z.literal(ComparisonStateSchema.enum.failed), completedAt: UtcTimestampSchema, changes: z.array(ChangeItemSchema).length(0), issue: ErrorInfoSchema }),
]).superRefine((v, ctx) => {
  const predecessorIds = [v.predecessorPublicationId, v.predecessorDocumentId, v.predecessorVersionId];
  if (!predecessorIds.every(id => id === null) && !predecessorIds.every(id => id !== null)) ctx.addIssue({ code: 'custom', path: ['predecessorVersionId'], message: 'All predecessor IDs must be supplied together' });
  if (v.predecessorPublicationId === v.publicationId || v.predecessorVersionId === v.currentVersionId) ctx.addIssue({ code: 'custom', path: ['predecessorPublicationId'], message: 'A publication cannot be its own predecessor' });
  if (v.completedAt !== null && v.completedAt < v.createdAt) ctx.addIssue({ code: 'custom', path: ['completedAt'], message: 'Completion cannot precede creation' });
  if (v.state === 'blocked' && (!['missingPredecessor', 'ambiguousPredecessor'].includes(v.issue.code) || v.predecessorVersionId !== null)) ctx.addIssue({ code: 'custom', path: ['issue'], message: 'Blocked comparisons require unresolved predecessor issue and null predecessor IDs' });
  if (v.state === 'failed' && !['extractionFailed', 'comparisonFailed'].includes(v.issue.code)) ctx.addIssue({ code: 'custom', path: ['issue'], message: 'Failed comparison requires extractionFailed or comparisonFailed' });
  if (v.changes.some(c => c.classification === 'noMaterialChange') && v.changes.length !== 1) ctx.addIssue({ code: 'custom', path: ['changes'], message: 'noMaterialChange must be the sole change' });
  v.changes.forEach((c, index) => {
    if (c.after.documentId !== v.currentDocumentId || c.after.versionId !== v.currentVersionId) ctx.addIssue({ code: 'custom', path: ['changes', index, 'after'], message: 'After evidence must cite the current version' });
    if (c.before && (c.before.documentId !== v.predecessorDocumentId || c.before.versionId !== v.predecessorVersionId)) ctx.addIssue({ code: 'custom', path: ['changes', index, 'before'], message: 'Before evidence must cite the predecessor version' });
  });
});
export const ComparisonRequestSchema = z.strictObject({
  currentVersionId: IdSchema,
  predecessorVersionId: IdSchema.nullable(),
});
export const PredecessorLinkRequestSchema = z.strictObject({
  referenceId: IdSchema,
  currentVersionId: IdSchema,
  predecessorPublicationId: IdSchema,
  predecessorVersionId: IdSchema,
}).refine(v => v.currentVersionId !== v.predecessorVersionId, 'Cannot compare a version with itself');
export type Comparison = z.infer<typeof ComparisonSchema>;
export type ChangeItem = z.infer<typeof ChangeItemSchema>;
export type ComparisonRequest = z.infer<typeof ComparisonRequestSchema>;
export type PredecessorLinkRequest = z.infer<typeof PredecessorLinkRequestSchema>;
