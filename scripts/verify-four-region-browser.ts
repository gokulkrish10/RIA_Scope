import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { Database } from '../src/backend/db.js';
import { Repository } from '../src/backend/repository.js';
import { OriginalStorage } from '../src/backend/storage.js';
import { AnalysisService } from '../src/backend/analysis/service.js';
import { AnalysisEngine } from '../src/backend/analysis/engine.js';
import { BedrockModel } from '../src/backend/analysis/bedrock.js';
import { createHttpServer } from '../src/backend/api.js';
import { frontendGateway } from '../src/backend/frontend-gateway.js';
import { segmentPages, validateEvidence } from '../src/backend/analysis/evidence.js';

const directory = resolve(process.argv[2] ?? '');
if (!directory.includes('/.data/level1-four-region-')) throw new Error('Pass the isolated four-region verification directory.');
const user = process.env.RIA_FRONTEND_USER;
const password = process.env.RIA_FRONTEND_PASSWORD;
const token = process.env.RIA_WRITE_TOKEN;
assert.ok(user && password && token, 'Set local operator and backend authentication in the ignored environment.');
const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')) as { sources: { region: string; sourceId: string }[] };
const db = new Database(join(directory, 'ria.sqlite'));
const repository = new Repository(db);
const storage = new OriginalStorage(join(directory, 'originals'));
const analysis = new AnalysisService(repository, new AnalysisEngine(new BedrockModel()));
const backend = createHttpServer(repository, token, { analysis, storage });
await new Promise<void>(done => backend.listen(0, '127.0.0.1', done));
const address = backend.address(); assert.ok(address && typeof address !== 'string');
const gateway = frontendGateway({ ...process.env, RIA_API_ORIGIN: `http://127.0.0.1:${address.port}` });
const vite = await createServer({ configFile: false, plugins: gateway.plugins, server: { host: '127.0.0.1', port: 4181, strictPort: true, proxy: gateway.proxy, fs: { deny: ['.env', '.env.*', '**/.data/**', '**/*.sqlite*', '**/.git/**'] } } });
await vite.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4181', httpCredentials: { username: user, password } });
const page = await context.newPage();
const outcome: Record<string, unknown> = { state: 'running', checkedAt: new Date().toISOString(), regions: [] };
try {
  await page.goto('/#sources');
  for (const source of report.sources) await expect(page.locator('#content')).toContainText(repository.sourceById(source.sourceId).config.name);
  await page.goto('/#repository');
  for (const source of report.sources) {
    const row = db.get<{ id: string; discovery_json: string }>('SELECT id,discovery_json FROM publications WHERE source_id=? ORDER BY id LIMIT 1', source.sourceId);
    assert.ok(row, `${source.region} has no stored publication`);
    const title = (JSON.parse(row.discovery_json) as { title: string }).title;
    await page.goto('/#publication/' + row.id);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    const detail = repository.detail(row.id);
    await expect(page.locator('.obligation')).toHaveCount(detail.obligations.length);
    if (detail.obligations.length) {
      await expect(page.locator('.obligation blockquote').first()).toBeVisible();
      const version = db.get<{ metadata_json: string; extracted_pages_json: string }>('SELECT metadata_json,extracted_pages_json FROM document_versions WHERE id=?', detail.currentVersionId)!;
      const documentId = (JSON.parse(version.metadata_json) as { documentId: string }).documentId;
      const persisted = { publicationId: row.id, documentId, versionId: detail.currentVersionId, segments: segmentPages(JSON.parse(version.extracted_pages_json) as { pageNumber: number | null; text: string; locator?: string }[]) };
      for (const obligation of detail.obligations) for (const evidence of obligation.evidence) validateEvidence(evidence, persisted);
    }
    (outcome.regions as object[]).push({ region: source.region, title, obligations: detail.obligations.length, shown: true });
  }
  outcome.state = 'passed';
  await page.screenshot({ path: join(directory, 'four-region-browser.png'), fullPage: true });
} catch (error) {
  outcome.state = 'failed';
  outcome.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  await page.screenshot({ path: join(directory, 'four-region-browser-failure.png'), fullPage: true });
} finally {
  await browser.close(); await vite.close(); await new Promise<void>(done => backend.close(() => done())); db.close();
  await writeFile(join(directory, 'browser-report.json'), JSON.stringify(outcome, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(outcome));
}
