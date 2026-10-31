import { z } from 'zod';
import {
  BusinessAreaSchema, SourceDateSchema, SourceEvidenceSchema, ObligationSchema,
  ReferenceRelationSchema, ChangeItemSchema, NonEmptyTextSchema,
} from '../../shared/contracts/index.js';

// Internal model outputs derive from shared schemas. IDs/target relationships are assigned server-side.
export const RequirementStatusSchema = z.enum(['proposed', 'mandatory', 'withdrawn', 'unknown']);
export const DocumentStatusSchema = z.enum(['consultation', 'draft', 'final', 'withdrawn']).nullable();
export const ModelObligationSchema = ObligationSchema.omit({ id: true, publicationId: true }).extend({ requirementStatus: RequirementStatusSchema });
export const ModelReferenceSchema = z.strictObject({
  referenceText: NonEmptyTextSchema,
  referenceNumber: NonEmptyTextSchema.nullable(),
  issuingAuthority: NonEmptyTextSchema.nullable(),
  relation: ReferenceRelationSchema,
  evidence: z.array(SourceEvidenceSchema).min(1),
});
export const ModelExtractionSchema = z.strictObject({
  documentStatus: DocumentStatusSchema,
  statusEvidence: z.array(SourceEvidenceSchema),
  businessAreas: z.array(BusinessAreaSchema),
  effectiveDate: SourceDateSchema.nullable(),
  effectiveDateEvidence: z.array(SourceEvidenceSchema),
  obligations: z.array(ModelObligationSchema).max(200),
  references: z.array(ModelReferenceSchema).max(200),
}).refine(v => v.documentStatus === null || v.statusEvidence.length > 0, 'Document status requires evidence')
  .refine(v => v.effectiveDate === null || v.effectiveDateEvidence.length > 0, 'Effective date requires evidence');
export const ModelComparisonSchema = z.strictObject({
  evidenceComplete: z.boolean(),
  unresolvedReason: NonEmptyTextSchema.nullable(),
  changes: z.array(ChangeItemSchema).max(200),
});
export type ModelExtraction = z.infer<typeof ModelExtractionSchema>;
export type ModelComparison = z.infer<typeof ModelComparisonSchema>;
