import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { zipSync, strToU8 } from 'fflate';
import { Database } from '../src/backend/db.js';
import { Repository } from '../src/backend/repository.js';
import { Worker } from '../src/backend/worker.js';
import { OriginalStorage } from '../src/backend/storage.js';
import { BackendError, LeaseLostError } from '../src/backend/errors.js';
import { createApi } from '../src/backend/api.js';
import { extractText } from '../src/backend/extract.js';
import { isPublicIpv4, readBounded, validateOfficialUrl } from '../src/backend/fetch.js';
import { cbkSource, cbkAdapter, CBK_SOURCE_ID } from '../src/backend/adapters/cbk.js';
import { type Candidate, type OfficialFetcher, type SourceAdapter } from '../src/backend/adapters/types.js';
import { ApiErrorSchema, JobStatusSchema, PublicationDetailSchema, parsePublicationSearchParams } from '../src/shared/contracts/index.js';

const token = 'test-only-secret-with-at-least-32-characters';
const candidate: Candidate = { canonicalKey: 'circular-1', downloadUrl: 'https://www.centralbank.go.ke/circular.txt', title: 'Test circular', kind: 'circular', referenceNumber: 'TEST/2026/1', publicationDate: null, effectiveDate: null, mediaType: 'text/plain' };
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'ria-backend-test-'));
  const db = new Database(join(root, 'ria.sqlite'));
  let time = Date.now();
  const repository = new Repository(db, () => time++);
  repository.seedSource(cbkSource(repository.now()), 'test', {});
  const storage = new OriginalStorage(join(root, 'originals'));
  const state = { bytes: Buffer.from('Banks must retain model records and review models annually.'), fetches: 0, transientFailures: 0, permanent: false, candidates: [candidate] };
  const adapter: SourceAdapter = { key: 'test', allowedHosts: ['www.centralbank.go.ke'], async discover() { return state.candidates; } };
  const fetcher: OfficialFetcher = { async get(url) {
    state.fetches++;
    if (state.permanent) throw new BackendError('sourceUnavailable', 'Official source returned HTTP 404.', 500);
    if (state.transientFailures-- > 0) throw new BackendError('sourceUnavailable', 'Official source returned HTTP 503.', 500, true);
    return { bytes: state.bytes, contentType: state.candidates.find(c => c.downloadUrl === url)?.mediaType ?? 'text/plain', finalUrl: url };
  } };
  const registry = new Map([['test', adapter]]);
  const worker = new Worker(repository, storage, registry, () => fetcher, 0);
  const drain = async () => { for (let i = 0; i < 30; i++) { if (!await worker.runOne()) return; } throw new Error('Queue failed to drain'); };
  const cycle = async () => { const { jobId } = repository.triggerMonitor({}); await drain(); return repository.job(jobId); };
  const cleanup = async () => { db.close(); await rm(root, { recursive: true, force: true }); };
  return { root, db, repository, storage, state, registry, fetcher, worker, drain, cycle, cleanup, advance: (ms: number) => { time += ms; } };
}
test('ingestion persists original/text, exposes schema-valid responses, and reruns without duplicates', async () => {
  const h = await harness();
  try {
    const first = await h.cycle();
    assert.equal(first.state, 'succeeded');
    assert.ok(first.result?.kind === 'monitor');
    const id = first.result.monitorRun.sources[0]!.discoveredPublications[0]!.id;
    const detail = PublicationDetailSchema.parse(h.repository.detail(id));
    assert.equal(detail.processingState, 'succeeded');
    assert.equal(detail.relationshipState, 'unchecked');
    assert.equal(detail.publicationDate, null);
    const version = h.db.get<{ content_hash: string; extracted_text: string; original_key: string }>('SELECT * FROM document_versions')!;
    assert.equal(version.extracted_text, h.state.bytes.toString());
    assert.deepEqual(await h.storage.read(version.original_key), h.state.bytes);
    assert.equal((await stat(h.storage.path(version.original_key))).mode & 0o777, 0o600);
    assert.equal((await stat(h.storage.root)).mode & 0o777, 0o700);
    const second = await h.cycle();
    assert.ok(second.result?.kind === 'monitor');
    assert.equal(second.result.monitorRun.sources[0]?.alreadyKnownCount, 1);
    assert.deepEqual(second.result.monitorRun.sources[0]?.ingestionJobIds, []);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM publications')?.n, 1);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM document_versions')?.n, 1);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM ingestion_tasks')?.n, 1);
    const search = h.repository.listPublications(parsePublicationSearchParams(new URLSearchParams('q=MODEL&pageSize=1')));
    assert.equal(search.total, 1);
    assert.equal(h.repository.listPublications(parsePublicationSearchParams(new URLSearchParams('publicationDateFrom=2020-01-01'))).total, 0);
    assert.doesNotMatch(JSON.stringify(detail), /original_key|content_hash|extracted_text|storagePath|Bearer|\.sqlite/);
  } finally { await h.cleanup(); }
});
test('changed bytes create a new version and preserve the old original and job snapshot', async () => {
  const h = await harness();
  try {
    const first = await h.cycle();
    assert.ok(first.result?.kind === 'monitor');
    const sourceResult = first.result.monitorRun.sources[0]!;
    const oldJob = h.repository.job(sourceResult.ingestionJobIds[0]!);
    const publicationId = sourceResult.discoveredPublications[0]!.id;
    const prior = h.repository.detail(publicationId);
    h.state.bytes = Buffer.from('Banks must retain model records and review models quarterly.');
    await h.cycle();
    const current = h.repository.detail(publicationId);
    assert.equal(current.versions.length, 2);
    assert.equal(current.versions[1]?.versionNumber, 2);
    assert.notEqual(current.currentVersionId, prior.currentVersionId);
    assert.deepEqual(h.repository.job(sourceResult.ingestionJobIds[0]!), oldJob);
    assert.equal((await readdir(h.storage.root)).length, 2);
    await h.cycle();
    assert.equal(h.repository.detail(publicationId).versions.length, 2);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM ingestion_tasks')?.n, 2);
  } finally { await h.cleanup(); }
});
test('failed download returns a failed run, no fake document, and releases source locks', async () => {
  const h = await harness();
  try {
    h.state.permanent = true;
    const job = await h.cycle();
    assert.equal(job.state, 'failed');
    assert.equal(job.error?.code, 'sourceUnavailable');
    assert.ok(job.result?.kind === 'monitor');
    assert.equal(job.result.monitorRun.sources[0]?.state, 'failed');
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM publications')?.n, 0);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM source_locks')?.n, 0);
    assert.equal(h.state.fetches, 1);
    h.state.permanent = false;
    assert.equal((await h.cycle()).state, 'succeeded');
  } finally { await h.cleanup(); }
});
test('transient failure retries safely; terminal failure never retries itself', async () => {
  const h = await harness();
  try {
    h.state.transientFailures = 1;
    const accepted = h.repository.triggerMonitor({});
    await h.worker.runOne();
    assert.equal(h.repository.job(accepted.jobId).state, 'running');
    await h.drain();
    assert.equal(h.repository.job(accepted.jobId).state, 'succeeded');
    assert.equal(h.repository.jobRow(accepted.jobId).attempts, 2);
    h.state.transientFailures = 100;
    const failure = await h.cycle();
    assert.equal(failure.state, 'failed');
    assert.equal(h.repository.jobRow(failure.id).attempts, 3);
    assert.equal(await h.worker.runOne(), false);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM document_versions')?.n, 1);
  } finally { await h.cleanup(); }
});
test('source batch is atomic when a later document fails', async () => {
  const h = await harness();
  try {
    const adapter: SourceAdapter = { key: 'test', allowedHosts: [], async discover() { return [candidate, { ...candidate, canonicalKey: 'second', downloadUrl: 'https://www.centralbank.go.ke/missing.txt' }]; } };
    let count = 0;
    const fetcher: OfficialFetcher = { async get(url) { if (++count === 2) throw new BackendError('sourceUnavailable', 'Missing document.', 500); return { bytes: h.state.bytes, contentType: 'text/plain', finalUrl: url }; } };
    const worker = new Worker(h.repository, h.storage, new Map([['test', adapter]]), () => fetcher);
    const { jobId } = h.repository.triggerMonitor({});
    await worker.runOne();
    assert.equal(h.repository.job(jobId).state, 'failed');
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM publications')?.n, 0);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM ingestion_tasks')?.n, 0);
  } finally { await h.cleanup(); }
});
test('two database connections claim exclusively, expired owner is fenced, restarted worker recovers', async () => {
  const h = await harness();
  const secondDb = new Database(join(h.root, 'ria.sqlite'));
  try {
    const other = new Repository(secondDb, h.repository.clock);
    const { jobId } = h.repository.triggerMonitor({});
    const first = h.repository.claim(100)!;
    assert.equal(other.claim(100), undefined);
    h.advance(200);
    const second = other.claim(100)!;
    assert.equal(second.id, jobId);
    assert.notEqual(first.claim_token, second.claim_token);
    assert.throws(() => h.repository.progress(first, 'stale'), LeaseLostError);
    assert.equal(h.repository.heartbeat(first, 100), false);
    h.advance(200);
    await h.drain();
    assert.equal(h.repository.job(jobId).state, 'succeeded');
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM publications')?.n, 1);
  } finally { secondDb.close(); await h.cleanup(); }
});
test('crash after atomic source commit resumes without duplicate discoveries or jobs', async () => {
  const h = await harness();
  try {
    const { jobId } = h.repository.triggerMonitor({});
    const claim = h.repository.claim(100)!;
    const stored = await h.storage.put(h.state.bytes);
    h.repository.commitSource(claim, h.repository.sourceById(CBK_SOURCE_ID), [{ candidate, ...stored, size: h.state.bytes.length }]);
    h.advance(200);
    await h.drain();
    assert.equal(h.repository.job(jobId).state, 'succeeded');
    assert.equal(h.state.fetches, 0);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM ingestion_tasks')?.n, 1);
  } finally { await h.cleanup(); }
});
test('crashed jobs at the attempt cap terminate without more downloads', async () => {
  const h = await harness();
  try {
    const { jobId } = h.repository.triggerMonitor({});
    h.repository.claim(100);
    h.db.run('UPDATE jobs SET attempts=3 WHERE id=?', jobId);
    h.advance(200);
    await h.drain();
    assert.equal(h.repository.job(jobId).state, 'failed');
    assert.equal(h.state.fetches, 0);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM source_locks')?.n, 0);
  } finally { await h.cleanup(); }
});
test('queued work survives closing and reopening the database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ria-restart-test-'));
  const path = join(root, 'ria.sqlite');
  const first = new Database(path);
  const initial = new Repository(first);
  initial.seedSource(cbkSource(initial.now()), 'test', {});
  const accepted = initial.triggerMonitor({});
  first.close();
  const second = new Database(path);
  try {
    const restored = new Repository(second);
    assert.equal(restored.job(accepted.jobId).state, 'queued');
    const adapter: SourceAdapter = { key: 'test', allowedHosts: [], async discover() { return [candidate]; } };
    const fetcher: OfficialFetcher = { async get(url) { return { bytes: Buffer.from('Preserve audit records.'), contentType: 'text/plain', finalUrl: url }; } };
    const worker = new Worker(restored, new OriginalStorage(join(root, 'originals')), new Map([['test', adapter]]), () => fetcher);
    while (await worker.runOne()) { /* drain restored queue */ }
    assert.equal(restored.job(accepted.jobId).state, 'succeeded');
    assert.equal(second.get<{ n: number }>('SELECT count(*) AS n FROM publications')?.n, 1);
    assert.equal(second.get<{ n: number }>('SELECT count(*) AS n FROM schema_migrations')?.n, 3);
  } finally { second.close(); await rm(root, { recursive: true, force: true }); }
});
test('mixed source success/failure produces an explicit partial result', async () => {
  const h = await harness();
  try {
    const badSource = { ...cbkSource(h.repository.now()), id: 'f5f7f73e-daa6-4f2d-82fd-ef962182d4b5', name: 'Unavailable source' };
    h.repository.seedSource(badSource, 'unavailable', {});
    const job = await h.cycle();
    assert.equal(job.state, 'succeeded');
    assert.ok(job.result?.kind === 'monitor');
    assert.equal(job.result.monitorRun.outcome, 'partial');
    assert.deepEqual(new Set(job.result.monitorRun.sources.map(s => s.state)), new Set(['succeeded', 'failed']));
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM publications')?.n, 1);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM source_locks')?.n, 0);
  } finally { await h.cleanup(); }
});
test('failed extraction is explicit, retains original, and manual rerun creates only a new job', async () => {
  const h = await harness();
  try {
    h.state.bytes = Buffer.from([0xff, 0xfe, 0x00]);
    const monitor = await h.cycle();
    assert.equal(monitor.state, 'succeeded');
    const row = h.db.get<{ id: string }>('SELECT id FROM publications')!;
    const detail = h.repository.detail(row.id);
    assert.equal(detail.processingState, 'failed');
    assert.equal(detail.processingError?.code, 'extractionFailed');
    assert.deepEqual(detail.obligations, []);
    await h.cycle();
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM document_versions')?.n, 1);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM ingestion_tasks')?.n, 2);
  } finally { await h.cleanup(); }
});
test('scheduler persists due time and does not create overlapping or repeated scheduled runs', async () => {
  const h = await harness();
  try {
    assert.equal(h.repository.scheduleDue().length, 1);
    assert.deepEqual(h.repository.scheduleDue(), []);
    assert.throws(() => h.repository.triggerMonitor({}), (e: unknown) => e instanceof BackendError && e.status === 409);
    await h.drain();
    assert.deepEqual(h.repository.scheduleDue(), []);
    h.advance(1440 * 60_000 + 1);
    assert.equal(h.repository.scheduleDue().length, 1);
  } finally { await h.cleanup(); }
});
test('API enforces auth, accepted/job distinction, query validation and public serializers', async () => {
  const h = await harness();
  try {
    const api = createApi(h.repository, token);
    const req = { method: 'POST', url: '/api/v1/monitor-runs', headers: { 'content-type': 'application/json' }, body: {} };
    const unauthorized = await api.handle(req);
    assert.equal(unauthorized.status, 401);
    assert.equal(ApiErrorSchema.parse(unauthorized.body).error.code, 'unauthorized');
    const response = await api.handle({ ...req, headers: { ...req.headers, authorization: `Bearer ${token}` } });
    assert.equal(response.status, 202);
    const { jobId } = response.body as { jobId: string };
    assert.equal(response.headers.Location, `/api/v1/jobs/${jobId}`);
    const read = async (url: string) => api.handle({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    assert.equal(JobStatusSchema.parse((await read(`/api/v1/jobs/${jobId}`)).body).state, 'queued');
    assert.equal((await read(`/api/v1/monitor-runs/${jobId}/result`)).status, 409);
    await h.drain();
    assert.equal((await read(`/api/v1/monitor-runs/${jobId}/result`)).status, 200);
    assert.equal((await read('/api/v1/publications?country=KE&pageSize=1')).status, 200);
    assert.equal((await read('/api/v1/publications?page=0')).status, 400);
    assert.equal((await read('/api/v1/jobs/invalid')).status, 400);
    assert.equal((await read('/api/v1/sources')).status, 200);
    assert.equal((await read('/private/originals/file')).status, 404);
    assert.equal((await read('/api/v1/publications/upload')).status, 400);
  } finally { await h.cleanup(); }
});
test('network boundaries reject private destinations, redirect hosts, overflow and empty bodies', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.2', '100.64.0.1', '0.0.0.0', '::1', '224.0.0.1']) assert.equal(isPublicIpv4(address), false);
  assert.equal(isPublicIpv4('192.124.249.9'), true);
  for (const url of ['https://evil.example/file', 'http://www.centralbank.go.ke/file', 'https://www.centralbank.go.ke:8080/file', 'https://www.centralbank.go.ke.evil.example/file']) assert.throws(() => validateOfficialUrl(url, ['www.centralbank.go.ke']));
  await assert.rejects(readBounded(Readable.from([Buffer.alloc(5), Buffer.alloc(6)]), 10));
  await assert.rejects(readBounded(Readable.from([]), 10));
  assert.equal((await readBounded(Readable.from([Buffer.alloc(10)]), 10)).length, 10);
});
test('DOCX extracts real ZIP/XML text; corrupt/encrypted PDF is rejected', async () => {
  const h = await harness();
  try {
    const docx = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Maintain records.</w:t></w:r></w:p></w:body></w:document>') });
    const stored = await h.storage.put(Buffer.from(docx));
    assert.equal((await extractText(h.storage.path(stored.key), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).text, 'Maintain records.');
    const corrupt = await h.storage.put(Buffer.from('%PDF-1.7\ninvalid encrypted-like document'));
    await assert.rejects(extractText(h.storage.path(corrupt.key), 'application/pdf'), (e: unknown) => e instanceof BackendError && e.code === 'extractionFailed');
  } finally { await h.cleanup(); }
});
test('PDF text extraction succeeds in the isolated process with its required runtime dependencies', async () => {
  const h = await harness();
  try {
    const stream = 'BT /F1 12 Tf 72 720 Td (Banks must maintain records.) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${n.toString().padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const stored = await h.storage.put(Buffer.from(pdf));
    const result = await extractText(h.storage.path(stored.key), 'application/pdf');
    assert.match(result.text, /Banks must maintain records/);
    assert.equal(result.pages[0]?.pageNumber, 1);
  } finally { await h.cleanup(); }
});
test('CBK adapter uses official links, stable references and null dates rather than invented dates', async () => {
  const html = '<table><tr><td>2026</td><td><a href="/a.pdf">Banking Circular No. 1 of 2026 - Example</a></td></tr></table>';
  const items = await cbkAdapter.discover(cbkSource(new Date().toISOString()), { maxDocuments: 1 }, { async get() { return { bytes: Buffer.from(html), contentType: 'text/html', finalUrl: 'https://www.centralbank.go.ke/' }; } }, new AbortController().signal);
  assert.equal(items[0]?.downloadUrl, 'https://www.centralbank.go.ke/a.pdf');
  assert.equal(items[0]?.referenceNumber, 'Banking Circular No. 1 of 2026');
  assert.equal(items[0]?.publicationDate, null);
});
