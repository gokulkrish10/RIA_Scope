import { load } from 'cheerio';
import { z } from 'zod';
import { CandidateSchema, type SourceAdapter } from './types.js';
import { BackendError } from '../errors.js';
import { regulatoryHtml } from '../html-body.mjs';
import { SourceConfigSchema } from '../../shared/contracts/index.js';

export const RBI_SOURCE_ID = 'a9a3a4fa-9339-4db5-ae97-57a99fcaf0fa';
export const RBI_LISTING_SOURCE_ID = '728db66c-4dfe-47ab-a613-eae7cd58276b';
const hosts = ['www.rbi.org.in', 'rbi.org.in', 'rbidocs.rbi.org.in'];
const documentUrl = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && hosts.slice(0, 2).includes(url.hostname) && !url.username && !url.password && !url.port && /^\/scripts\/notificationuser.aspx$/i.test(url.pathname) && /^\d+$/.test(url.searchParams.get('Id') ?? '');
}, 'Use an explicit official RBI notification URL');
const Options = z.strictObject({ documentUrls: z.array(documentUrl).min(1).max(10).optional(), maxDocuments: z.number().int().min(1).max(10).default(2) });
// Operator-selected historical scope, not evidence of general listing discovery.
export const RBI_HISTORICAL_OPTIONS = { documentUrls: [
  'https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12382&Mode=0',
  'https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12663&Mode=0',
], maxDocuments: 2 };
export const rbiAdapter: SourceAdapter = {
  key: 'rbi-notifications', allowedHosts: hosts,
  async discover(source, options, fetcher, signal) {
    const config = Options.parse(options);
    let urls = config.documentUrls;
    if (!urls) {
      const listing = await fetcher.get(source.url, 4 * 1024 * 1024, signal);
      const $ = load(listing.bytes.toString('utf8'));
      urls = [...new Set($('table a[href]').toArray().flatMap(a => {
        try { const url = new URL($(a).attr('href')!, listing.finalUrl).href; return documentUrl.safeParse(url).success ? [url] : []; } catch { return []; }
      }))].slice(0, config.maxDocuments);
      if (!urls.length) throw new BackendError('sourceUnavailable', 'RBI listing contains no verified notification links; no fixed document was substituted.', 500);
    }
    const candidates = [];
    for (const url of urls.slice(0, config.maxDocuments)) {
      const response = await fetcher.get(url, 4 * 1024 * 1024, signal);
      let body;
      try { body = regulatoryHtml(response.bytes.toString('utf8')); }
      catch (error) { throw new BackendError('sourceUnavailable', error instanceof Error ? error.message : 'Invalid RBI notification body.', 500); }
      candidates.push(CandidateSchema.parse({ canonicalKey: `rbi-notification:${new URL(url).searchParams.get('Id')}`, downloadUrl: url, mediaType: 'text/html', title: body.title, referenceNumber: body.referenceNumber, publicationDate: body.publicationDate, effectiveDate: null, kind: 'circular' }));
    }
    return candidates;
  },
};
export function rbiSource(now: string) {
  return SourceConfigSchema.parse({ id: RBI_SOURCE_ID, name: 'RBI — selected historical notifications (not general discovery)', country: 'IN', region: 'india', regulatorId: '342ed5dd-8f32-48f6-b849-9a98430561b7', regulatorName: 'Reserve Bank of India', url: 'https://www.rbi.org.in/Scripts/NotificationUser.aspx', enabled: true, monitoringIntervalMinutes: 1440, lastMonitoredAt: null, nextMonitorAt: now, createdAt: now, updatedAt: now });
}
export function rbiListingSource(now: string) {
  return SourceConfigSchema.parse({ id: RBI_LISTING_SOURCE_ID, name: 'RBI — current notifications listing', country: 'IN', region: 'india', regulatorId: '342ed5dd-8f32-48f6-b849-9a98430561b7', regulatorName: 'Reserve Bank of India', url: 'https://www.rbi.org.in/Scripts/NotificationUser.aspx', enabled: true, monitoringIntervalMinutes: 1440, lastMonitoredAt: null, nextMonitorAt: now, createdAt: now, updatedAt: now });
}
