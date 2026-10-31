import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ProxyOptions } from 'vite';
import { ApiErrorSchema } from '../shared/contracts/index.js';

const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export function frontendAccess(req: IncomingMessage, res: ServerResponse, next: () => void, user: string, password: string) {
  const deny = (status: number, code: 'unauthorized' | 'forbidden', message: string) => {
    res.statusCode = status;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="RIA local workspace", charset="UTF-8"');
    res.end(JSON.stringify(ApiErrorSchema.parse({ error: { code, message, retryable: false, details: [] }, requestId: randomUUID(), timestamp: new Date().toISOString() })));
  };
  const host = req.headers.host ?? '';
  if (!/^(?:localhost|127\.0\.0\.1)(?::[0-9]+)?$/.test(host)) return deny(403, 'forbidden', 'Use the loopback workspace address.');
  const origin = req.headers.origin;
  if ((origin && origin !== `http://${host}`) || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'] as string)) return deny(403, 'forbidden', 'Cross-origin workspace requests are forbidden.');
  const expected = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  if (!equal(req.headers.authorization ?? '', expected)) return deny(401, 'unauthorized', 'Sign in with the configured local workspace account.');
  let path = req.url?.split('?')[0] ?? '/';
  try { path = decodeURIComponent(decodeURIComponent(path)); } catch { return deny(403, 'forbidden', 'Invalid workspace path.'); }
  if (/(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.data|\.git|\.aws|credentials)(?:[/\\]|$)|\.(?:sqlite(?:-[a-z]+)?|pem|key|crt)$/i.test(path)) return deny(403, 'forbidden', 'Private workspace files are not served.');
  next();
}
export function frontendGateway(env: NodeJS.ProcessEnv = process.env): { plugins: Plugin[]; proxy: Record<string, ProxyOptions> } {
  const token = env.RIA_WRITE_TOKEN ?? '', password = env.RIA_FRONTEND_PASSWORD ?? '', user = env.RIA_FRONTEND_USER ?? 'gokul';
  if (token.length < 32 || password.length < 20 || !user || user.includes(':')) throw new Error('Configure server-only RIA_WRITE_TOKEN (32+ chars) and RIA_FRONTEND_PASSWORD (20+ chars), plus RIA_FRONTEND_USER.');
  const origin = new URL(env.RIA_API_ORIGIN ?? 'http://127.0.0.1:4010');
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('RIA_API_ORIGIN must be a loopback HTTP origin.');
  const access = (req: IncomingMessage, res: ServerResponse, next: () => void) => frontendAccess(req, res, next, user, password);
  return {
    plugins: [{ name: 'ria-local-authenticated-gateway', configureServer(server) { server.middlewares.use(access); }, configurePreviewServer(server) { server.middlewares.use(access); } }],
    proxy: { '/api/v1': { target: origin.origin, changeOrigin: true, configure(proxy) { proxy.on('proxyReq', request => { request.removeHeader('cookie'); request.setHeader('Authorization', `Bearer ${token}`); }); } } },
  };
}
