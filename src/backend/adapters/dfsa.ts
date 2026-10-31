import { load } from 'cheerio';
import { z } from 'zod';
import { CandidateSchema, type SourceAdapter } from './types.js';
import { BackendError } from '../errors.js';
import { officialRegulatoryHtml } from '../html-body.mjs';
import { SourceConfigSchema } from '../../shared/contracts/index.js';

export const DFSA_SOURCE_ID = 'a601ec71-a70c-4da6-865f-e6f87730b34e';
export const DFSA_OPTIONS = { maxDocuments: 2 };
const Options = z.strictObject({ maxDocuments: z.number().int().min(1).max(10).default(2) });
export const dfsaAdapter: SourceAdapter = {
  key: 'dfsa-notices', allowedHosts: ['www.dfsa.ae'],
  async discover(source, options, fetcher, signal) {
    const { maxDocuments } = Options.parse(options);
    const listing = await fetcher.get(source.url, 4 * 1024 * 1024, signal);
    if (!listing.contentType.includes('text/html')) throw new BackendError('sourceUnavailable', 'DFSA news listing did not return HTML.', 500);
    const $ = load(listing.bytes.toString('utf8'));
    const urls = [...new Set($('.news-listing-block a.item[href]').toArray().flatMap(element => {
      const tag = $(element).find('.tag').text().trim();
      const title = $(element).find('.title').text().trim();
      if (!/Notice of (?:Amendment|Consultation Paper)/i.test(tag) || !/^Notice of (?:Amendments? to Legislation|Consultation Paper)/i.test(title)) return [];
      const url = new URL($(element).attr('href')!, listing.finalUrl);
      return url.hostname === 'www.dfsa.ae' && /^\/news\/notice-(?:amendments?-legislation|consultation-paper)/i.test(url.pathname) ? [url.href] : [];
    }))].slice(0, maxDocuments);
    if (!urls.length) throw new BackendError('sourceUnavailable', 'DFSA listing contains no verified regulatory notices on this page.', 500);
    const candidates = [];
    for (const url of urls) {
      const response = await fetcher.get(url, 4 * 1024 * 1024, signal);
      const body = officialRegulatoryHtml(response.bytes.toString('utf8'), response.finalUrl);
      if (!body.publicationDate) throw new BackendError('sourceUnavailable', 'DFSA notice has no verified publication date.', 500);
      candidates.push(CandidateSchema.parse({ canonicalKey: `dfsa-notice:${new URL(url).pathname}`, downloadUrl: url, mediaType: 'text/html', title: body.title, referenceNumber: body.referenceNumber, publicationDate: body.publicationDate, effectiveDate: null, kind: /consultation/i.test(body.title) ? 'consultation' : 'amendment' }));
    }
    return candidates;
  },
};
export function dfsaSource(now: string) {
  return SourceConfigSchema.parse({ id: DFSA_SOURCE_ID, name: 'DFSA — regulatory amendment notices (UAE)', country: 'AE', region: 'uae', regulatorId: 'bd5bda63-82cc-4231-8c87-b3eb8c296796', regulatorName: 'Dubai Financial Services Authority', url: 'https://www.dfsa.ae/news', enabled: true, monitoringIntervalMinutes: 1440, lastMonitoredAt: null, nextMonitorAt: now, createdAt: now, updatedAt: now });
}
