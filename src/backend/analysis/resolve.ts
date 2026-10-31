import { RegulatoryReferenceSchema, type RegulatoryReference, type RelationshipState } from '../../shared/contracts/index.js';
import type { ModelExtraction } from './schemas.js';
import { stableId, type VersionText } from './evidence.js';

export interface ReferenceCandidate { publicationId: string; versionId: string; regulatorId: string; regulatorName: string; referenceNumber: string | null }
export const normalizeReference = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const normalizeAuthority = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
export function resolveReferences(extraction: ModelExtraction, version: VersionText, candidates: ReferenceCandidate[]): RegulatoryReference[] {
  return extraction.references.map(({ issuingAuthority, ...reference }) => {
    const id = stableId(version.versionId, reference);
    const base = { ...reference, id };
    if (!reference.referenceNumber || !issuingAuthority) return RegulatoryReferenceSchema.parse({ ...base, resolution: 'unresolved', reason: 'An explicit reference number and issuing authority are required; no similar document was substituted.' });
    const referenceNumber = normalizeReference(reference.referenceNumber);
    if (!reference.evidence.some(e => normalizeReference(e.excerpt).includes(referenceNumber))) return RegulatoryReferenceSchema.parse({ ...base, resolution: 'unresolved', reason: 'The proposed reference number is not present in its supporting excerpt.' });
    if (!reference.evidence.some(e => normalizeAuthority(e.excerpt).includes(normalizeAuthority(issuingAuthority)))) return RegulatoryReferenceSchema.parse({ ...base, resolution: 'unresolved', reason: 'The proposed issuing authority is not explicit in the supporting excerpt. Human verification is required.' });
    const matches = candidates.filter(c => c.publicationId !== version.publicationId && c.referenceNumber && normalizeReference(c.referenceNumber) === referenceNumber && normalizeAuthority(c.regulatorName) === normalizeAuthority(issuingAuthority));
    const unique = [...new Map(matches.map(c => [c.publicationId, c])).values()];
    if (unique.length === 1) return RegulatoryReferenceSchema.parse({ ...base, resolution: 'resolved', targetPublicationId: unique[0]!.publicationId, targetVersionId: unique[0]!.versionId });
    if (unique.length > 1) return RegulatoryReferenceSchema.parse({ ...base, resolution: 'ambiguous', reason: 'Several stored publications have the exact reference number and authority. Human selection is required.', candidatePublicationIds: unique.map(c => c.publicationId) });
    return RegulatoryReferenceSchema.parse({ ...base, resolution: 'unresolved', reason: 'No stored publication matches the explicit reference number and issuing authority.' });
  });
}
export function relationshipState(references: RegulatoryReference[]): RelationshipState {
  const required = references.filter(r => r.relation !== 'cites');
  if (!required.length) return 'notRequired';
  if (required.some(r => r.resolution === 'ambiguous')) return 'ambiguous';
  if (required.some(r => r.resolution === 'unresolved')) return 'missingPredecessor';
  return 'resolved';
}
