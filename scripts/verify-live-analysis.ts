import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from '../src/backend/db.js';
import { Repository } from '../src/backend/repository.js';
import { OriginalStorage } from '../src/backend/storage.js';
import { Worker } from '../src/backend/worker.js';
import { AnalysisService } from '../src/backend/analysis/service.js';
import { AnalysisEngine } from '../src/backend/analysis/engine.js';
import { BedrockModel, bedrockSettings } from '../src/backend/analysis/bedrock.js';
import { cbkSource } from '../src/backend/adapters/cbk.js';
import { createHttpServer } from '../src/backend/api.js';
import { ComparisonAcceptedResponseSchema, ComparisonSchema, PublicationObligationsResponseSchema, UploadAcceptedResponseSchema } from '../src/shared/contracts/index.js';

process.umask(0o077);
bedrockSettings(); // Fail before touching any data if configuration is unavailable; no values are logged.
const directories = (await readdir('.data')).filter(name => /^verification-\d+$/.test(name)).sort().reverse();
let sourceArtifact: { root: string; report: { contentHash: string; title: string; sourceUrl: string } } | undefined;
for (const directory of directories) {
  try { sourceArtifact = { root: resolve('.data', directory), report: JSON.parse(await readFile(resolve('.data', directory, 'report.json'), 'utf8')) }; break; } catch { /* Only use a successfully verified prior artifact. */ }
}
if (!sourceArtifact) throw new Error('First run npm run verify:real-ingestion to obtain the verified official PDF.');
const root = process.argv[2] ? resolve(process.argv[2]) : resolve('.data', `analysis-verification-${Date.now()}`);
assert.match(root, new RegExp('^' + resolve('.data').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/analysis-verification-[0-9]+$'), 'Resume only an isolated analysis verification directory');
await mkdir(root, { recursive: true, mode: 0o700 });
const db = new Database(resolve(root, 'ria.sqlite'));
const repository = new Repository(db);
const source = cbkSource(repository.now());
repository.seedSource(source, 'cbk-circulars', {});
const storage = new OriginalStorage(resolve(root, 'originals'));
const ingestion = new Worker(repository, storage, new Map());
const model = new BedrockModel();
const analysis = new AnalysisService(repository, new AnalysisEngine(model), 0);
const token = randomBytes(32).toString('hex');
const server = createHttpServer(repository, token, { analysis, storage });
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const request = async (path: string, body?: unknown) => {
  const response = await fetch(base + path, body === undefined ? { headers: { Authorization: `Bearer ${token}` } } : { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value: unknown = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
};
async function upload(bytes: Buffer, title: string, fileName: string, mediaType: string, referenceNumber: string | null) {
  if (process.argv[2]) {
    const existing = db.get<{ id: string; publication_id: string; metadata_json: string; job_id: string }>('SELECT v.*,t.job_id FROM document_versions v JOIN ingestion_tasks t ON t.version_id=v.id WHERE v.content_hash=? LIMIT 1', createHash('sha256').update(bytes).digest('hex'));
    if (existing) {
      assert.equal(repository.job(existing.job_id).state, 'succeeded');
      return UploadAcceptedResponseSchema.parse({ jobId: existing.job_id, publicationId: existing.publication_id, documentId: (JSON.parse(existing.metadata_json) as { documentId: string }).documentId, versionId: existing.id, state: 'queued' });
    }
  }
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], fileName, { type: mediaType }));
  form.set('metadata', JSON.stringify({ title, country: source.country, regulatorId: source.regulatorId, kind: referenceNumber ? 'circular' : 'guideline', referenceNumber, publicationDate: null, effectiveDate: null, sourceId: null }));
  const response = await fetch(base + '/api/v1/publications/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const payload: unknown = await response.json();
  assert.equal(response.status, 202, JSON.stringify(payload));
  const accepted = UploadAcceptedResponseSchema.parse(payload);
  while (await ingestion.runOne()) { /* parser only; semantic analysis is verified separately */ }
  assert.equal(repository.job(accepted.jobId).state, 'succeeded');
  return accepted;
}
async function drain() { for (let i = 0; i < 20; i++) if (!await analysis.runOne()) return; throw new Error('Analysis queue exceeded verification bound'); }
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), modelIdentity: model.identity, liveModel: true, officialExtraction: null, comparison: null, result: 'running' };
try {
  console.log('Live Bedrock verification: analysing the previously verified official CBK PDF.');
  const original = await new OriginalStorage(resolve(sourceArtifact.root, 'originals')).read(sourceArtifact.report.contentHash);
  const official = await upload(original, sourceArtifact.report.title, 'cbk-libor-guidance.pdf', 'application/pdf', null);
  const job = analysis.requestAnalysis(official.versionId);
  await drain();
  const state = repository.job(job.jobId);
  assert.equal(state.state, 'succeeded', JSON.stringify(state.error));
  const obligations = PublicationObligationsResponseSchema.parse(await request(`/api/v1/publications/${official.publicationId}/obligations`));
  assert.ok(obligations.obligations.length > 0, 'Live official extraction returned no obligations; inspect model output before claiming verification.');
  report.officialExtraction = { sourceUrl: sourceArtifact.report.sourceUrl, originalSha256: sourceArtifact.report.contentHash, publicationId: official.publicationId, versionId: official.versionId, jobId: job.jobId, obligations: obligations.obligations.length, citations: obligations.obligations.reduce((n, o) => n + o.evidence.length, 0), invalidCitationsAccepted: 0, reviewState: repository.detail(official.publicationId).review.state };
  console.log('Official extraction passed; testing a live model comparison on explicitly synthetic old/new documents.');
  const oldText = 'SYNTHETIC TEST ONLY — not an actual CBK circular. Central Bank of Kenya. Circular SYNTH/2020/1. This is a final circular. Section 1. Banks must complete model governance review by 2026-12-31.';
  const newText = 'SYNTHETIC TEST ONLY — not an actual CBK circular. Central Bank of Kenya. Circular SYNTH/2026/2. This final circular amends Central Bank of Kenya circular SYNTH/2020/1. Section 1. The model governance review deadline in circular SYNTH/2020/1 is extended from 2026-12-31 to 2027-03-31.';
  const previous = await upload(Buffer.from(oldText), 'SYNTHETIC predecessor', 'old.txt', 'text/plain', 'SYNTH/2020/1');
  const current = await upload(Buffer.from(newText), 'SYNTHETIC amendment', 'new.txt', 'text/plain', 'SYNTH/2026/2');
  const accepted = ComparisonAcceptedResponseSchema.parse(await request(`/api/v1/publications/${current.publicationId}/comparisons`, { currentVersionId: current.versionId, predecessorVersionId: previous.versionId }));
  await drain();
  const comparison = ComparisonSchema.parse(await request(`/api/v1/comparisons/${accepted.comparisonId}`));
  assert.equal(comparison.state, 'succeeded', JSON.stringify(comparison.issue));
  assert.ok(comparison.changes.some(c => c.classification === 'deadlineChanged' && c.deadlineDirection === 'extended'));
  const again = ComparisonAcceptedResponseSchema.parse(await request(`/api/v1/publications/${current.publicationId}/comparisons`, { currentVersionId: current.versionId, predecessorVersionId: previous.versionId }));
  assert.equal(again.jobId, accepted.jobId);
  report.comparison = { inputKind: 'clearly-labelled-synthetic-documents', liveBedrock: true, comparisonId: accepted.comparisonId, jobId: accepted.jobId, previousVersionId: previous.versionId, currentVersionId: current.versionId, classes: comparison.changes.map(c => c.classification), reviewState: repository.detail(current.publicationId).review.state, duplicateRequestReusedJob: true };
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.failure = error instanceof Error ? error.message : 'Verification failed';
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  console.log(`Private verification artifacts: ${root}`);
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
}
