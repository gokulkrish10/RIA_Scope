import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Database } from '../src/backend/db.js';
import { Repository } from '../src/backend/repository.js';
import { OriginalStorage } from '../src/backend/storage.js';
import { Worker } from '../src/backend/worker.js';
import { adapters, cbkAdapter, cbkSource, cbkListingSource, CBK_CHECKPOINT_OPTIONS } from '../src/backend/adapters/cbk.js';
import { rbiAdapter, rbiListingSource } from '../src/backend/adapters/rbi.js';
import { samaAdapter, samaSource, SAMA_OPTIONS } from '../src/backend/adapters/sama.js';
import { dfsaAdapter, dfsaSource, DFSA_OPTIONS } from '../src/backend/adapters/dfsa.js';
import { bogAdapter, bogSource, bogNoticesAdapter, bogNoticesSource, BOG_OPTIONS } from '../src/backend/adapters/bog.js';

// An isolated live-source proof. It does not start Bedrock or modify the operator's database.
const directory = await mkdtemp(resolve('.data', 'level1-four-region-'));
const database = new Database(join(directory, 'ria.sqlite'));
const repository = new Repository(database);
const storage = new OriginalStorage(join(directory, 'originals'));
const worker = new Worker(repository, storage, adapters);
const sources = [
  { region: 'Saudi Arabia', adapter: samaAdapter, source: samaSource(repository.now()), options: SAMA_OPTIONS },
  { region: 'United Arab Emirates', adapter: dfsaAdapter, source: dfsaSource(repository.now()), options: DFSA_OPTIONS },
  { region: 'India', adapter: rbiAdapter, source: rbiListingSource(repository.now()), options: { maxDocuments: 2 } },
  { region: 'Ghana', adapter: bogAdapter, source: { ...bogSource(repository.now()), enabled: true }, options: BOG_OPTIONS },
  { region: 'Ghana notices', adapter: bogNoticesAdapter, source: bogNoticesSource(repository.now()), options: BOG_OPTIONS },
  { region: 'Kenya', adapter: cbkAdapter, source: cbkSource(repository.now()), options: CBK_CHECKPOINT_OPTIONS },
  { region: 'Kenya current listing', adapter: cbkAdapter, source: { ...cbkListingSource(repository.now()), enabled: true }, options: { maxDocuments: 3 } },
];
const result: Record<string, unknown>[] = [];
try {
  for (const entry of sources) repository.seedSource(entry.source, entry.adapter.key, entry.options);
  for (const entry of sources) {
    const cycles = [];
    for (let run = 1; run <= 2; run++) {
      const accepted = repository.triggerMonitor({ sourceIds: [entry.source.id] });
      for (let step = 0; step < 12; step++) {
        if (!await worker.runOne()) break;
      }
      const job = repository.job(accepted.jobId);
      cycles.push({ run, jobState: job.state, result: job.result, error: job.error });
    }
    const publications = database.all<{ id: string; title: string; state: string }>(
      `SELECT p.id, json_extract(p.discovery_json,'$.title') title,
       json_extract(p.discovery_json,'$.processingState') state
       FROM publications p WHERE p.source_id=? ORDER BY title`, entry.source.id);
    const versions = database.all<{ publication_id: string; version_number: number; extracted_characters: number | null; processing_state: string; processing_error: string | null }>(
      `SELECT v.publication_id,v.version_number,length(v.extracted_text) extracted_characters,
       json_extract(v.metadata_json,'$.processingState') processing_state,
       json_extract(v.metadata_json,'$.processingError.message') processing_error
       FROM document_versions v JOIN publications p ON p.id=v.publication_id WHERE p.source_id=?`, entry.source.id);
    result.push({ region: entry.region, sourceId: entry.source.id, cycles, publications, versions });
    console.log(`${entry.region}: ${cycles.map(cycle => cycle.jobState).join(' / ')}; ${publications.length} publications; ${versions.filter(version => version.extracted_characters).length} extracted versions`);
  }
  const report = { generatedAt: new Date().toISOString(), directory, sources: result };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Report: ${join(directory, 'report.json')}`);
} finally { database.close(); }
