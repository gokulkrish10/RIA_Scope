import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { Database } from '../src/backend/db.js';
import { Repository } from '../src/backend/repository.js';
import { OriginalStorage } from '../src/backend/storage.js';
import { Worker } from '../src/backend/worker.js';
import { AnalysisService } from '../src/backend/analysis/service.js';
import { AnalysisEngine } from '../src/backend/analysis/engine.js';
import { BedrockModel, bedrockSettings } from '../src/backend/analysis/bedrock.js';
import { createHttpServer } from '../src/backend/api.js';
import { frontendGateway } from '../src/backend/frontend-gateway.js';
import { rbiAdapter, rbiSource, RBI_HISTORICAL_OPTIONS } from '../src/backend/adapters/rbi.js';
import { segmentPages, validateEvidence } from '../src/backend/analysis/evidence.js';

process.umask(0o077);
bedrockSettings();
const root = resolve('.data/rbi-history-repair'); await mkdir(root, { recursive: true, mode: 0o700 });
const token = process.env.RIA_WRITE_TOKEN!, user = process.env.RIA_FRONTEND_USER!, password = process.env.RIA_FRONTEND_PASSWORD!, reviewer = process.env.RIA_REVIEWER_ID!;
assert.ok(token && user && password && reviewer, 'Configure the existing trusted local authentication/reviewer environment.');
const db = new Database(resolve(root, 'ria.sqlite')), repository = new Repository(db), storage = new OriginalStorage(resolve(root, 'originals'));
repository.seedSource(rbiSource(repository.now()), rbiAdapter.key, RBI_HISTORICAL_OPTIONS);
const model = new BedrockModel(), analysis = new AnalysisService(repository, new AnalysisEngine(model), 1000);
const worker = new Worker(repository, storage, new Map([[rbiAdapter.key, rbiAdapter]]), undefined, 1000, 60000, id => { analysis.requestAnalysis(id); });
const backend = createHttpServer(repository, token, { analysis, storage, reviewerId: reviewer });
await new Promise<void>(done => backend.listen(0, '127.0.0.1', done)); const address = backend.address(); assert.ok(address && typeof address !== 'string');
const gateway = frontendGateway({ ...process.env, RIA_API_ORIGIN: `http://127.0.0.1:${address.port}` });
const vite = await createServer({ configFile: false, plugins: gateway.plugins, server: { host: '127.0.0.1', port: 4181, strictPort: true, proxy: gateway.proxy, fs: { deny: ['.env', '.env.*', '**/.data/**', '**/*.sqlite*', '**/.git/**'] } } }); await vite.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4181', httpCredentials: { username: user, password } }), page = await context.newPage();
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), inputKind: 'official RBI selected historical HTML documents', scope: 'Historical analysis pending review; selected URLs are not general listing discovery.', model: model.identity, result: 'running' };
async function drain() {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (await worker.runOne()) continue;
    if (await analysis.runOne()) { console.log('Persisted one analysis job attempt.'); continue; }
    if (!db.get("SELECT id FROM jobs WHERE state IN ('queued','running')") && !db.get("SELECT id FROM analysis_jobs WHERE state IN ('queued','running')")) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Verification exceeded its bounded processing deadline.');
}
function versionText(id: string) {
  const row = db.get<{ publication_id: string; extracted_pages_json: string; metadata_json: string }>('SELECT * FROM document_versions WHERE id=?', id)!;
  return { publicationId: row.publication_id, versionId: id, documentId: JSON.parse(row.metadata_json).documentId as string, segments: segmentPages(JSON.parse(row.extracted_pages_json)) };
}
try {
  await page.goto('/#sources'); await page.locator('[data-run]').click();
  await expect.poll(() => db.get<{ n: number }>("SELECT count(*) n FROM jobs WHERE kind='monitor' AND state='queued'")!.n).toBe(1);
  await drain();
  const monitor = db.get<{ id: string }>("SELECT id FROM jobs WHERE kind='monitor' ORDER BY rowid DESC LIMIT 1")!;
  assert.equal(repository.job(monitor.id).state, 'succeeded', JSON.stringify(repository.job(monitor.id).error));
  const rows = db.all<{ id: string }>('SELECT id FROM publications'); assert.equal(rows.length, 2);
  // Resume failed jobs after credentials/model corrections without recreating publications or originals.
  if (process.argv.includes('--retry-analysis')) { for (const row of rows) analysis.requestAnalysis(repository.detail(row.id).currentVersionId); await drain(); }
  const details = rows.map(row => repository.detail(row.id));
  const previous = details.find(p => p.sourceUrl?.includes('Id=12382'))!, current = details.find(p => p.sourceUrl?.includes('Id=12663'))!;
  report.documents = details.map(p => ({ id: p.id, versionId: p.currentVersionId, title: p.title, reference: p.referenceNumber, publicationDate: p.publicationDate, processing: p.processingState, error: p.processingError, obligations: p.obligations.length, summary: p.summary, references: p.references }));
  for (const detail of details) {
    assert.equal(detail.processingState, 'succeeded', JSON.stringify(detail.processingError)); assert.ok(detail.obligations.length);
    for (const obligation of detail.obligations) for (const evidence of obligation.evidence) validateEvidence(evidence, versionText(detail.currentVersionId));
    await page.goto('/#publication/' + detail.id); await expect(page.locator('.obligation')).toHaveCount(detail.obligations.length);
    await page.screenshot({ path: resolve(root, detail === previous ? 'previous-obligations.png' : 'current-obligations.png'), fullPage: true });
  }
  const reference = current.references.find(r => r.relation !== 'cites' && r.referenceNumber?.replace(/\s/g, '') === previous.referenceNumber?.replace(/\s/g, ''));
  assert.ok(reference, 'No extracted explicit predecessor relationship: do not invent one.');
  await page.goto('/#publication/' + current.id);
  await page.getByText('Link an existing predecessor and rerun', { exact: true }).click();
  await page.locator('#link-form [name=referenceId]').selectOption(reference.id);
  await page.locator('#link-form [name=predecessorPublicationId]').fill(previous.id);
  await page.locator('#link-form [name=predecessorVersionId]').fill(previous.currentVersionId);
  const linkResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/publications/${current.id}/predecessor`));
  await page.getByRole('button', { name: 'Link & compare' }).click();
  const linked = await linkResponse; assert.equal(linked.status(), 202, await linked.text());
  const accepted = await linked.json() as { comparisonId: string };
  await drain();
  const comparison = analysis.comparison(accepted.comparisonId); report.comparison = comparison;
  assert.equal(comparison.state, 'succeeded', JSON.stringify(comparison.issue)); assert.ok(comparison.changes.some(c => c.before));
  for (const change of comparison.changes) { validateEvidence(change.after, versionText(current.currentVersionId)); if (change.before) validateEvidence(change.before, versionText(previous.currentVersionId)); }
  await page.reload(); await expect(page.locator('#comparison')).toContainText('Succeeded');
  await page.locator('#review-form [name=state]').selectOption('inReview');
  await page.locator('#review-form [name=note]').fill('Historical RBI comparison verification only. Pending substantive human review; no current-applicability claim.');
  await page.getByRole('button', { name: 'Save review' }).click(); await expect(page.locator('.state-strip')).toContainText(/In Review/i);
  await page.reload(); await expect(page.locator('.state-strip')).toContainText(/In Review/i);
  await page.screenshot({ path: resolve(root, 'historical-comparison-review.png'), fullPage: true });
  await page.locator('#comparison').screenshot({ path: resolve(root, 'comparison-panel.png') });
  const counts = () => db.get<{ publications: number; versions: number }>('SELECT (SELECT count(*) FROM publications) publications, (SELECT count(*) FROM document_versions) versions')!;
  const before = counts(); await page.goto('/#sources'); await page.locator('[data-run]').click();
  await expect.poll(() => db.get<{ n: number }>("SELECT count(*) n FROM jobs WHERE kind='monitor' AND state='queued'")!.n).toBe(1); await drain();
  assert.deepEqual(counts(), before); assert.equal(repository.detail(current.id).review.state, 'inReview');
  const again = analysis.requestComparison(current.id, { currentVersionId: current.currentVersionId, predecessorVersionId: previous.currentVersionId }); assert.equal(again.comparisonId, comparison.id);
  Object.assign(report, { result: 'passed', duplicateFreeRerun: true, comparisonReused: true, counts: counts(), review: repository.detail(current.id).review, browser: 'Chrome via authenticated existing frontend proxy' });
} catch (error) { report.result = 'failed'; report.failure = error instanceof Error ? error.message : String(error); process.exitCode = 1; await page.screenshot({ path: resolve(root, 'failure.png'), fullPage: true }); }
finally {
  report.jobs = db.all('SELECT id,kind,state,error_json FROM analysis_jobs');
  report.originals = db.all('SELECT id,content_hash,original_key,metadata_json FROM document_versions');
  report.downloadDiagnostics = db.all("SELECT detail_json FROM job_events WHERE stage IN ('downloadDiagnostic','sourceError','extractionDiagnostic')");
  report.completedAt = new Date().toISOString(); await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await browser.close(); await vite.close(); await new Promise<void>(done => backend.close(() => done())); db.close();
  console.log(JSON.stringify({ result: report.result, failure: report.failure, artifacts: root }));
}
