import { load } from 'cheerio';
import { z } from 'zod';
import { CandidateSchema, type SourceAdapter } from './types.js';
import { BackendError } from '../errors.js';
import { officialRegulatoryHtml } from '../html-body.mjs';
import { SourceConfigSchema } from '../../shared/contracts/index.js';

export const SAMA_SOURCE_ID = 'c94d8e71-6d1f-4c28-8de1-60e32ed29a72';
export const SAMA_OPTIONS = { maxDocuments: 2 };
const Options = z.strictObject({ maxDocuments: z.number().int().min(1).max(10).default(2) });
export const samaAdapter: SourceAdapter = {
  key: 'sama-circulars', allowedHosts: ['rulebook.sama.gov.sa'],
  async discover(source, options, fetcher, signal) {
    const { maxDocuments } = Options.parse(options);
    const listing = await fetcher.get(source.url, 4 * 1024 * 1024, signal);
    if (!listing.contentType.includes('text/html')) throw new BackendError('sourceUnavailable', 'SAMA circular listing did not return HTML.', 500);
    const $ = load(listing.bytes.toString('utf8'));
    const rows = $('table.circulars tbody tr').toArray().flatMap(row => {
      const cells = $(row).find('td');
      const href = cells.eq(1).find('a[href]').first().attr('href');
      if (!href) return [];
      const url = new URL(href, listing.finalUrl);
      if (url.hostname !== 'rulebook.sama.gov.sa' || !/^\/en\/node\/\d+$/.test(url.pathname)) return [];
      return [{ url: url.href, referenceNumber: cells.eq(0).text().trim(), status: cells.eq(4).text().trim() }];
    }).slice(0, maxDocuments);
    if (!rows.length) throw new BackendError('sourceUnavailable', 'SAMA listing contains no verified circular links.', 500);
    const candidates = [];
    for (const row of rows) {
      const response = await fetcher.get(row.url, 4 * 1024 * 1024, signal);
      const body = officialRegulatoryHtml(response.bytes.toString('utf8'), response.finalUrl);
      if (body.referenceNumber !== row.referenceNumber || !body.publicationDate) throw new BackendError('sourceUnavailable', 'SAMA circular detail disagrees with its listing or has no verified date.', 500);
      candidates.push(CandidateSchema.parse({ canonicalKey: `sama-node:${new URL(row.url).pathname.split('/').pop()}`, downloadUrl: row.url, mediaType: 'text/html', title: body.title, referenceNumber: body.referenceNumber, publicationDate: body.publicationDate, effectiveDate: null, kind: /consultative/i.test(row.status) ? 'consultation' : 'circular' }));
    }
    return candidates;
  },
};
export function samaSource(now: string) {
  return SourceConfigSchema.parse({ id: SAMA_SOURCE_ID, name: 'SAMA — circular listing', country: 'SA', region: 'ksa', regulatorId: 'fd693e7f-f224-4e65-8abe-436921423595', regulatorName: 'Saudi Central Bank (SAMA)', url: 'https://rulebook.sama.gov.sa/en/sama-circulars', enabled: true, monitoringIntervalMinutes: 1440, lastMonitoredAt: null, nextMonitorAt: now, createdAt: now, updatedAt: now });
}
