import { load } from 'cheerio';
import { z } from 'zod';
import { CandidateSchema, type SourceAdapter } from './types.js';
import { BackendError } from '../errors.js';
import { SourceConfigSchema } from '../../shared/contracts/index.js';

export const CBK_SOURCE_ID = '8c0c0445-9ed4-4ebc-887e-54bb9dcd5291';
export const CbkOptionsSchema = z.strictObject({
  maxDocuments: z.number().int().min(1).max(100).default(1),
  titleIncludes: z.string().min(1).max(200).optional(),
});
// Explicit narrow checkpoint scope. Remove the filter in server-side source options to expand coverage.
export const CBK_CHECKPOINT_OPTIONS = { maxDocuments: 1, titleIncludes: 'Central Bank of Kenya Guidance on LIBOR Transition' };
export const cbkAdapter: SourceAdapter = {
  key: 'cbk-circulars',
  allowedHosts: ['www.centralbank.go.ke', 'centralbank.go.ke'],
  async discover(source, options, fetcher, signal) {
    const { maxDocuments, titleIncludes } = CbkOptionsSchema.parse(options);
    const response = await fetcher.get(source.url, 4 * 1024 * 1024, signal);
    if (!response.contentType.includes('text/html')) throw new BackendError('sourceUnavailable', 'The circulars listing did not return HTML.', 500);
    const $ = load(response.bytes.toString('utf8'));
    const candidates = new Map<string, ReturnType<typeof CandidateSchema.parse>>();
    for (const element of $('table a[href]').toArray()) {
      const title = $(element).text().replace(/\s+/g, ' ').trim();
      if (titleIncludes && !title.toLowerCase().includes(titleIncludes.toLowerCase())) continue;
      const url = new URL($(element).attr('href')!, source.url);
      url.hash = '';
      if (!url.pathname.toLowerCase().endsWith('.pdf') || !title || !/circular|guidance|regulation/i.test(title)) continue;
      // Full issuer/reference is more stable than filenames when the regulator changes a URL.
      const referenceNumber = title.match(/^(.+?Circular\s+(?:No\.?|Number)\s*\d+\s+of\s+\d{4})/i)?.[1] ?? null;
      const canonicalKey = referenceNumber ? referenceNumber.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : url.href;
      candidates.set(canonicalKey, CandidateSchema.parse({
        canonicalKey, downloadUrl: url.href, mediaType: 'application/pdf', title,
        kind: /circular/i.test(title) ? 'circular' : /guidance/i.test(title) ? 'guideline' : 'regulation',
        referenceNumber, publicationDate: null, effectiveDate: null,
      }));
      // Listing only provides a year. Do not invent January 1 or an effective date.
      if (candidates.size >= maxDocuments) break;
    }
    if (!candidates.size) throw new BackendError('sourceUnavailable', 'No circular links found; the source page may have changed.', 500);
    return [...candidates.values()];
  },
};
export const adapters = new Map([[cbkAdapter.key, cbkAdapter]]);
export function cbkSource(now: string) {
  return SourceConfigSchema.parse({
    id: CBK_SOURCE_ID, name: 'Central Bank of Kenya — circulars', country: 'KE', region: 'africa',
    regulatorId: 'af8b2367-c260-41d8-aa9b-d142c75a83ca', regulatorName: 'Central Bank of Kenya',
    url: 'https://www.centralbank.go.ke/policy-procedures/legislation-and-guidelines/circulars/',
    enabled: true, monitoringIntervalMinutes: 1440, lastMonitoredAt: null, nextMonitorAt: now, createdAt: now, updatedAt: now,
  });
}
