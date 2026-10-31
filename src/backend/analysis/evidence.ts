import { z } from 'zod';
import { createHash } from 'node:crypto';
import { SourceEvidenceSchema, type SourceEvidence } from '../../shared/contracts/index.js';
import { BackendError } from '../errors.js';

export const TextSegmentSchema = z.strictObject({
  locator: z.string().min(1), pageNumber: z.number().int().positive().nullable(), text: z.string().min(1),
});
export type TextSegment = z.infer<typeof TextSegmentSchema>;
export interface VersionText { publicationId: string; documentId: string; versionId: string; segments: TextSegment[] }
export function stableId(scope: string, value: unknown): string {
  const hex = createHash('sha256').update(scope).update(JSON.stringify(value)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function segmentPages(pages: { pageNumber: number | null; text: string }[]): TextSegment[] {
  const segments: TextSegment[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    // Exact substrings of persisted text. Numbered segment locator is deterministic and independently verifiable.
    for (let offset = 0, n = 1; offset < page.text.length; offset += 4000, n++) {
      const text = page.text.slice(offset, offset + 4000);
      if (!text.trim()) continue;
      segments.push({ locator: `${page.pageNumber === null ? `Text block ${pageIndex + 1}` : `Page ${page.pageNumber}`}, segment ${n}`, pageNumber: page.pageNumber, text });
    }
  }
  if (!segments.length) throw new BackendError('extractionFailed', 'No persisted text is available for analysis.', 422);
  return segments;
}
export function validateEvidence(value: unknown, version: VersionText, code: 'extractionFailed' | 'comparisonFailed' = 'extractionFailed'): SourceEvidence {
  const parsed = SourceEvidenceSchema.safeParse(value);
  if (!parsed.success) throw new BackendError(code, 'Model returned invalid source evidence.', 422, true);
  const evidence = parsed.data;
  const segment = version.segments.find(s => s.locator === evidence.locator && (s.pageNumber ?? undefined) === evidence.pageNumber);
  if (evidence.documentId !== version.documentId || evidence.versionId !== version.versionId || !segment || !segment.text.includes(evidence.excerpt)) {
    throw new BackendError(code, 'Citation was rejected: document/version, locator, page or verbatim excerpt does not match persisted text.', 422, true);
  }
  return evidence;
}
