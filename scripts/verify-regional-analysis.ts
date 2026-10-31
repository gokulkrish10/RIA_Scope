import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Database } from '../src/backend/db.js';
import { Repository } from '../src/backend/repository.js';
import { AnalysisService } from '../src/backend/analysis/service.js';
import { AnalysisEngine } from '../src/backend/analysis/engine.js';
import { BedrockModel } from '../src/backend/analysis/bedrock.js';

const directory = resolve(process.argv[2] ?? '');
if (!directory.includes('/.data/level1-four-region-')) throw new Error('Pass the isolated four-region verification directory.');
const database = new Database(join(directory, 'ria.sqlite'));
const repository = new Repository(database);
const analysis = new AnalysisService(repository, new AnalysisEngine(new BedrockModel()));
const prior = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')) as { sources: { region: string; sourceId: string }[] };
const regionFilter = process.argv[3];
const results = [];
try {
  for (const source of prior.sources) {
    if (regionFilter && source.region !== regionFilter) continue;
    const first = database.get<{ id: string; current_version_id: string }>('SELECT id,current_version_id FROM publications WHERE source_id=? ORDER BY id LIMIT 1', source.sourceId);
    if (!first) { results.push({ region: source.region, state: 'noPublication' }); continue; }
    const readable = database.get<{ extracted_text: string | null }>('SELECT extracted_text FROM document_versions WHERE id=?', first.current_version_id);
    if (!readable?.extracted_text) {
      results.push({ region: source.region, publicationId: first.id, state: 'extractionFailed', reason: 'No readable text was persisted; Bedrock was not called.' });
      console.log(`${source.region}: extraction failed; Bedrock not called`);
      continue;
    }
    const accepted = analysis.requestAnalysis(first.current_version_id);
    for (let step = 0; step < 40; step++) {
      const worked = await analysis.runOne();
      const state = analysis.job(accepted.jobId)?.state;
      if (state === 'succeeded' || state === 'failed') break;
      if (!worked) await new Promise(done => setTimeout(done, 250));
    }
    const job = analysis.job(accepted.jobId);
    const detail = repository.detail(first.id);
    const value = { region: source.region, publicationId: first.id, versionId: first.current_version_id, jobId: accepted.jobId, state: job?.state, error: job?.error ?? null, obligations: detail.obligations.length, references: detail.references.length, relationshipState: detail.relationshipState };
    results.push(value);
    console.log(`${source.region}: ${value.state}; ${value.obligations} cited obligations; ${value.references} references`);
  }
  await writeFile(join(directory, 'analysis-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), modelIdentity: analysis.engine.model.identity, results }, null, 2), { mode: 0o600 });
  console.log(`Report: ${join(directory, 'analysis-report.json')}`);
} finally { database.close(); }
