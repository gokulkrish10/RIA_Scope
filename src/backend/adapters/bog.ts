import { load } from 'cheerio';
import { z } from 'zod';
import { CandidateSchema, type SourceAdapter } from './types.js';
import { BackendError } from '../errors.js';
import { SourceConfigSchema } from '../../shared/contracts/index.js';
import { officialDocumentLinks } from '../html-body.mjs';

export const BOG_SOURCE_ID = '0e8b2f79-a7ee-4389-997f-d4311d7a50c1';
export const BOG_NOTICES_SOURCE_ID = '66525420-5579-43b5-9fa7-355ec7f63232';
export const BOG_OPTIONS = { maxDocuments: 1 };
const Options = z.strictObject({ maxDocuments: z.number().int().min(1).max(10).default(1) });
export const bogAdapter: SourceAdapter = {
  key: 'bog-regulations-directives', allowedHosts: ['www.bog.gov.gh'],
  async discover(source, options, fetcher, signal) {
    const { maxDocuments } = Options.parse(options);
    const listing = await fetcher.get(source.url, 4 * 1024 * 1024, signal);
    if (!listing.contentType.includes('text/html')) throw new BackendError('sourceUnavailable', 'Bank of Ghana regulatory listing did not return HTML.', 500);
    const $ = load(listing.bytes.toString('utf8'));
    const candidates = new Map<string, ReturnType<typeof CandidateSchema.parse>>();
    for (const element of $('a[href]').toArray()) {
      const title = $(element).text().replace(/\s+/g, ' ').trim();
      const href = $(element).attr('href');
      if (!href || !/(?:guideline|directive|regulation)/i.test(title) || /^(?:download|read more)$/i.test(title)) continue;
      const url = new URL(href, listing.finalUrl);
      if (url.hostname !== 'www.bog.gov.gh' || !/^\/wp-content\/uploads\/\d{4}\/\d{2}\//.test(url.pathname) || !/\.pdf$/i.test(url.pathname)) continue;
      candidates.set(url.href, CandidateSchema.parse({
        canonicalKey: `bog-pdf:${url.pathname}`, downloadUrl: url.href, mediaType: 'application/pdf',
        title, kind: /exposure draft|consultation|proposed/i.test(title) ? 'consultation' : /guideline/i.test(title) ? 'guideline' : 'regulation',
        referenceNumber: null, publicationDate: null, effectiveDate: null,
      }));
      if (candidates.size >= maxDocuments) break;
    }
    if (!candidates.size) throw new BackendError('sourceUnavailable', 'Bank of Ghana listing contains no verified regulatory PDF links.', 500);
    return [...candidates.values()];
  },
};
export function bogSource(now: string) {
  return SourceConfigSchema.parse({ id: BOG_SOURCE_ID, name: 'Bank of Ghana — regulations and directives (long drafts may exceed analysis limit)', country: 'GH', region: 'africa', regulatorId: '8b277064-d14e-4b8e-842e-32d9b3bcbdb5', regulatorName: 'Bank of Ghana', url: 'https://www.bog.gov.gh/downloads/supervision-and-regulation-downloads/regulations-directives/', enabled: false, monitoringIntervalMinutes: 1440, lastMonitoredAt: null, nextMonitorAt: null, createdAt: now, updatedAt: now });
}
export const bogNoticesAdapter: SourceAdapter = {
  key: 'bog-regulatory-notices', allowedHosts: ['www.bog.gov.gh'],
  async discover(source, options, fetcher, signal) {
    const { maxDocuments } = Options.parse(options);
    const listing = await fetcher.get(source.url, 4 * 1024 * 1024, signal);
    if (!listing.contentType.includes('text/html')) throw new BackendError('sourceUnavailable', 'Bank of Ghana notice listing did not return HTML.', 500);
    const $ = load(listing.bytes.toString('utf8'));
    const rows = $('h2.elementor-heading-title a[href]').toArray().flatMap(element => {
      const title = $(element).text().replace(/\s+/g, ' ').trim();
      if (!/(?:directive|circular|guideline|unlicensed digital credit services providers|regulatory measures)/i.test(title)) return [];
      const url = new URL($(element).attr('href')!, listing.finalUrl);
      if (url.hostname !== 'www.bog.gov.gh' || !/^\/notice\/[a-z0-9-]+\/$/i.test(url.pathname)) return [];
      const cardText = $(element).closest('.elementor-column').text().replace(/\s+/g, ' ');
      const dateText = /\b([A-Za-z]+ \d{1,2}, \d{4})/.exec(cardText)?.[1];
      const parsed = dateText ? new Date(`${dateText} 00:00:00 UTC`) : null;
      const publicationDate = parsed && !Number.isNaN(parsed.valueOf()) ? parsed.toISOString().slice(0, 10) : null;
      return [{ title, url: url.href, publicationDate }];
    }).slice(0, maxDocuments);
    if (!rows.length) throw new BackendError('sourceUnavailable', 'Bank of Ghana notice listing contains no verified regulatory notices.', 500);
    const candidates = [];
    for (const row of rows) {
      const detail = await fetcher.get(row.url, 4 * 1024 * 1024, signal);
      const links = officialDocumentLinks(detail.bytes.toString('utf8'), detail.finalUrl, bogNoticesAdapter.allowedHosts);
      if (links.length !== 1) throw new BackendError('sourceUnavailable', 'Bank of Ghana notice needs exactly one verified official document link.', 500);
      candidates.push(CandidateSchema.parse({ canonicalKey: `bog-notice:${new URL(row.url).pathname}`, downloadUrl: links[0], mediaType: 'application/pdf', title: row.title, kind: /exposure draft|consultation/i.test(row.title) ? 'consultation' : /directive|regulatory/i.test(row.title) ? 'regulation' : 'circular', referenceNumber: null, publicationDate: row.publicationDate, effectiveDate: null }));
    }
    return candidates;
  },
};
export function bogNoticesSource(now: string) {
  return SourceConfigSchema.parse({ ...bogSource(now), id: BOG_NOTICES_SOURCE_ID, name: 'Bank of Ghana — regulatory notices', url: 'https://www.bog.gov.gh/notice/', enabled: true, nextMonitorAt: now });
}
