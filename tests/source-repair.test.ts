import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { regulatoryHtml, officialDocumentLinks } from '../src/backend/html-body.mjs';
import { routeDocument } from '../src/backend/document-routing.js';
import { downloadDiagnostic, fileSignature } from '../src/backend/download-diagnostics.js';
import { extractText } from '../src/backend/extract.js';
import { OriginalStorage } from '../src/backend/storage.js';
import { Database } from '../src/backend/db.js';
import { Repository } from '../src/backend/repository.js';
import { Worker } from '../src/backend/worker.js';
import { rbiSource, rbiAdapter } from '../src/backend/adapters/rbi.js';
import { segmentPages, validateEvidence } from '../src/backend/analysis/evidence.js';
import { DocumentVersionSchema, UploadFileDescriptorSchema } from '../src/shared/contracts/index.js';
import { versionFixture } from '../src/shared/fixtures/index.js';
import type { Candidate } from '../src/backend/adapters/types.js';

// Synthetic DOM reproduces the observed RBI body structure, never regulatory evidence.
const html = (requirement = 'Banks must retain the synthetic records.', state = 'one') => `<!doctype html><html><head><title>Notifications</title></head><body><nav>Unrelated navigation</nav><input value="${state}"><div id="NotificationUser"><div id="doublescroll"><table><tr><td class="tableheader"><b>SYNTHETIC circular</b></td></tr><tr><td><table style="background:url(https://www.rbi.org.in/images/Withdrawn.png)"><tr><td><p>The Circular has been repealed. Please refer to later instructions.</p><p>RBI/2024-25/18<br>DOR.TEST.13/13.03.00/2024-25</p><p align="right">April 15, 2024</p><p>All synthetic regulated entities including banks and finance companies for the purposes of this synthetic extraction regression only.</p><p>1. ${requirement}</p><p>2. Supporting records must be held securely and reviewed by the responsible department; this is synthetic text for testing.</p><table><tr><td>3.</td><td>OLD/2022/01</td><td>Only paragraph 5 is repealed by the Reserve Bank of India.</td></tr></table></td></tr></table></td></tr></table></div></div><footer>Unrelated footer</footer></body></html>`;
const candidate: Candidate = { canonicalKey: 'test-html', downloadUrl: 'https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=123&Mode=0', mediaType: 'text/html', title: 'Synthetic', referenceNumber: null, publicationDate: null, effectiveDate: null, kind: 'circular' };
const response = (body: string, contentType = 'text/html') => ({ bytes: Buffer.from(body), contentType, finalUrl: candidate.downloadUrl, httpStatus: 200 });

