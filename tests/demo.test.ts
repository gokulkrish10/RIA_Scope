import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/backend/db.js';
import { Repository } from '../src/backend/repository.js';
import { createApi } from '../src/backend/api.js';
import { AnalysisService } from '../src/backend/analysis/service.js';
import { AnalysisEngine } from '../src/backend/analysis/engine.js';
import { API_CONTRACT, ApiErrorSchema } from '../src/shared/contracts/index.js';
import { startDemo } from '../scripts/demo-runtime.js';

test('saved demo rejects AI writes before enqueueing, preserves reads and requires authentication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ria-demo-policy-'));
  const db = new Database(join(root, 'ria.sqlite'));
  try {
    const repository = new Repository(db);
    let modelCalls = 0;
    const analysis = new AnalysisService(repository, new AnalysisEngine({ identity: 'test-never-called', async generate() { modelCalls++; throw new Error('Unexpected model call'); } }));
    const token = 'synthetic-demo-test-token-1234567890';
    const api = createApi(repository, token, { analysis, modelRequestsEnabled: false });
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    for (const endpoint of [API_CONTRACT.requestComparison, API_CONTRACT.linkPredecessor]) {
      const url = endpoint.path.replace(':publicationId', '1d94a2af-7aeb-447a-906a-cf86ca79f35d');
      assert.equal((await api.handle({ method: endpoint.method, url, headers: {}, body: {} })).status, 401);
      const response = await api.handle({ method: endpoint.method, url, headers, body: {} });
      assert.equal(response.status, 403);
      assert.match(ApiErrorSchema.parse(response.body).error.message, /paused/);
    }
    assert.equal((await api.handle({ method: 'GET', url: API_CONTRACT.listSources.path, headers })).status, 200);
    assert.equal(db.get<{ n: number }>('SELECT count(*) n FROM analysis_jobs')!.n, 0);
    assert.equal(modelCalls, 0);
    // Normal runtime remains enabled by default; it validates the actual request.
    const normal = createApi(repository, token, { analysis });
    assert.notEqual((await normal.handle({ method: 'POST', url: API_CONTRACT.requestComparison.path.replace(':publicationId', '1d94a2af-7aeb-447a-906a-cf86ca79f35d'), headers, body: {} })).status, 403);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('live demo fails before opening servers when temporary Bedrock configuration is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ria-demo-preflight-'));
  const db = new Database(join(root, 'ria.sqlite')); db.close();
  try {
    await assert.rejects(startDemo({ dataDir: root, port: 0, uiPort: 4189, liveAi: true, env: {
      RIA_WRITE_TOKEN: 'synthetic-demo-test-token-1234567890',
      RIA_FRONTEND_USER: 'test', RIA_FRONTEND_PASSWORD: 'synthetic-demo-password-1234567890',
      RIA_REVIEWER_ID: '225dcc34-f02c-4c79-8bbc-d3d412730c53',
    } }), /Bedrock is not configured/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
