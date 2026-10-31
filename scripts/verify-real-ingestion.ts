import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from '../src/backend/db.js';
import { Repository } from '../src/backend/repository.js';
import { Worker } from '../src/backend/worker.js';
import { OriginalStorage } from '../src/backend/storage.js';
import { adapters, cbkSource, cbkAdapter, CBK_SOURCE_ID, CBK_CHECKPOINT_OPTIONS } from '../src/backend/adapters/cbk.js';
import { createHttpServer } from '../src/backend/api.js';
import { API_CONTRACT, MonitorAcceptedResponseSchema, JobStatusSchema, PublicationListResponseSchema, PublicationDetailSchema, MonitorRunResultSchema } from '../src/shared/contracts/index.js';

process.umask(0o077);
const root = resolve('.data', `verification-${Date.now()}`);
await mkdir(root, { recursive: true, mode: 0o700 });
const db = new Database(resolve(root, 'ria.sqlite'));
const repository = new Repository(db);
repository.seedSource(cbkSource(repository.now()), cbkAdapter.key, CBK_CHECKPOINT_OPTIONS);
const storage = new OriginalStorage(resolve(root, 'originals'));
const worker = new Worker(repository, storage, adapters, undefined, 0);
const token = randomBytes(32).toString('hex');
const server = createHttpServer(repository, token);
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
async function cycle() {
  const response = await fetch(`${base}${API_CONTRACT.triggerMonitor.path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceIds: [CBK_SOURCE_ID] }) });
  assert.equal(response.status, 202);
  const accepted = MonitorAcceptedResponseSchema.parse(await response.json());
  const queued = JobStatusSchema.parse(await (await fetch(`${base}/api/v1/jobs/${accepted.jobId}`)).json());
  assert.equal(queued.state, 'queued');
  for (let i = 0; i < 20 && await worker.runOne(); i++) { /* drain this small checkpoint queue */ }
  const job = JobStatusSchema.parse(await (await fetch(`${base}/api/v1/jobs/${accepted.jobId}`)).json());
  assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
  return MonitorRunResultSchema.parse(await (await fetch(`${base}/api/v1/monitor-runs/${accepted.jobId}/result`)).json());
}
try {
  console.log('Verifying official CBK listing and its LIBOR guidance through real HTTP endpoints...');
  const first = await cycle();
  const page = PublicationListResponseSchema.parse(await (await fetch(`${base}/api/v1/publications`)).json());
  assert.equal(page.total, 1);
  const publication = PublicationDetailSchema.parse(await (await fetch(`${base}/api/v1/publications/${page.items[0]!.id}`)).json());
  assert.equal(publication.processingState, 'succeeded', JSON.stringify(publication.processingError));
  const before = db.get<{ versions: number; jobs: number }>('SELECT (SELECT count(*) FROM document_versions) AS versions,(SELECT count(*) FROM ingestion_tasks) AS jobs')!;
  const second = await cycle();
  const after = db.get<typeof before>('SELECT (SELECT count(*) FROM document_versions) AS versions,(SELECT count(*) FROM ingestion_tasks) AS jobs')!;
  assert.deepEqual(before, after);
  assert.equal(second.sources[0]?.alreadyKnownCount, 1);
  assert.equal(second.sources[0]?.discoveredPublications.length, 0);
  const version = db.get<{ content_hash: string; original_key: string; characters: number; pages: number }>('SELECT content_hash,original_key,length(extracted_text) AS characters,json_array_length(extracted_pages_json) AS pages FROM document_versions')!;
  assert.ok(version.characters > 50);
  await storage.read(version.original_key);
  const report = {
    verifiedAt: new Date().toISOString(), officialListing: repository.sourceById(CBK_SOURCE_ID).config.url,
    publicationId: publication.id, title: publication.title, sourceUrl: publication.sourceUrl,
    publicationDate: publication.publicationDate, effectiveDate: publication.effectiveDate,
    contentHash: version.content_hash, bytes: publication.versions[0]!.sizeBytes, extractedCharacters: version.characters,
    pages: version.pages, firstRunId: first.jobId, duplicateRunId: second.jobId, before, after,
    adapterOptions: CBK_CHECKPOINT_OPTIONS, result: 'passed',
  };
  await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  console.log(`Private verification artifacts: ${root}`);
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
}
