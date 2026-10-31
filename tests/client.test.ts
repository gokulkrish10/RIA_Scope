import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_CONTRACT, PublicationDetailSchema } from '../src/shared/contracts/index.js';
import { apiErrorFixture, publicationFixture } from '../src/shared/fixtures/index.js';
import { ApiFailure, request } from '../src/client/api.js';
import { date, escape, evidence } from '../src/client/view.js';

test('API client substitutes opaque IDs, sends repeated filters, and validates a detail response', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, `/api/v1/publications/${publicationFixture.id}?country=SA&country=IN`);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.body, undefined);
      assert.equal(init?.credentials, 'same-origin');
      return Response.json(publicationFixture);
    };
    assert.deepEqual(await request(API_CONTRACT.readPublication, PublicationDetailSchema, {
      params: { publicationId: publicationFixture.id }, query: new URLSearchParams('country=SA&country=IN'),
    }), publicationFixture);
  } finally { globalThis.fetch = original; }
});

test('API client rejects invented fields rather than silently accepting server drift', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ ...publicationFixture, status: 'complete' });
    await assert.rejects(request(API_CONTRACT.readPublication, PublicationDetailSchema));
  } finally { globalThis.fetch = original; }
});

test('API errors retain status, correlation ID, and Retry-After for polling', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(apiErrorFixture, { status: 429, headers: { 'Retry-After': '7' } });
    await assert.rejects(request(API_CONTRACT.readPublication, PublicationDetailSchema), (error: unknown) => {
      assert.ok(error instanceof ApiFailure);
      assert.equal(error.status, 429); assert.equal(error.retryAfter, 7);
      assert.ok(error.message.includes(apiErrorFixture.requestId)); return true;
    });
  } finally { globalThis.fetch = original; }
});

test('a missing API returning HTML produces an actionable transport error', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('<html>Not found</html>', { status: 404 });
    await assert.rejects(request(API_CONTRACT.readPublication, PublicationDetailSchema), /backend is available/);
  } finally { globalThis.fetch = original; }
});

test('source date-only display preserves the supplied day and unknown values', () => {
  assert.equal(date('2026-10-30'), '2026-10-30'); assert.equal(date(null), 'Unknown');
});

test('source excerpts are escaped before highlighting differences', () => {
  assert.equal(escape('<script>"&'), '&lt;script&gt;&quot;&amp;');
  const rendered = evidence({ documentId: 'example', versionId: 'example', locator: '<section>', excerpt: '<script>alert(1)</script> changed' }, { documentId: 'example', versionId: 'example', locator: 'old', excerpt: 'changed' });
  assert.ok(!rendered.includes('<script>')); assert.ok(rendered.includes('<mark>&lt;script&gt;'));
  assert.ok(rendered.includes('&lt;section&gt;')); assert.ok(evidence(null).includes('new requirement'));
});
