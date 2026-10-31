import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { startDemo } from './demo-runtime.js';
import { BackendError } from '../src/backend/errors.js';

process.umask(0o077);
const { values } = parseArgs({ options: {
  'data-dir': { type: 'string', default: '.data/level1-demo' },
  port: { type: 'string', default: '4010' },
  'ui-port': { type: 'string', default: '5173' },
  'live-ai': { type: 'boolean', default: false },
} });
const dataDir = resolve(values['data-dir']);
const port = (value: string) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Demo ports must be integers from 1 to 65535.');
  return n;
};
try {
  // Deliberately ignore old RIA_DATA_DIR/PORT shell exports and .env settings.
  // All three components use these explicit options instead.
  const backendPort = port(values.port), uiPort = port(values['ui-port']);
  if (backendPort === uiPort) throw new Error('Backend and frontend ports must differ.');
  if (!existsSync(dataDir)) {
    const prepared = spawnSync('python3', ['scripts/prepare-level1-demo.py', '--output', dataDir], { stdio: 'inherit' });
    if (prepared.status !== 0) throw new Error('Demo preparation failed. See the missing saved-evidence path above; existing databases were not changed.');
  }
  const demo = await startDemo({ dataDir, port: backendPort, uiPort, liveAi: values['live-ai'], env: process.env });
  console.log(`\nDemo ready: http://127.0.0.1:${uiPort}/#repository`);
  console.log(`Backend + worker + frontend share: ${dataDir}/ria.sqlite`);
  console.log(values['live-ai']
    ? 'LIVE AI: new uploads and requested comparisons use Bedrock and may incur charges.'
    : 'SAVED EVIDENCE: existing AI findings are available; new uploads extract text only. No model calls.');
  console.log('Scheduler paused. Run now contacts official websites only when you request it. Ctrl+C stops all demo services.');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    console.log('\nStopping demo services…');
    void demo.close().catch(() => { process.exitCode = 1; });
  });
  void demo.failure.then(async message => {
    if (message) { console.error(message); process.exitCode = 1; await demo.close().catch(() => {}); }
  });
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(error instanceof BackendError ? error.message : code === 'EADDRINUSE' || (error instanceof Error && /already in use/.test(error.message))
    ? 'Demo port is already in use. Stop the old RIA terminal with Ctrl+C, then run npm run demo. No process was killed.'
    : 'Demo could not start. Check the saved data directory and server-only RIA_WRITE_TOKEN, RIA_FRONTEND_USER, RIA_FRONTEND_PASSWORD and RIA_REVIEWER_ID. See docs/LEVEL1_DEMO_PRESENTATION.md.');
  process.exitCode = 1;
}
