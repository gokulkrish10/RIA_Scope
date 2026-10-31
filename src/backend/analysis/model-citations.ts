import { BackendError } from '../errors.js';
import type { SourceEvidence } from '../../shared/contracts/index.js';
import type { VersionText } from './evidence.js';

/** The model selects server-owned quote IDs; it never authors citation identity or source text. */
export function citationTransport(payload: unknown, schema: unknown) {
  const input = payload as VersionText & { current?: VersionText; previous?: VersionText | null };
  const versions = input.current ? [input.current, ...(input.previous ? [input.previous] : [])] : [input];
  const catalog: Record<string, SourceEvidence> = {};
  for (const version of versions) {
    for (const segment of version.segments) {
      // A whole segment supports clauses spanning line breaks; smaller adjacent blocks offer precise citations.
      const quotes = [segment.text];
      let start = 0;
      while (segment.text.length > 900 && start < segment.text.length) {
        let end = Math.min(start + 700, segment.text.length);
        if (end < segment.text.length) {
          const newline = segment.text.indexOf('\n', end);
          if (newline !== -1 && newline - end < 200) end = newline + 1;
        }
        quotes.push(segment.text.slice(start, end));
        start = end;
      }
      for (const excerpt of new Set(quotes.filter(q => q.trim()))) {
        const quoteId = `q${Object.keys(catalog).length + 1}`;
        catalog[quoteId] = { documentId: version.documentId, versionId: version.versionId, locator: segment.locator, ...(segment.pageNumber === null ? {} : { pageNumber: segment.pageNumber }), excerpt };
      }
    }
  }
  if (!Object.keys(catalog).length) throw new BackendError('extractionFailed', 'No source quotes are available for structured analysis.', 422);
  const transform = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(transform);
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const properties = record.properties as Record<string, unknown> | undefined;
    if (properties?.documentId && properties.versionId && properties.locator && properties.excerpt) {
      return { type: 'object', properties: { quoteId: { type: 'string', enum: Object.keys(catalog) } }, required: ['quoteId'], additionalProperties: false };
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, transform(child)]));
  };
  const restore = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(restore);
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if ('quoteId' in record) {
      if (Object.keys(record).length !== 1 || typeof record.quoteId !== 'string' || !Object.hasOwn(catalog, record.quoteId)) throw new BackendError('extractionFailed', 'Model selected an unknown or malformed source quote ID.', 422, true);
      return { ...catalog[record.quoteId]! };
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, restore(child)]));
  };
  return { schema: transform(schema), catalog, restore };
}
