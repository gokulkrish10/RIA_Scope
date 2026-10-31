import type { VersionText, TextSegment } from './evidence.js';
import { BackendError } from '../errors.js';

const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
const amendment = /repeal|withdraw|supersed|amend|modif|replac/i;
function namedClauses(text: string): string[] {
  if (/\b(?:para(?:graph)?s?\.?|clauses?|sections?)\s+\d+(?:\.\d+)*\s*(?:-|–|to)\s*\d/i.test(text)) throw new BackendError('comparisonFailed', 'Comparison unresolved: a referenced clause range needs explicit supported clause selection; it was not silently truncated.', 422);
  const groups = [...text.matchAll(/\b(?:para(?:graph)?s?\.?|clauses?|sections?)\s+((?:\d+(?:\.\d+)*(?:\s*(?:,|and|&)\s*)?)+)/gi)];
  return [...new Set(groups.flatMap(group => group[1]!.match(/\d+(?:\.\d+)*/g) ?? []))];
}

/** Select only explicit partial-amendment evidence, never fuzzy semantic matches.
 * Locators/text remain exact persisted segments. No expected classifications are supplied.
 */
export function explicitClauseScope(current: VersionText, previous: VersionText | null, context: unknown) {
  if (!previous) return { current, previous, scope: null };
  const metadata = context as { previousPublication?: { title?: string; referenceNumber?: string | null }; supportedRelationships?: { referenceNumber: string | null; evidence: { excerpt: string }[] }[] } | null;
  const relationships = metadata?.supportedRelationships ?? [];
  if (!relationships.length) return { current, previous, scope: null };
  const title = metadata?.previousPublication?.title;
  const targets = new Set<string>(); const selected = new Set<TextSegment>();
  for (const [index, segment] of current.segments.entries()) {
    const explicitNumber = relationships.some(reference => reference.referenceNumber && normalized(segment.text).includes(normalized(reference.referenceNumber)));
    const explicitTitleAmendment = !!title && normalized(segment.text).includes(normalized(title)) && amendment.test(segment.text);
    if (!explicitNumber && !explicitTitleAmendment) continue;
    const numbers = namedClauses(segment.text); if (!numbers.length) continue;
    let introduction: TextSegment | undefined;
    if (!amendment.test(segment.text)) {
      // Repeal tables carry the number/paragraphs in rows and their legal action in the introduction.
      introduction = current.segments.slice(Math.max(0, index - 6), index).reverse().find(s => amendment.test(s.text));
      if (!introduction) continue;
    }
    numbers.forEach(number => targets.add(number)); selected.add(segment); if (introduction) selected.add(introduction);
  }
  if (!targets.size) return { current, previous, scope: null };
  const matched = new Set<string>();
  const oldSegments = previous.segments.filter(segment => {
    const clause = /^(\d+(?:\.\d+)*)(?:\.|\))\s/.exec(segment.text)?.[1];
    if (!clause) return false;
    const parents = [...targets].filter(target => clause === target || clause.startsWith(target + '.'));
    parents.forEach(target => matched.add(target)); return parents.length > 0;
  });
  const missing = [...targets].filter(target => !matched.has(target));
  if (missing.length) throw new BackendError('comparisonFailed', 'Comparison unresolved: explicitly referenced predecessor clauses are absent from persisted text. Supply the missing evidence; no similar clause was substituted.', 422);
  return {
    current: { ...current, segments: current.segments.filter(segment => selected.has(segment)) },
    previous: { ...previous, segments: oldSegments },
    scope: { kind: 'explicitPartialAmendment', predecessorClauseNumbers: [...targets], limitation: 'Only explicitly identified amendments/repeals are supplied. This is not an exhaustive comparison, a current-applicability finding, or evidence that other obligations are unchanged.' },
  };
}