test('approved HTML response enum is browser-safe while manual upload formats stay restricted', () => {
  assert.equal(DocumentVersionSchema.parse({ ...versionFixture, mediaType: 'text/html' }).mediaType, 'text/html');
  assert.equal(UploadFileDescriptorSchema.safeParse({ fileName: 'document.html', mediaType: 'text/html', sizeBytes: 100 }).success, false);
});
test('RBI body extraction preserves date, exact number, clause/table and later-status notice without navigation', () => {
  const body = regulatoryHtml(html());
  assert.equal(body.referenceNumber, 'DOR.TEST.13/13.03.00/2024-25'); assert.equal(body.publicationDate, '2024-04-15');
  assert.match(body.text, /Circular has been repealed/); assert.match(body.text, /status watermark asset/);
  assert.match(body.text, /OLD\/2022\/01/); assert.doesNotMatch(body.text, /Unrelated|value="one"/);
  assert.ok(body.pages.some(p => p.locator.includes('Clause 1.')));
  assert.ok(body.pages.find(p => p.text.includes('OLD/2022/01'))?.locator.includes('table row 3.'));
  assert.equal(regulatoryHtml(html().replace('April 15, 2024', 'Unknown')).publicationDate, null);
});
test('content routing detects HTML disguised as PDF and rejects CAPTCHA/login/error/landing pages', () => {
  assert.equal(routeDocument(response(html(), 'application/pdf'), { ...candidate, mediaType: 'application/pdf' }).candidate.mediaType, 'text/html');
  for (const body of ['<html><body>Access denied</body></html>', '<html><body><input type="password">Login</body></html>', '<html><body><div id="captcha">Challenge</div></body></html>', '<html><body>Welcome to notifications</body></html>']) assert.throws(() => routeDocument(response(body), candidate));
  assert.throws(() => routeDocument({ ...response(html()), finalUrl: 'https://example.org/fake' }, candidate), /source-specific/);
  assert.equal(fileSignature(Buffer.from('<!DOCTYPE html><body>CAPTCHA</body>')), 'html');
  assert.equal(fileSignature(Buffer.from('%PDF-1.4')), 'pdf');
});
test('landing fallback follows only advertised allowlisted official document links', () => {
  const landing = '<html><body><a href="https://rbidocs.rbi.org.in/file.pdf">Download official PDF</a><a href="https://evil.test/file.pdf">PDF</a></body></html>';
  assert.deepEqual(officialDocumentLinks(landing, candidate.downloadUrl, rbiAdapter.allowedHosts), ['https://rbidocs.rbi.org.in/file.pdf']);
  assert.deepEqual(officialDocumentLinks(landing.replace('<body>', '<body>Access denied'), candidate.downloadUrl, rbiAdapter.allowedHosts), []);
});
test('download diagnostics redact credentials and private URL parameters without storing response bodies', () => {
  const d = downloadDiagnostic(403, 'https://u:p@www.rbi.org.in/a?Id=123&token=secret', 'text/html', Buffer.from('<html>Access denied</html>'));
  assert.equal(d.httpStatus, 403); assert.equal(d.byteCount, 26); assert.equal(d.signature, 'html');
  assert.doesNotMatch(JSON.stringify(d), /secret|u:p|Access denied/); assert.match(d.finalUrl, /Id=123/);
});
test('HTML duplicates ignore session/navigation changes, preserve raw originals and version changed regulatory text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ria-html-')), db = new Database(join(root, 'ria.sqlite')), repository = new Repository(db), storage = new OriginalStorage(join(root, 'originals'));
  let body = html(); const source = rbiSource(repository.now()); repository.seedSource(source, 'synthetic', {});
  const worker = new Worker(repository, storage, new Map([['synthetic', { key: 'synthetic', allowedHosts: rbiAdapter.allowedHosts, async discover() { return [candidate]; } }]]), () => ({ async get() { return response(body); } }));
  const run = async () => { const job = repository.triggerMonitor({}); while (await worker.runOne()) { /* bounded test jobs */ } assert.equal(repository.job(job.jobId).state, 'succeeded'); };
  try {
    await run(); const row = db.get<{ id: string; original_key: string; extracted_pages_json: string; publication_id: string; metadata_json: string }>('SELECT * FROM document_versions')!;
    assert.equal((await storage.read(row.original_key)).toString(), body);
    const segments = segmentPages(JSON.parse(row.extracted_pages_json)); const segment = segments.find(s => s.text.includes('Banks must'))!;
    const version = { versionId: row.id, documentId: JSON.parse(row.metadata_json).documentId as string, publicationId: row.publication_id, segments };
    validateEvidence({ documentId: version.documentId, versionId: version.versionId, locator: segment.locator, excerpt: 'Banks must retain the synthetic records.' }, version);
    body = html(undefined, 'changed-session'); await run(); assert.equal(db.get<{ n: number }>('SELECT count(*) n FROM document_versions')!.n, 1);
    body = html('Banks must retain records for ten years.'); await run(); assert.equal(db.get<{ n: number }>('SELECT count(*) n FROM document_versions')!.n, 2);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
test('observed Kenyan/SAMA failure mode: structurally valid image-only PDF yields specific no-text-layer error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ria-image-only-')), storage = new OriginalStorage(root);
  // One image XObject, zero text operators: same measured failure mode as the five live PDFs.
  const stream = 'q 10 0 0 10 0 0 cm /Im1 Do Q';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20 20] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n000000>\nendstream'];
  let pdf = '%PDF-1.4\n'; const offsets = [0]; for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  try { const original = await storage.put(Buffer.from(pdf)); await assert.rejects(extractText(storage.path(original.key), 'application/pdf'), /parsed successfully.*images.*no readable text layer/); }
  finally { await rm(root, { recursive: true, force: true }); }
});
