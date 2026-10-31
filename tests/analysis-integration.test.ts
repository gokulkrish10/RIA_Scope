import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { Database } from '../src/backend/db.js';
import { Repository } from '../src/backend/repository.js';
import { OriginalStorage } from '../src/backend/storage.js';
import { Worker } from '../src/backend/worker.js';
import { AnalysisService } from '../src/backend/analysis/service.js';
import { AnalysisEngine } from '../src/backend/analysis/engine.js';
import { type AnalysisModel } from '../src/backend/analysis/bedrock.js';
import { BackendError } from '../src/backend/errors.js';
import { createApi } from '../src/backend/api.js';
import { cbkSource } from '../src/backend/adapters/cbk.js';
import { type VersionText } from '../src/backend/analysis/evidence.js';
import { ComparisonSchema, JobStatusSchema, UploadAcceptedResponseSchema, parsePublicationSearchParams } from '../src/shared/contracts/index.js';

const TOKEN = 'synthetic-local-integration-token-only-12345';
const REVIEWER = '225dcc34-f02c-4c79-8bbc-d3d412730c53';
const oldText = 'SYNTHETIC TEST ONLY. Central Bank of Kenya circular SYNTH/2020/1. Banks must complete review by 2026-12-31.';
const newText = 'SYNTHETIC TEST ONLY. This amends Central Bank of Kenya circular SYNTH/2020/1. The review deadline is extended from 2026-12-31 to 2027-03-31.';
function citation(version: VersionText, excerpt?: string) {
  const segment = version.segments[0]!;
  return { documentId: version.documentId, versionId: version.versionId, locator: segment.locator, ...(segment.pageNumber ? { pageNumber: segment.pageNumber } : {}), excerpt: excerpt ?? segment.text };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ria-analysis-test-'));
  const db = new Database(join(root, 'ria.sqlite'));
  const repository = new Repository(db);
  const source = cbkSource(repository.now());
  repository.seedSource(source, 'unused-test-adapter', {});
  const storage = new OriginalStorage(join(root, 'originals'));
  const calls = { extraction: 0, comparison: 0, failures: 0, invalid: false, delayMs: 0 };
  const model: AnalysisModel = { identity: 'synthetic-integration-model-v1', async generate(_system, payload) {
    if (calls.delayMs) await new Promise(resolve => setTimeout(resolve, calls.delayMs));
    if (calls.failures-- > 0) throw new BackendError('extractionFailed', 'Synthetic temporary model error.', 422, true);
    const input = payload as VersionText & { current?: VersionText; previous?: VersionText };
    if (input.current) {
      calls.comparison++;
      return { evidenceComplete: !calls.invalid, unresolvedReason: calls.invalid ? 'Synthetic missing clause evidence.' : null, changes: [{ id: randomUUID(), classification: 'deadlineChanged', before: citation(input.previous!), after: citation(input.current), explanation: 'SYNTHETIC: Review deadline extended by three months.', deadlineDirection: 'extended', previousDeadline: '2026-12-31', updatedDeadline: '2027-03-31' }] };
    }
    calls.extraction++;
    const amended = input.segments[0]!.text.includes('amends');
    return { documentStatus: null, statusEvidence: [], effectiveDate: null, effectiveDateEvidence: [], businessAreas: ['banking'], obligations: [{ text: 'Complete the review by the specified deadline.', requirementStatus: 'mandatory', businessAreas: ['banking'], applicableEntities: ['Banks'], departments: [], regulatedActivities: ['Model review'], effectiveDate: null, complianceDeadline: amended ? '2027-03-31' : '2026-12-31', evidence: [citation(input)] }], references: amended ? [{ referenceText: 'Central Bank of Kenya circular SYNTH/2020/1', referenceNumber: 'SYNTH/2020/1', issuingAuthority: 'Central Bank of Kenya', relation: 'amends', evidence: [citation(input, 'This amends Central Bank of Kenya circular SYNTH/2020/1.')] }] : [] };
  } };
  const analysis = new AnalysisService(repository, new AnalysisEngine(model), 0);
  const worker = new Worker(repository, storage, new Map());
  const api = createApi(repository, TOKEN, { analysis, storage, reviewerId: REVIEWER });
  const call = (method: string, url: string, body?: unknown) => api.handle({ method, url, body, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
  async function upload(text: string, referenceNumber: string, kind = 'circular') {
    const form = new FormData();
    form.set('file', new File([text], 'synthetic.txt', { type: 'text/plain' }));
    form.set('metadata', JSON.stringify({ title: `SYNTHETIC ${referenceNumber}`, country: source.country, regulatorId: source.regulatorId, kind, referenceNumber, publicationDate: null, effectiveDate: null, sourceId: null }));
    const request = new Request('http://localhost/api/v1/publications/upload', { method: 'POST', body: form });
    const response = await api.handle({ method: 'POST', url: '/api/v1/publications/upload', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': request.headers.get('content-type')! }, body: Buffer.from(await request.arrayBuffer()) });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const accepted = UploadAcceptedResponseSchema.parse(response.body);
    while (await worker.runOne()) { /* text ingestion only */ }
    return accepted;
  }
  async function drain() { for (let i = 0; i < 20; i++) if (!await analysis.runOne()) return; throw new Error('Analysis queue did not drain'); }
  return { db, repository, analysis, api, model, worker, call, upload, drain, calls, source, cleanup: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}
test('persisted analysis → missing predecessor → upload/link → cited comparison → review and filters', async () => {
  const h = await setup();
  try {
    const current = await h.upload(newText, 'SYNTH/2026/2');
    assert.equal((await h.call('GET', `/api/v1/publications/${current.publicationId}/obligations`)).status, 409);
    const accepted = await h.call('POST', `/api/v1/publications/${current.publicationId}/comparisons`, { currentVersionId: current.versionId, predecessorVersionId: null });
    assert.equal(accepted.status, 202);
    const request = accepted.body as { jobId: string; comparisonId: string };
    await h.drain();
    assert.equal(JobStatusSchema.parse((await h.call('GET', `/api/v1/jobs/${request.jobId}`)).body).state, 'blocked');
    assert.equal(h.analysis.comparison(request.comparisonId).state, 'blocked');
    const currentDetail = h.repository.detail(current.publicationId);
    assert.equal(currentDetail.relationshipState, 'missingPredecessor');
    assert.equal(currentDetail.obligations.length, 1);
    const predecessor = await h.upload(oldText, 'SYNTH/2020/1');
    const linked = await h.call('POST', `/api/v1/publications/${current.publicationId}/predecessor`, { currentVersionId: current.versionId, referenceId: currentDetail.references[0]!.id, predecessorPublicationId: predecessor.publicationId, predecessorVersionId: predecessor.versionId });
    assert.equal(linked.status, 202, JSON.stringify(linked.body));
    const link = linked.body as { jobId: string; comparisonId: string };
    await h.drain();
    assert.equal(h.repository.job(link.jobId).state, 'succeeded');
    const comparison = ComparisonSchema.parse((await h.call('GET', `/api/v1/comparisons/${link.comparisonId}`)).body);
    assert.equal(comparison.state, 'succeeded');
    assert.equal(comparison.changes[0]?.classification, 'deadlineChanged');
    assert.equal(comparison.changes[0]?.before?.versionId, predecessor.versionId);
    assert.equal(comparison.changes[0]?.after.versionId, current.versionId);
    assert.match(h.db.get<{ diff_json: string }>('SELECT diff_json FROM comparisons WHERE id=?', link.comparisonId)!.diff_json, /removed/);
    const detail = h.repository.detail(current.publicationId);
    assert.equal(detail.relationshipState, 'resolved');
    assert.equal(detail.review.state, 'pending');
    assert.equal((await h.call('GET', `/api/v1/publications/${current.publicationId}/obligations`)).status, 200);
    assert.equal(h.repository.listPublications(parsePublicationSearchParams(new URLSearchParams('changeClass=deadlineChanged&businessArea=banking'))).total, 1);
    const priorCalls = { ...h.calls };
    const replay = await h.call('POST', `/api/v1/publications/${current.publicationId}/comparisons`, { currentVersionId: current.versionId, predecessorVersionId: predecessor.versionId });
    assert.equal((replay.body as { jobId: string }).jobId, link.jobId);
    await h.drain();
    assert.deepEqual(h.calls, priorCalls);
    const review = await h.call('PATCH', `/api/v1/publications/${current.publicationId}/review`, { state: 'approved', note: 'Synthetic test reviewer verified both clauses.', expectedUpdatedAt: detail.review.updatedAt });
    assert.equal(review.status, 200);
    assert.equal((await h.call('PATCH', `/api/v1/publications/${current.publicationId}/review`, { state: 'approved', note: null, expectedUpdatedAt: detail.review.updatedAt })).status, 409);
    assert.equal(h.analysis.comparison(request.comparisonId).state, 'blocked');
  } finally { await h.cleanup(); }
});
test('analysis retries recover from model errors without duplicate obligations or result rows', async () => {
  const h = await setup();
  try {
    const uploaded = await h.upload(oldText, 'SYNTH/2020/1');
    h.calls.failures = 1;
    const accepted = h.analysis.requestAnalysis(uploaded.versionId);
    await h.drain();
    assert.equal(h.repository.job(accepted.jobId).state, 'succeeded');
    assert.equal(h.repository.detail(uploaded.publicationId).obligations.length, 1);
    const again = h.analysis.requestAnalysis(uploaded.versionId);
    assert.equal(again.jobId, accepted.jobId);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM version_analysis')!.n, 1);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM analysis_jobs')!.n, 1);
  } finally { await h.cleanup(); }
});
test('consultation proposals remain proposed after persisted extraction; source frequency writes work', async () => {
  const h = await setup();
  try {
    const uploaded = await h.upload(oldText, 'SYNTH/2020/1', 'consultation');
    h.analysis.requestAnalysis(uploaded.versionId);
    await h.drain();
    assert.match(h.repository.detail(uploaded.publicationId).obligations[0]!.text, /^Proposed requirement:/);
    const response = await h.call('PATCH', `/api/v1/sources/${h.source.id}`, { monitoringIntervalMinutes: 60, enabled: false });
    assert.equal(response.status, 200);
    assert.equal(h.repository.sourceById(h.source.id).config.nextMonitorAt, null);
  } finally { await h.cleanup(); }
});
test('missing clause evidence is a persisted failure and never noMaterialChange', async () => {
  const h = await setup();
  try {
    const predecessor = await h.upload(oldText, 'SYNTH/2020/1');
    const current = await h.upload(newText, 'SYNTH/2026/2');
    h.calls.invalid = true;
    const accepted = h.analysis.requestComparison(current.publicationId, { currentVersionId: current.versionId, predecessorVersionId: predecessor.versionId });
    await h.drain();
    const comparison = h.analysis.comparison(accepted.comparisonId);
    assert.equal(comparison.state, 'failed');
    assert.equal(comparison.issue?.code, 'comparisonFailed');
    assert.deepEqual(comparison.changes, []);
    assert.deepEqual(h.repository.detail(current.publicationId).changeClasses, []);
    const review = await h.call('PATCH', `/api/v1/publications/${current.publicationId}/review`, { state: 'approved', note: null, expectedUpdatedAt: h.repository.detail(current.publicationId).review.updatedAt });
    assert.equal(review.status, 409);
  } finally { await h.cleanup(); }
});
test('concurrent analysis and comparison workers share one version extraction', async () => {
  const h = await setup();
  try {
    const previous = await h.upload(oldText, 'SYNTH/2020/1');
    const current = await h.upload(newText, 'SYNTH/2026/2');
    h.calls.delayMs = 30;
    const analysis = h.analysis.requestAnalysis(current.versionId);
    const comparison = h.analysis.requestComparison(current.publicationId, { currentVersionId: current.versionId, predecessorVersionId: previous.versionId });
    const second = new AnalysisService(h.repository, new AnalysisEngine(h.model), 0);
    await Promise.all([h.analysis.runOne(), second.runOne()]);
    assert.equal(h.repository.job(analysis.jobId).state, 'succeeded');
    assert.equal(h.repository.job(comparison.jobId).state, 'succeeded');
    assert.equal(h.calls.extraction, 2);
    assert.equal(h.calls.comparison, 1);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM analysis_version_locks')!.n, 0);
  } finally { await h.cleanup(); }
});
test('expired analysis leases are reclaimed and stale worker output is fenced', async () => {
  const h = await setup();
  try {
    const current = await h.upload(oldText, 'SYNTH/2020/1');
    h.calls.delayMs = 60;
    const accepted = h.analysis.requestAnalysis(current.versionId);
    const first = h.analysis.runOne();
    h.db.run('UPDATE analysis_jobs SET lease_until=0 WHERE id=?', accepted.jobId);
    const second = new AnalysisService(h.repository, new AnalysisEngine(h.model), 0);
    await Promise.all([first, second.runOne()]);
    assert.equal(h.repository.job(accepted.jobId).state, 'succeeded');
    assert.equal(h.db.get<{ attempts: number }>('SELECT attempts FROM analysis_jobs WHERE id=?', accepted.jobId)!.attempts, 2);
    assert.equal(h.repository.detail(current.publicationId).obligations.length, 1);
    assert.equal(h.db.get<{ n: number }>('SELECT count(*) AS n FROM analysis_chunks')!.n, 1);
  } finally { await h.cleanup(); }
});
test('every new write operation rejects unauthenticated requests', async () => {
  const h = await setup();
  try {
    const id = randomUUID();
    for (const [method, url] of [
      ['PATCH', `/api/v1/sources/${h.source.id}`],
      ['POST', '/api/v1/publications/upload'],
      ['POST', `/api/v1/publications/${id}/comparisons`],
      ['POST', `/api/v1/publications/${id}/predecessor`],
      ['PATCH', `/api/v1/publications/${id}/review`],
    ]) assert.equal((await h.api.handle({ method: method!, url: url!, headers: {}, body: {} })).status, 401);
  } finally { await h.cleanup(); }
});
test('ambiguous exact matches remain unresolved until an explicit valid link', async () => {
  const h = await setup();
  try {
    const previous = await h.upload(oldText, 'SYNTH/2020/1');
    await h.upload(oldText + ' Another stored copy.', 'SYNTH/2020/1');
    const current = await h.upload(newText, 'SYNTH/2026/2');
    const blocked = h.analysis.requestComparison(current.publicationId, { currentVersionId: current.versionId, predecessorVersionId: null });
    await h.drain();
    assert.equal(h.analysis.comparison(blocked.comparisonId).issue?.code, 'ambiguousPredecessor');
    const detail = h.repository.detail(current.publicationId);
    assert.equal(detail.relationshipState, 'ambiguous');
    const accepted = h.analysis.linkPredecessor(current.publicationId, { currentVersionId: current.versionId, referenceId: detail.references[0]!.id, predecessorPublicationId: previous.publicationId, predecessorVersionId: previous.versionId });
    await h.drain();
    assert.equal(h.repository.job(accepted.jobId).state, 'succeeded');
  } finally { await h.cleanup(); }
});
test('additive analysis migrations preserve an actual migration-001 database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ria-migration-test-'));
  const path = join(root, 'old.sqlite');
  const original = new DatabaseSync(path);
  const sql = await readFile(new URL('../migrations/001_ingestion.sql', import.meta.url), 'utf8');
  original.exec(sql);
  original.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
  original.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run('001_ingestion.sql', createHash('sha256').update(sql).digest('hex'), '2026-10-31T00:00:00.000Z');
  const source = cbkSource('2026-10-31T00:00:00.000Z');
  original.prepare('INSERT INTO sources VALUES (?,?,?,?)').run(source.id, JSON.stringify(source), 'preserved-adapter', '{"preserve":true}');
  original.prepare("INSERT INTO jobs(id,kind,state,created_at,payload_json,available_at) VALUES (?,'monitor','queued',?,'{}',0)").run(randomUUID(), '2026-10-31T00:00:00.000Z');
  const before = { sources: original.prepare('SELECT * FROM sources').all(), jobs: original.prepare('SELECT * FROM jobs').all(), schema: original.prepare("SELECT sql FROM sqlite_master WHERE name IN ('sources','jobs','document_versions') ORDER BY name").all() };
  original.close();
  const migrated = new Database(path);
  try {
    assert.deepEqual(migrated.all('SELECT * FROM sources'), before.sources);
    assert.deepEqual(migrated.all('SELECT * FROM jobs'), before.jobs);
    assert.deepEqual(migrated.all("SELECT sql FROM sqlite_master WHERE name IN ('sources','jobs','document_versions') ORDER BY name"), before.schema);
    assert.equal(migrated.get<{ n: number }>('SELECT count(*) AS n FROM schema_migrations')!.n, 3);
    assert.equal(migrated.get<{ n: number }>('SELECT count(*) AS n FROM analysis_jobs')!.n, 0);
  } finally { migrated.close(); await rm(root, { recursive: true, force: true }); }
});
test('multipart DOCX uploads use isolated extraction; duplicates, signatures and oversized metadata fail explicitly', async () => {
  const h = await setup();
  try {
    const metadata = JSON.stringify({ title: 'Synthetic DOCX', regulatorId: h.source.regulatorId, country: h.source.country, kind: 'circular', referenceNumber: 'SYNTH/DOCX', publicationDate: null, effectiveDate: null, sourceId: null });
    const docx = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Retain synthetic records.</w:t></w:r></w:p></w:body></w:document>') });
    const send = async (file: File, value = metadata, extra = false) => {
      const form = new FormData(); form.set('file', file); form.set('metadata', value); if (extra) form.set('unexpected', 'bad');
      const request = new Request('http://localhost/api/v1/publications/upload', { method: 'POST', body: form });
      return h.api.handle({ method: 'POST', url: '/api/v1/publications/upload', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': request.headers.get('content-type')! }, body: Buffer.from(await request.arrayBuffer()) });
    };
    const file = new File([new Uint8Array(docx)], 'synthetic.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const accepted = await send(file);
    assert.equal(accepted.status, 202);
    const upload = UploadAcceptedResponseSchema.parse(accepted.body);
    await h.worker.runOne();
    assert.equal(h.repository.job(upload.jobId).state, 'succeeded');
    assert.match(h.db.get<{ extracted_text: string }>('SELECT extracted_text FROM document_versions WHERE id=?', upload.versionId)!.extracted_text, /Retain synthetic records/);
    assert.equal((await send(file)).status, 409);
    assert.equal((await send(new File(['not a PDF'], 'fake.pdf', { type: 'application/pdf' }))).status, 415);
    assert.equal((await send(file, metadata, true)).status, 400);
    assert.equal((await send(file, 'x'.repeat(16 * 1024 + 1))).status, 413);
  } finally { await h.cleanup(); }
});
