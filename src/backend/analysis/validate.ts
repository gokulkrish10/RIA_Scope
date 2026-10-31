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
  if (!result.success) throw new BackendError('comparisonFailed', `Model comparison output violates the shared change schemas (${result.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'root'}: ${issue.code}: ${issue.message}`).join('; ')}).`, 422, true);
  if (!result.data.evidenceComplete || result.data.unresolvedReason !== null || !result.data.changes.length) throw new BackendError('comparisonFailed', 'Comparison unresolved: supported clause evidence is insufficient. Review source documents; this is not noMaterialChange.', 422);
  const changes = result.data.changes.map(change => {
    const after = validateEvidence(change.after, current, 'comparisonFailed');
    if (change.classification === 'deadlineChanged' && !/\b(?:extend(?:ed|s|ing)?|shorten(?:ed|s|ing)?|postpon(?:e|ed|es|ing)|deferr?(?:ed|al)?|brought forward|instead of|in place of|revis(?:ed|ion) of (?:the )?(?:deadline|time ?limit))\b/i.test(after.excerpt)) {
      throw new BackendError('comparisonFailed', `The deadlineChanged item at current locator "${after.locator}" was rejected. A deadline change needs an explicit extension/shortening or replacement of the same deadline in the current cited clause. Different commencement dates alone are insufficient. Remove this unsupported deadline interpretation or propose a supported non-deadline classification with matching old/new clauses. Never force all six classes into a comparison.`, 422, true);
    }
    let before = change.before;
    if (change.before) {
      if (!previous) throw new BackendError('comparisonFailed', 'A historical clause was proposed without a verified predecessor.', 422, true);
      before = validateEvidence(change.before, previous, 'comparisonFailed');
      const coolingOff = (text: string) => /cooling[ -]?off|look[ -]?up period/i.test(text);
      if (coolingOff(before.excerpt) && /validity period/i.test(after.excerpt) && !coolingOff(after.excerpt)) {
        throw new BackendError('comparisonFailed', 'The proposed pair compares a post-contract cooling-off/cancellation duty with a pre-contract offer validity period. They are different obligations. Use the explicit current amendment to the cooling-off clause if supplied, otherwise omit this unsupported pair. Do not reword the same mismatched pair.', 422, true);
      }
    }
    if (change.classification === 'noMaterialChange' && result.data.changes.length !== 1) throw new BackendError('comparisonFailed', 'noMaterialChange cannot coexist with material changes.', 422, true);
    const bound = { ...change, before, after };
    return ChangeItemSchema.parse({ ...bound, id: stableId(`${current.versionId}:${previous?.versionId ?? 'baseline'}`, { ...bound, id: undefined }) });
  });
  if (new Set(changes.map(c => c.id)).size !== changes.length) throw new BackendError('comparisonFailed', 'Model returned duplicate change items.', 422, true);
  return changes;
}
