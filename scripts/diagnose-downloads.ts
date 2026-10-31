import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { HttpsOfficialFetcher } from '../src/backend/fetch.js';
import { OriginalStorage } from '../src/backend/storage.js';
import { downloadDiagnostic } from '../src/backend/download-diagnostics.js';
import { extractText } from '../src/backend/extract.js';
import { BackendError } from '../src/backend/errors.js';
import { cbkAdapter, cbkSource } from '../src/backend/adapters/cbk.js';
import { RBI_HISTORICAL_OPTIONS } from '../src/backend/adapters/rbi.js';

process.umask(0o077);
const root = resolve('.data', `download-diagnostics-${Date.now()}`); await mkdir(root, { recursive: true, mode: 0o700 });
const storage = new OriginalStorage(resolve(root, 'originals'));
const rows: Record<string, unknown>[] = [];
const urls = [
  ...RBI_HISTORICAL_OPTIONS.documentUrls,
  'https://rbidocs.rbi.org.in/rdocs/notification/PDFs/NT30314AC275308034E98A5E239A91CEAA5A7.PDF',
  'https://rulebook.sama.gov.sa/sites/default/files/en_net_file_store/SAMA_EN_10045_VER1.pdf',
  'https://rulebook.sama.gov.sa/sites/default/files/en_net_file_store/SAMA_EN_10866_VER1.pdf',
  'https://rulebook.centralbank.ae/en/rulebook/banking',
];
try { urls.push(...(await cbkAdapter.discover(cbkSource(new Date().toISOString()), { maxDocuments: 3 }, new HttpsOfficialFetcher(cbkAdapter.allowedHosts), new AbortController().signal)).map(c => c.downloadUrl)); }
catch (error) { rows.push({ stage: 'Kenya listing discovery', error: error instanceof Error ? error.message : 'Failed' }); }
for (const url of urls) {
  try {
    const response = await new HttpsOfficialFetcher([new URL(url).hostname]).get(url, 20 * 1024 * 1024);
    const original = await storage.put(response.bytes);
    const diagnostic = downloadDiagnostic(response.httpStatus ?? 200, response.finalUrl, response.contentType, response.bytes);
    const row: Record<string, unknown> = { requestedUrl: url, ...diagnostic, originalHash: original.hash };
    if (diagnostic.signature === 'pdf') {
      const task = getDocument({ data: new Uint8Array(response.bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
      try {
        const document = await task.promise; assertPageLimit(document.numPages); const pages = [];
        for (let number = 1; number <= document.numPages; number++) { const page = await document.getPage(number), text = await page.getTextContent(), operators = await page.getOperatorList(); pages.push({ page: number, textItems: text.items.length, characters: text.items.reduce((n, item) => n + ('str' in item ? item.str.length : 0), 0), imageOperations: operators.fnArray.filter(op => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(op)).length }); page.cleanup(); }
        row.pdfPages = pages;
      } finally { await task.destroy(); }
    }
    try { const text = await extractText(storage.path(original.key), diagnostic.signature === 'html' ? 'text/html' : 'application/pdf', undefined, url); row.extractedCharacters = text.text.length; }
    catch (error) { row.extractionError = error instanceof Error ? error.message : 'Extraction failed'; }
    rows.push(row);
  } catch (error) { rows.push({ requestedUrl: url, ...(error instanceof BackendError ? error.diagnostic : {}), downloadError: error instanceof BackendError ? error.message : 'Download or diagnostic parsing failed' }); }
}
await writeFile(resolve(root, 'report.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), rows }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ artifacts: root, count: rows.length, note: 'Probe completion is not ingestion success. Inspect per-document outcomes.' }));
function assertPageLimit(count: number) { if (count > 300) throw new Error('Diagnostic page limit exceeded'); }
