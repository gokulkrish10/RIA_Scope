import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AnalysisEngine } from '../src/backend/analysis/engine.js';
import { BedrockModel, bedrockSettings } from '../src/backend/analysis/bedrock.js';
import { segmentPages, validateEvidence, type VersionText } from '../src/backend/analysis/evidence.js';
import { publicObligations } from '../src/backend/analysis/validate.js';

if (process.argv[2] !== '--live' || process.argv.length !== 3) {
  throw new Error('This command invokes paid Bedrock inference. Run npm run verify:bedrock-smoke -- --live to opt in.');
}
bedrockSettings(); // Check explicit server-only configuration before creating an artifact or making a request.
process.umask(0o077);
const root = resolve('.data', `bedrock-smoke-${Date.now()}`);
await mkdir(root, { recursive: true, mode: 0o700 });
const sourceText = [
  'SYNTHETIC TEST ONLY. This is not a real regulatory publication.',
  'Section 1. Banks must provide a written receipt to each borrower before disbursing a digital loan.',
  'This text states no effective date or compliance deadline.',
].join('\n');
const version: VersionText = {
  publicationId: randomUUID(), documentId: randomUUID(), versionId: randomUUID(),
  segments: segmentPages([{ pageNumber: null, text: sourceText, locator: 'Synthetic test section 1' }]),
};
const model = new BedrockModel();
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), input: 'synthetic-only', liveBedrock: true, modelIdentity: model.identity, state: 'running' };
try {
  const result = await new AnalysisEngine(model).extract(version, { title: 'SYNTHETIC test circular', kind: 'circular', regulatorName: 'Synthetic test regulator' }, { read: () => null, write: () => {} }, new AbortController().signal);
  const obligations = publicObligations(result, version, false);
  assert.ok(obligations.length > 0, 'Bedrock returned no cited obligations for the synthetic duty.');
  assert.ok(obligations.some(obligation => /written receipt/i.test(obligation.text)), 'Bedrock did not identify the synthetic written-receipt duty.');
  for (const obligation of obligations) for (const evidence of obligation.evidence) validateEvidence(evidence, version);
  assert.equal(result.effectiveDate, null, 'An effective date was invented for a source without one.');
  assert.ok(obligations.every(obligation => obligation.complianceDeadline === null), 'A compliance deadline was invented for a source without one.');
  report.state = 'passed';
  report.obligations = obligations.map(obligation => ({ text: obligation.text, evidence: obligation.evidence.map(item => ({ locator: item.locator, excerpt: item.excerpt })) }));
  report.unknownDatesPreserved = true;
  console.log('Live Bedrock synthetic extraction passed: cited obligations and null dates verified.');
} catch (error) {
  report.state = 'failed';
  report.error = error instanceof Error ? error.message : 'Unknown failure';
  process.exitCode = 1;
  console.error(`Live Bedrock synthetic extraction failed: ${report.error}`);
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Private synthetic verification report: ${root}/report.json`);
}
