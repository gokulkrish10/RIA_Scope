import { setTimeout as delay } from 'node:timers/promises';
import { Database } from '../src/backend/db.js';
import { Repository } from '../src/backend/repository.js';
import { config } from '../src/backend/config.js';
import { adapters, cbkAdapter, cbkSource, CBK_CHECKPOINT_OPTIONS } from '../src/backend/adapters/cbk.js';
import { OriginalStorage } from '../src/backend/storage.js';
import { Worker } from '../src/backend/worker.js';
import { createHttpServer } from '../src/backend/api.js';
import { AnalysisService } from '../src/backend/analysis/service.js';
import { AnalysisEngine } from '../src/backend/analysis/engine.js';
import { BedrockModel } from '../src/backend/analysis/bedrock.js';
import { IdSchema } from '../src/shared/contracts/index.js';

process.umask(0o077);
const mode = process.argv[2] ?? 'serve';
if (!['migrate', 'seed', 'serve', 'worker', 'worker-once', 'analyze'].includes(mode)) throw new Error('Unknown backend command');
const options = config();
const db = new Database(options.databasePath);
const repository = new Repository(db);
const storage = new OriginalStorage(options.storagePath);
const analysis = new AnalysisService(repository, new AnalysisEngine(new BedrockModel()));
const autoAnalysis = process.env.RIA_ANALYSIS_ENABLED !== 'false';
if (mode === 'migrate' || mode === 'seed') {
  if (mode === 'seed') repository.seedSource(cbkSource(repository.now()), cbkAdapter.key, CBK_CHECKPOINT_OPTIONS);
  console.log(mode === 'seed' ? 'Official CBK source seeded (scoped to the LIBOR guidance for this checkpoint).' : 'Database migrations applied.');
  db.close();
} else if (mode === 'analyze') {
  console.log(JSON.stringify(analysis.requestAnalysis(IdSchema.parse(process.argv[3]))));
  db.close();
} else if (mode === 'serve') {
  const reviewerId = process.env.RIA_REVIEWER_ID ? IdSchema.parse(process.env.RIA_REVIEWER_ID) : undefined;
  const server = createHttpServer(repository, options.writeToken, { analysis, storage, ...(reviewerId ? { reviewerId } : {}) });
  server.listen(options.port, '127.0.0.1', () => console.log(`RIA backend listening at http://127.0.0.1:${options.port}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => db.close()));
} else {
  const worker = new Worker(repository, storage, adapters, undefined, 1000, 60_000, autoAnalysis ? id => { analysis.requestAnalysis(id); } : undefined);
  if (mode === 'worker-once') { if (autoAnalysis) analysis.queueMissing(); if (!await worker.runOne()) await analysis.runOne(); db.close(); }
  else {
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping = true; });
    while (!stopping) {
      if (options.scheduled) repository.scheduleDue();
      if (autoAnalysis) analysis.queueMissing();
      if (!await worker.runOne() && !await analysis.runOne()) await delay(1000);
    }
    db.close();
  }
}
