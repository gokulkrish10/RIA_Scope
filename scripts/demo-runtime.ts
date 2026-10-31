import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, type ViteDevServer } from 'vite';
import { Database } from '../src/backend/db.js';
import { Repository } from '../src/backend/repository.js';
import { OriginalStorage } from '../src/backend/storage.js';
import { Worker } from '../src/backend/worker.js';
import { adapters } from '../src/backend/adapters/cbk.js';
import { createHttpServer } from '../src/backend/api.js';
import { frontendGateway } from '../src/backend/frontend-gateway.js';
import { AnalysisService } from '../src/backend/analysis/service.js';
import { AnalysisEngine } from '../src/backend/analysis/engine.js';
import { BedrockModel, bedrockSettings } from '../src/backend/analysis/bedrock.js';
import { IdSchema } from '../src/shared/contracts/index.js';

/** Compose the existing services with ONE repository, worker and lifetime. */
export async function startDemo(options: {
  dataDir: string; port: number; uiPort: number; liveAi?: boolean; env: NodeJS.ProcessEnv;
}) {
  const dataDir = resolve(options.dataDir);
  await access(resolve(dataDir, 'ria.sqlite')); // Never silently open an empty demo.
  const token = options.env.RIA_WRITE_TOKEN ?? '';
  const reviewerId = IdSchema.parse(options.env.RIA_REVIEWER_ID);
  // Validate auth before opening the database. No environment values are logged.
  frontendGateway({ ...options.env, RIA_API_ORIGIN: 'http://127.0.0.1:4010' });
  if (options.liveAi) bedrockSettings(options.env); // Local validation only; no model request.
  const db = new Database(resolve(dataDir, 'ria.sqlite'));
  const repository = new Repository(db);
  const storage = new OriginalStorage(resolve(dataDir, 'originals'));
  const liveAi = options.liveAi === true;
  const analysis = new AnalysisService(repository, new AnalysisEngine(liveAi ? new BedrockModel(options.env) : {
    identity: 'saved-evidence-only',
    async generate() { throw new Error('Model execution is disabled in the saved-evidence demo.'); },
  }));
  const backend = createHttpServer(repository, token, { analysis, storage, reviewerId, modelRequestsEnabled: liveAi });
  let vite: ViteDevServer | undefined;
  let stopped = false;
  let loop: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    stopped = true;
    // Stop accepting work, finish the claimed job, then close SQLite.
    await Promise.all([
      vite?.close(),
      new Promise<void>(done => backend.close(() => done())),
    ]);
    try { await loop; } finally { db.close(); }
  })();
  try {
    await new Promise<void>((done, reject) => {
      backend.once('error', reject);
      backend.listen(options.port, '127.0.0.1', () => { backend.removeListener('error', reject); done(); });
    });
    const address = backend.address();
    if (!address || typeof address === 'string') throw new Error('Backend address unavailable');
    const gateway = frontendGateway({ ...options.env, RIA_API_ORIGIN: `http://127.0.0.1:${address.port}` });
    vite = await createServer({
      configFile: false,
      plugins: [...gateway.plugins, {
        name: 'ria-demo-mode',
        transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'ria-demo', content: liveAi ? 'live-ai' : 'saved' }, injectTo: 'head' }],
      }],
      server: {
        host: '127.0.0.1', port: options.uiPort, strictPort: true, proxy: gateway.proxy,
        fs: { deny: ['.env', '.env.*', '**/.data/**', '**/*.sqlite*', '**/.git/**', '**/.aws/**', '**/credentials', '**/*.{pem,key,crt}'] },
      },
    });
    await vite.listen();
    const worker = new Worker(repository, storage, adapters, undefined, 1000, 60_000,
      liveAi ? id => { analysis.requestAnalysis(id); } : undefined);
    loop = (async () => {
      while (!stopped) {
        // Scheduling is intentionally off. Manual monitoring requires a UI action.
        // Saved mode never claims analysis jobs, including jobs left by a live run.
        if (!await worker.runOne() && !(liveAi && await analysis.runOne())) await delay(250);
      }
    })();
    // A dead worker must not leave a healthy-looking frontend accepting uploads.
    const failure = loop.then(() => undefined, () => 'Demo worker stopped unexpectedly. Restart npm run demo; unfinished jobs are persisted.');
    return { close, failure, backendPort: address.port, repository, analysis };
  } catch (error) {
    await close();
    throw error;
  }
}
