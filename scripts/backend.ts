import { setTimeout as delay } from 'node:timers/promises';
import { Database } from '../src/backend/db.js';
import { Repository } from '../src/backend/repository.js';
import { config } from '../src/backend/config.js';
import { adapters, cbkAdapter, cbkSource, cbkListingSource, CBK_CHECKPOINT_OPTIONS } from '../src/backend/adapters/cbk.js';
import { OriginalStorage } from '../src/backend/storage.js';
import { Worker } from '../src/backend/worker.js';
import { createHttpServer } from '../src/backend/api.js';
import { AnalysisService } from '../src/backend/analysis/service.js';
import { AnalysisEngine } from '../src/backend/analysis/engine.js';
import { BedrockModel } from '../src/backend/analysis/bedrock.js';
import { IdSchema } from '../src/shared/contracts/index.js';
import { rbiAdapter, rbiSource, rbiListingSource, RBI_HISTORICAL_OPTIONS } from '../src/backend/adapters/rbi.js';
import { samaAdapter, samaSource, SAMA_OPTIONS } from '../src/backend/adapters/sama.js';
import { dfsaAdapter, dfsaSource, DFSA_OPTIONS } from '../src/backend/adapters/dfsa.js';
import { bogAdapter, bogSource, bogNoticesAdapter, bogNoticesSource, BOG_OPTIONS } from '../src/backend/adapters/bog.js';

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
  if (mode === 'seed') {
    repository.seedSource(cbkSource(repository.now()), cbkAdapter.key, CBK_CHECKPOINT_OPTIONS);
    repository.seedSource(cbkListingSource(repository.now()), cbkAdapter.key, { maxDocuments: 3 });
    repository.seedSource(rbiSource(repository.now()), rbiAdapter.key, RBI_HISTORICAL_OPTIONS);
    repository.seedSource(rbiListingSource(repository.now()), rbiAdapter.key, { maxDocuments: 2 });
    repository.seedSource(samaSource(repository.now()), samaAdapter.key, SAMA_OPTIONS);
    repository.seedSource(dfsaSource(repository.now()), dfsaAdapter.key, DFSA_OPTIONS);
    repository.seedSource(bogSource(repository.now()), bogAdapter.key, BOG_OPTIONS);
    repository.seedSource(bogNoticesSource(repository.now()), bogNoticesAdapter.key, BOG_OPTIONS);
  }
  console.log(mode === 'seed' ? 'CBK current/selected, Bank of Ghana directives/notices, RBI historical/current, SAMA and DFSA sources seeded. Source availability and extraction still require live verification.' : 'Database migrations applied.');
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
