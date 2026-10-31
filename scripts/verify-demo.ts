import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startDemo } from './demo-runtime.js';
import { parsePublicationSearchParams } from '../src/shared/contracts/index.js';
import { segmentPages, validateEvidence, type VersionText } from '../src/backend/analysis/evidence.js';

// Isolated copy of saved real evidence. No regulator requests or model calls.
const root = resolve('.data', `demo-verification-${Date.now()}`);
for (const [command, args] of [
  ['python3', ['scripts/prepare-level1-demo.py', '--output', root]],
  [process.execPath, ['--import', 'tsx', 'scripts/create-manual-fixtures.ts']],
] as const) assert.equal(spawnSync(command, [...args], { stdio: 'inherit' }).status, 0);
const env = {
  RIA_WRITE_TOKEN: 'synthetic-demo-verification-token-1234567890',
  RIA_FRONTEND_USER: 'test', RIA_FRONTEND_PASSWORD: 'synthetic-demo-verification-password-1234567890',
  RIA_REVIEWER_ID: '225dcc34-f02c-4c79-8bbc-d3d412730c53',
};
const uiPort = 4189;
let demo = await startDemo({ dataDir: root, port: 0, uiPort, env });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ httpCredentials: { username: env.RIA_FRONTEND_USER, password: env.RIA_FRONTEND_PASSWORD } });
await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const page = await context.newPage();
const pageErrors: string[] = [];
page.on('pageerror', e => pageErrors.push(e.message));
const url = `http://127.0.0.1:${uiPort}`;
const checks: string[] = [];
const currentId = '1d94a2af-7aeb-447a-906a-cf86ca79f35d';
const sourceId = '728db66c-4dfe-47ab-a613-eae7cd58276b';
try {
  const all = () => demo.repository.listPublications(parsePublicationSearchParams(new URLSearchParams('pageSize=100')));
  assert.equal(all().total, 7);
  assert.equal(new Set(all().items.map(p => p.country)).size, 5);
  const versions = new Map<string, VersionText>();
  for (const row of demo.repository.db.all<{ id: string; publication_id: string; metadata_json: string; extracted_pages_json: string }>('SELECT * FROM document_versions')) {
    versions.set(row.id, { publicationId: row.publication_id, versionId: row.id, documentId: JSON.parse(row.metadata_json).documentId, segments: segmentPages(JSON.parse(row.extracted_pages_json)) });
  }
  let citations = 0;
  for (const publication of all().items) {
    for (const obligation of demo.analysis.obligations(publication.id).obligations) {
      for (const evidence of obligation.evidence) { validateEvidence(evidence, versions.get(evidence.versionId)!); citations++; }
    }
  }
  const comparison = demo.analysis.comparison('5dda2072-ce8b-4dbf-b152-2939f5c6e5ee');
  assert.equal(comparison.changes.length, 3);
  for (const change of comparison.changes) for (const evidence of [change.before, change.after]) {
    if (evidence) { validateEvidence(evidence, versions.get(evidence.versionId)!); citations++; }
  }
  checks.push(`Seven saved real publications, five countries, ${citations} validated citations and three RBI historical changes`);
  assert.equal((await fetch(`http://127.0.0.1:${demo.backendPort}/api/v1/sources`)).status, 401);
  assert.equal((await fetch(url)).status, 401);
  const auth = { Authorization: 'Basic ' + Buffer.from(`${env.RIA_FRONTEND_USER}:${env.RIA_FRONTEND_PASSWORD}`).toString('base64') };
  for (const path of ['/.env', '/.data/level1-demo/ria.sqlite']) assert.equal((await fetch(url + path, { headers: auth })).status, 403);
  const denied = await fetch(`http://127.0.0.1:${demo.backendPort}/api/v1/publications/${currentId}/comparisons`, { method: 'POST', headers: { Authorization: `Bearer ${env.RIA_WRITE_TOKEN}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
  checks.push('Authentication and private-file protection; AI writes rejected immediately in saved mode');
  await page.goto(url + '/#repository');
  await expect(page.locator('.mode-banner')).toContainText('SAVED-EVIDENCE DEMO');
  await expect(page.locator('#content')).toContainText('Key Facts Statement');
  await page.goto(url + '/#publication/' + currentId);
  await expect(page.locator('.obligation')).toHaveCount(8);
  await expect(page.locator('.clause-grid')).toHaveCount(3);
  await expect(page.locator('#compare')).toBeDisabled();
  await expect(page.locator('.clause-grid').first()).toContainText('5.1');
  await page.locator('#review-form [name=state]').selectOption('inReview');
  await page.locator('#review-form [name=note]').fill('DEMO VERIFICATION ONLY: historical analysis, pending human review.');
  await page.getByRole('button', { name: 'Save review' }).click();
  await expect(page.locator('#notice')).toContainText('Review saved');
  checks.push('Saved real RBI obligations, cited old/new clauses, review saved through Chrome');
  for (const extension of ['txt', 'docx', 'pdf']) {
    await page.goto(url + '/#upload');
    await page.locator('[name=file]').setInputFiles(resolve('.data/manual-fixtures', 'manual-upload.' + extension));
    await page.locator('[name=title]').fill('SYNTHETIC demo verification ' + extension);
    await page.locator('[name=sourceId]').selectOption(sourceId);
    await page.locator('[name=referenceNumber]').fill('SYNTH-DEMO-' + extension);
    await page.getByRole('button', { name: 'Upload & process' }).click();
    await expect(page.locator('.state-strip')).toContainText('Succeeded', { timeout: 30000 });
    await expect(page.locator('#content')).toContainText('New AI analysis is paused');
    await expect(page.locator('#content')).toContainText('Unknown');
  }
  assert.equal(all().total, 10);
  assert.equal(demo.repository.db.get<{ n: number }>('SELECT count(*) n FROM version_analysis')!.n, 7);
  checks.push('TXT, DOCX and PDF uploads processed by the same worker; null dates and AI-pending state remain honest');
  await page.goto(url + '/#upload');
  await page.locator('[name=file]').setInputFiles(resolve('.data/manual-fixtures/unreadable.pdf'));
  await page.locator('[name=title]').fill('SYNTHETIC unreadable negative test');
  await page.locator('[name=sourceId]').selectOption(sourceId);
  await page.getByRole('button', { name: 'Upload & process' }).click();
  await expect(page.locator('#upload-state')).toContainText('Failed', { timeout: 30000 });
  await expect(page.locator('#upload-state')).not.toContainText('queued ingestion');
  await expect(page.locator('#notice')).toContainText('extraction failed');
  await expect(page.getByRole('button', { name: 'Upload & process' })).toBeEnabled();
  checks.push('Unreadable PDF shows terminal failure and releases the upload form');
  await page.goto(url + '/#repository');
  await page.locator('[name=q]').fill('Key Facts');
  await page.locator('[name=country]').selectOption('IN');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  checks.push('Search and country filter');
  await demo.close();
  // Same files, all services restarted. No copy or reset.
  demo = await startDemo({ dataDir: root, port: 0, uiPort, env });
  await page.goto(url + '/#publication/' + currentId);
  await expect(page.locator('#review-form [name=note]')).toHaveValue('DEMO VERIFICATION ONLY: historical analysis, pending human review.');
  assert.equal(demo.repository.detail(currentId).review.reviewedBy, env.RIA_REVIEWER_ID);
  assert.equal(all().total, 11);
  assert.equal(demo.repository.db.get<{ n: number }>("SELECT count(*) n FROM jobs WHERE state IN ('queued','running')")!.n, 0);
  checks.push('Full stop/restart keeps uploads, original files, review identity and the saved comparison; no stuck jobs');
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: resolve(root, 'rbi-demo.png'), fullPage: true });
  await writeFile(resolve(root, 'report.json'), JSON.stringify({ checks, pageErrors, externalFetches: 0, modelCalls: 0, note: 'Saved prior real model evidence plus isolated synthetic uploads. No fresh live verification.' }, null, 2) + '\n');
  console.log(JSON.stringify({ report: resolve(root, 'report.json'), checks }, null, 2));
} finally { await browser.close(); await demo.close(); }
