import {
  ObligationSchema, RegulatoryReferenceSchema, ChangeItemSchema,
  type Obligation, type RegulatoryReference, type ChangeItem,
} from '../../shared/contracts/index.js';
import { ModelExtractionSchema, ModelComparisonSchema, type ModelExtraction } from './schemas.js';
import { stableId, validateEvidence, type VersionText } from './evidence.js';
import { BackendError } from '../errors.js';

export function validateExtraction(raw: unknown, version: VersionText): ModelExtraction {
  const result = ModelExtractionSchema.safeParse(raw);
  if (!result.success) throw new BackendError('extractionFailed', `Structured model output violates the shared extraction schemas (${result.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'root'}: ${issue.code}`).join('; ')}); no result was accepted.`, 422, true);
  const value = result.data;
  const bind = (e: typeof value.statusEvidence[number]) => validateEvidence(e, version);
  value.statusEvidence = value.statusEvidence.map(bind);
  value.effectiveDateEvidence = value.effectiveDateEvidence.map(bind);
  value.obligations = value.obligations.map(o => ({ ...o, evidence: o.evidence.map(bind) }));
  value.references = value.references.map(r => ({ ...r, evidence: r.evidence.map(bind) }));
  return value;
}
export function publicObligations(value: ModelExtraction, version: VersionText, consultation: boolean): Obligation[] {
  return value.obligations.map(({ requirementStatus, ...obligation }) => {
    const proposed = consultation || value.documentStatus === 'consultation' || value.documentStatus === 'draft' || requirementStatus === 'proposed';
    const prefix = proposed ? 'Proposed requirement: ' : requirementStatus === 'withdrawn' ? 'Withdrawn requirement: ' : requirementStatus === 'unknown' ? 'Status unconfirmed: ' : '';
    return ObligationSchema.parse({ ...obligation, id: stableId(version.versionId, obligation), publicationId: version.publicationId, text: prefix + obligation.text });
  });
}
export function unresolvedReferences(value: ModelExtraction, version: VersionText): RegulatoryReference[] {
  return value.references.map(({ issuingAuthority: _, ...reference }) => RegulatoryReferenceSchema.parse({ ...reference, id: stableId(version.versionId, reference), resolution: 'unresolved', reason: 'No verified predecessor match has been established.' }));
}
export function validateComparison(raw: unknown, current: VersionText, previous: VersionText | null): ChangeItem[] {
  const result = ModelComparisonSchema.safeParse(raw);
  if (!result.success) throw new BackendError('comparisonFailed', 'Model comparison output violates the shared change schemas.', 422, true);
  if (!result.data.evidenceComplete || result.data.unresolvedReason !== null || !result.data.changes.length) throw new BackendError('comparisonFailed', 'Comparison unresolved: supported clause evidence is insufficient. Review source documents; this is not noMaterialChange.', 422);
  const changes = result.data.changes.map(change => {
    const after = validateEvidence(change.after, current, 'comparisonFailed');
    let before = change.before;
    if (change.before) {
      if (!previous) throw new BackendError('comparisonFailed', 'A historical clause was proposed without a verified predecessor.', 422, true);
      before = validateEvidence(change.before, previous, 'comparisonFailed');
    }
    if (change.classification === 'noMaterialChange' && result.data.changes.length !== 1) throw new BackendError('comparisonFailed', 'noMaterialChange cannot coexist with material changes.', 422, true);
    const bound = { ...change, before, after };
    return ChangeItemSchema.parse({ ...bound, id: stableId(`${current.versionId}:${previous?.versionId ?? 'baseline'}`, { ...bound, id: undefined }) });
  });
  if (new Set(changes.map(c => c.id)).size !== changes.length) throw new BackendError('comparisonFailed', 'Model returned duplicate change items.', 422, true);
  return changes;
}
