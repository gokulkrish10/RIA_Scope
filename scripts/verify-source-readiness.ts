import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { load } from 'cheerio';
import { HttpsOfficialFetcher } from '../src/backend/fetch.js';
import { OriginalStorage } from '../src/backend/storage.js';
import { extractText } from '../src/backend/extract.js';
import { cbkAdapter, cbkSource } from '../src/backend/adapters/cbk.js';

const root = resolve('.data', `source-readiness-${Date.now()}`);
await mkdir(root, { recursive: true, mode: 0o700 });
const storage = new OriginalStorage(resolve(root, 'originals'));
const rows: Record<string, unknown>[] = [];
const listings = [
  ['KSA', 'https://rulebook.sama.gov.sa/en/sama-circulars'],
  ['UAE', 'https://rulebook.centralbank.ae/en/rulebook/banking'],
  ['India', 'https://rbi.org.in/Scripts/NotificationUser.aspx'],
  ['Kenya', 'https://www.centralbank.go.ke/policy-procedures/legislation-and-guidelines/circulars/'],
];
for (const [region, url] of listings) {
  try {
    const response = await new HttpsOfficialFetcher([new URL(url!).hostname], 20000).get(url!, 4 * 1024 * 1024);
    const stored = await storage.put(response.bytes);
    const $ = load(response.bytes.toString('utf8'));
    const links = $('a[href]').toArray().map(a => ({ title: $(a).text().trim().replace(/\s+/g, ' '), url: new URL($(a).attr('href')!, response.finalUrl).href })).filter(a => /^https:/.test(a.url));
    rows.push({ region, url, fetched: true, bytes: response.bytes.length, contentType: response.contentType, sha256: stored.hash, title: $('title').text(), pdfLinks: links.filter(a => /\.pdf(?:$|\?)/i.test(a.url)).slice(0, 5), links: links.length, implementedAdapter: region === 'Kenya' });
  } catch (error) { rows.push({ region, url, fetched: false, error: error instanceof Error ? error.message : String(error), implementedAdapter: region === 'Kenya' }); }
}
const india = rows.find(row => row.region === 'India') as { pdfLinks?: { url: string }[] } | undefined;
const indiaDocument = india?.pdfLinks?.[0]?.url;
if (indiaDocument) {
  try {
    const response = await new HttpsOfficialFetcher(['rbidocs.rbi.org.in'], 20000).get(indiaDocument, 20 * 1024 * 1024);
    const stored = await storage.put(response.bytes);
    let extraction: unknown;
    try { const text = await extractText(storage.path(stored.key), 'application/pdf'); extraction = { state: 'succeeded', characters: text.text.length, pages: text.pages.length }; }
    catch (error) { extraction = { state: 'failed', message: error instanceof Error ? error.message : String(error) }; }
    rows.push({ region: 'India', operation: 'listing-linked-document-retrieval', url: indiaDocument, sha256: stored.hash, bytes: response.bytes.length, contentType: response.contentType, pdfSignature: response.bytes.subarray(0,5).toString() === '%PDF-', extraction, implementedAdapter: false });
  } catch (error) { rows.push({ region: 'India', operation: 'listing-linked-document-retrieval', url: indiaDocument, error: error instanceof Error ? error.message : String(error) }); }
}
try {
  const candidates = await cbkAdapter.discover(cbkSource(new Date().toISOString()), { maxDocuments: 3 }, new HttpsOfficialFetcher(cbkAdapter.allowedHosts, 20000), new AbortController().signal);
  for (const candidate of candidates) {
    try {
      const response = await new HttpsOfficialFetcher(cbkAdapter.allowedHosts, 20000).get(candidate.downloadUrl, 20 * 1024 * 1024);
      const stored = await storage.put(response.bytes);
      let extraction: unknown;
      try { const text = await extractText(storage.path(stored.key), 'application/pdf'); extraction = { state: 'succeeded', characters: text.text.length, pages: text.pages.length }; }
      catch (error) { extraction = { state: 'failed', message: error instanceof Error ? error.message : String(error) }; }
      rows.push({ region: 'Kenya', operation: 'unfiltered-listing-discovery-and-retrieval', title: candidate.title, url: candidate.downloadUrl, sha256: stored.hash, bytes: response.bytes.length, extraction });
    } catch (error) { rows.push({ region: 'Kenya', title: candidate.title, error: error instanceof Error ? error.message : String(error) }); }
  }
} catch (error) { rows.push({ region: 'Kenya', discoveryError: error instanceof Error ? error.message : String(error) }); }
for (const [reference, url] of [
  ['45077226', 'https://rulebook.sama.gov.sa/sites/default/files/en_net_file_store/SAMA_EN_10045_VER1.pdf'],
  ['472038084', 'https://rulebook.sama.gov.sa/sites/default/files/en_net_file_store/SAMA_EN_10866_VER1.pdf'],
]) {
  try {
    const response = await new HttpsOfficialFetcher(['rulebook.sama.gov.sa'], 20000).get(url!, 20 * 1024 * 1024);
    const stored = await storage.put(response.bytes);
    let extraction: unknown;
    try { const text = await extractText(storage.path(stored.key), 'application/pdf'); extraction = { state: 'succeeded', characters: text.text.length, pages: text.pages.length }; await writeFile(resolve(root, reference + '.txt'), text.text, { mode: 0o600 }); }
    catch (error) { extraction = { state: 'failed', message: error instanceof Error ? error.message : String(error) }; }
    rows.push({ region: 'KSA', operation: 'official-historical-pair-candidate', reference, url, sha256: stored.hash, bytes: response.bytes.length, extraction });
  } catch (error) { rows.push({ region: 'KSA', reference, url, error: error instanceof Error ? error.message : String(error) }); }
}
await writeFile(resolve(root, 'report.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), rows }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ artifacts: root, rows }, null, 2));
