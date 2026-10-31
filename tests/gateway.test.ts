import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { frontendAccess, frontendGateway } from '../src/backend/frontend-gateway.js';
import { ApiErrorSchema } from '../src/shared/contracts/index.js';

const password = 'synthetic-gateway-password-for-tests';
function attempt(url: string, headers: Record<string, string>) {
  let next = false, body = ''; const responseHeaders: Record<string, string> = {};
  const response = { statusCode: 200, setHeader(key: string, value: string) { responseHeaders[key] = value; }, end(value: string) { body = value; } };
  frontendAccess({ url, headers: { host: '127.0.0.1:5173', ...headers } } as IncomingMessage, response as unknown as ServerResponse, () => { next = true; }, 'operator', password);
  return { next, status: response.statusCode, body, headers: responseHeaders };
}
const auth = { authorization: 'Basic ' + Buffer.from('operator:' + password).toString('base64') };
test('gateway requires its own operator login and rejects backend token as browser authentication', () => {
  for (const headers of [{}, { authorization: 'Bearer synthetic-backend-token' }]) {
    const result = attempt('/api/v1/sources', headers);
    assert.equal(result.status, 401); assert.equal(result.next, false); ApiErrorSchema.parse(JSON.parse(result.body));
    assert.ok(!result.body.includes(password));
  }
  assert.equal(attempt('/api/v1/sources', auth).next, true);
});
test('gateway rejects foreign origins, DNS rebinding hosts and private paths before proxy/static serving', () => {
  for (const headers of [{ ...auth, origin: 'https://untrusted.invalid' }, { ...auth, 'sec-fetch-site': 'cross-site' }, { ...auth, host: 'untrusted.invalid:5173' }]) assert.equal(attempt('/api/v1/sources', headers).status, 403);
  for (const path of ['/.env', '/.env.local', '/.data/ria/originals/hash', '/@fs/tmp/.data/private.sqlite', '/%252edata/private.sqlite', '/.git/config', '/.aws/credentials', '/private.pem']) assert.equal(attempt(path, auth).status, 403);
});
test('gateway fails closed without explicit credentials or with an external upstream', () => {
  assert.throws(() => frontendGateway({}), /Configure/);
  assert.throws(() => frontendGateway({ RIA_WRITE_TOKEN: 'x'.repeat(32), RIA_FRONTEND_PASSWORD: password, RIA_API_ORIGIN: 'http://untrusted.invalid' }), /loopback/);
});
