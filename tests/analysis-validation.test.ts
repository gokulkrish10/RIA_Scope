import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bedrockSettings, structuredResponse } from '../src/backend/analysis/bedrock.js';
import { publicObligations, validateComparison, validateExtraction } from '../src/backend/analysis/validate.js';
import { segmentPages, validateEvidence, type VersionText } from '../src/backend/analysis/evidence.js';
import { resolveReferences, relationshipState } from '../src/backend/analysis/resolve.js';
import { highlightDiff } from '../src/shared/presentation/diff.js';
import { changeFixtures, shortenedDeadlineFixture, fixtureIds } from '../src/shared/fixtures/index.js';
import { citationTransport } from '../src/backend/analysis/model-citations.js';
import { z } from 'zod';
import { ModelExtractionSchema } from '../src/backend/analysis/schemas.js';
import { AnalysisEngine } from '../src/backend/analysis/engine.js';
import { explicitClauseScope } from '../src/backend/analysis/clause-scope.js';
import type { ModelExtraction } from '../src/backend/analysis/schemas.js';

const text = 'Consultation. Proposed: banks shall retain records. Refer to CBK/2020/1 issued by Central Bank of Kenya.';
const current: VersionText = { publicationId: fixtureIds.publication, documentId: fixtureIds.document, versionId: fixtureIds.version, segments: segmentPages([{ pageNumber: 1, text }]) };
const evidence = { documentId: current.documentId, versionId: current.versionId, locator: current.segments[0]!.locator, pageNumber: 1, excerpt: 'banks shall retain records.' };
const extraction = ModelExtractionSchema.parse({ documentStatus: 'consultation', statusEvidence: [{ ...evidence, excerpt: 'Consultation.' }], businessAreas: ['banking'], effectiveDate: null, effectiveDateEvidence: [], obligations: [{ text: 'Retain records.', requirementStatus: 'proposed', businessAreas: ['banking'], applicableEntities: ['banks'], departments: [], regulatedActivities: [], effectiveDate: null, complianceDeadline: null, evidence: [evidence] }], references: [{ referenceText: 'CBK/2020/1', referenceNumber: 'CBK/2020/1', issuingAuthority: 'Central Bank of Kenya', relation: 'amends', evidence: [{ ...evidence, excerpt: 'Refer to CBK/2020/1 issued by Central Bank of Kenya.' }] }] });
test('Bedrock adapter accepts one structured tool object and rejects prose, truncation and duplicate outputs', () => {
  const block = { toolUse: { toolUseId: 'synthetic', name: 'record_analysis', input: { obligations: [] } } };
  assert.deepEqual(structuredResponse({ stopReason: 'tool_use', output: { message: { role: 'assistant', content: [block] } } }), { obligations: [] });
  assert.throws(() => structuredResponse({ stopReason: 'max_tokens', output: { message: { role: 'assistant', content: [block] } } }));
  assert.throws(() => structuredResponse({ stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text: '```json {} ```' }] } } }));
  assert.throws(() => structuredResponse({ stopReason: 'tool_use', output: { message: { role: 'assistant', content: [block, block] } } }));
});
test('synthetic extraction preserves unknown dates and consultations as proposed requirements', () => {
  const value = validateExtraction(extraction, current);
  const obligations = publicObligations(value, current, true);
  assert.equal(obligations[0]?.effectiveDate, null);
  assert.equal(obligations[0]?.complianceDeadline, null);
  assert.match(obligations[0]!.text, /^Proposed requirement:/);
  assert.deepEqual(publicObligations(value, current, true), obligations);
});
for (const [name, altered] of Object.entries({ inventedText: { ...evidence, excerpt: 'Banks must pay a penalty.' }, wrongPage: { ...evidence, pageNumber: 2 }, inventedLocator: { ...evidence, locator: 'Section 99' }, wrongVersion: { ...evidence, versionId: fixtureIds.predecessorVersion } })) {
  test(`reject synthetic invalid citation: ${name}`, () => assert.throws(() => validateEvidence(altered, current)));
}
test('invalid output and uncited document status cannot become extraction success', () => {
  assert.throws(() => validateExtraction({ ...extraction, obligations: [{ nonsense: true }] }, current));
  assert.throws(() => validateExtraction({ ...extraction, statusEvidence: [] }, current));
});
test('exact reference + authority resolution never substitutes a similar publication', () => {
  const entry = { publicationId: fixtureIds.predecessor, versionId: fixtureIds.predecessorVersion, regulatorId: fixtureIds.regulator, regulatorName: 'Central Bank of Kenya', referenceNumber: 'CBK/2020/1' };
  const resolved = resolveReferences(extraction, current, [entry]);
  assert.equal(resolved[0]?.resolution, 'resolved');
  assert.equal(relationshipState(resolved), 'resolved');
  assert.equal(relationshipState(resolveReferences(extraction, current, [{ ...entry, referenceNumber: 'CBK/2020/2' }])), 'missingPredecessor');
  assert.equal(relationshipState(resolveReferences(extraction, current, [{ ...entry, regulatorName: 'Different regulator' }])), 'missingPredecessor');
  assert.equal(relationshipState(resolveReferences(extraction, current, [entry, { ...entry, publicationId: fixtureIds.comparison }])), 'ambiguous');
  const inventedAuthority = { ...extraction, references: extraction.references.map(r => ({ ...r, issuingAuthority: 'Invented regulator' })) };
  assert.equal(relationshipState(resolveReferences(inventedAuthority, current, [{ ...entry, regulatorName: 'Invented regulator' }])), 'missingPredecessor');
});
for (const change of [...changeFixtures, shortenedDeadlineFixture]) {
  test(`synthetic supported classification: ${change.classification}${'deadlineDirection' in change ? ':' + change.deadlineDirection : ''}`, () => {
    const current: VersionText = { publicationId: fixtureIds.publication, documentId: change.after.documentId, versionId: change.after.versionId, segments: [{ locator: change.after.locator, pageNumber: change.after.pageNumber ?? null, text: change.after.excerpt }] };
    const previous: VersionText | null = change.before ? { publicationId: fixtureIds.predecessor, documentId: change.before.documentId, versionId: change.before.versionId, segments: [{ locator: change.before.locator, pageNumber: change.before.pageNumber ?? null, text: change.before.excerpt }] } : null;
    const result = validateComparison({ evidenceComplete: true, unresolvedReason: null, changes: [change] }, current, previous);
    assert.equal(result[0]?.classification, change.classification);
    const diff = highlightDiff(change.before?.excerpt ?? '', change.after.excerpt);
    assert.equal(diff.filter(d => d.kind !== 'added').map(d => d.text).join(''), change.before?.excerpt ?? '');
    assert.equal(diff.filter(d => d.kind !== 'removed').map(d => d.text).join(''), change.after.excerpt);
  });
}
test('different transition/commencement dates do not establish a deadline extension', () => {
  const template = changeFixtures.find(c => c.classification === 'deadlineChanged')!;
  assert.ok(template.before);
  const before = { ...template.before, excerpt: 'Existing loans must comply by November 30, 2022.' };
  const after = { ...template.after, excerpt: 'New loans sanctioned on or after October 1, 2024 must comply.' };
  const prior: VersionText = { publicationId: fixtureIds.predecessor, documentId: before.documentId, versionId: before.versionId, segments: [{ locator: before.locator, pageNumber: before.pageNumber ?? null, text: before.excerpt }] };
  const next: VersionText = { publicationId: fixtureIds.publication, documentId: after.documentId, versionId: after.versionId, segments: [{ locator: after.locator, pageNumber: after.pageNumber ?? null, text: after.excerpt }] };
  assert.throws(() => validateComparison({ evidenceComplete: true, unresolvedReason: null, changes: [{ ...template, before, after, previousDeadline: '2022-11-30', updatedDeadline: '2024-10-01' }] }, next, prior), /same deadline/);
});
test('similar durations do not justify pairing cooling-off duties with offer validity', () => {
  const template = changeFixtures.find(c => c.classification === 'modifiedObligation')!;
  assert.ok(template.before);
  const before = { ...template.before, excerpt: 'The cooling-off period must be at least three days.' };
  const after = { ...template.after, excerpt: 'The offer has a validity period of three working days.' };
  const prior: VersionText = { publicationId: fixtureIds.predecessor, documentId: before.documentId, versionId: before.versionId, segments: [{ locator: before.locator, pageNumber: before.pageNumber ?? null, text: before.excerpt }] };
  const next: VersionText = { publicationId: fixtureIds.publication, documentId: after.documentId, versionId: after.versionId, segments: [{ locator: after.locator, pageNumber: after.pageNumber ?? null, text: after.excerpt }] };
  assert.throws(() => validateComparison({ evidenceComplete: true, unresolvedReason: null, changes: [{ ...template, before, after }] }, next, prior), /different obligations/);
});
test('explicit partial amendments select named clauses and their source introduction, never similar duties', () => {
  const prior = { ...current, segments: segmentPages([{ pageNumber: null, text: '1. Retain records.' }, { pageNumber: null, text: '2.1. Report annual figures.' }, { pageNumber: null, text: '3. Unrelated cooling-off period.' }]) };
  const next = { ...current, segments: segmentPages([{ pageNumber: null, text: 'The following provisions are repealed.' }, { pageNumber: null, text: 'OLD/1 | Paragraphs 1, 2.1 of Synthetic Prior Circular' }, { pageNumber: null, text: 'A different offer validity period applies.' }]) };
  const context = { previousPublication: { title: 'Synthetic Prior Circular' }, supportedRelationships: [{ referenceNumber: 'OLD/1', evidence: [] }] };
  const scope = explicitClauseScope(next, prior, context);
  assert.deepEqual(scope.scope?.predecessorClauseNumbers, ['1', '2.1']);
  assert.equal(scope.current.segments.length, 2); assert.equal(scope.previous!.segments.length, 2);
  assert.doesNotMatch(scope.current.segments.map(s => s.text).join(' '), /validity/);
  assert.throws(() => explicitClauseScope(next, { ...prior, segments: prior.segments.slice(0, 1) }, context), /clauses are absent/);
  assert.throws(() => explicitClauseScope({ ...next, segments: segmentPages([{ pageNumber: null, text: 'OLD/1 Paragraphs 1-9 are repealed.' }]) }, prior, context), /range/);
});
test('missing comparison evidence is unresolved, never noMaterialChange', () => {
  assert.throws(() => validateComparison({ evidenceComplete: false, unresolvedReason: 'No predecessor clause found.', changes: [] }, current, null), /unresolved/);
  assert.throws(() => validateComparison({ evidenceComplete: true, unresolvedReason: null, changes: [changeFixtures[3]] }, current, null));
});
test('temporary credentials must be explicit and valid; errors do not echo secrets', () => {
  assert.throws(() => bedrockSettings({}), /AWS_SESSION_TOKEN/);
  const env = { AWS_ACCESS_KEY_ID: 'synthetic-key', AWS_SECRET_ACCESS_KEY: 'synthetic-private-secret', AWS_SESSION_TOKEN: 'synthetic-session', AWS_REGION: 'us-east-1', BEDROCK_MODEL_ID: 'synthetic-model', AWS_CREDENTIAL_EXPIRATION: '2020-01-01T00:00:00.000Z' };
  assert.throws(() => bedrockSettings(env), e => e instanceof Error && /expired/.test(e.message) && !e.message.includes('synthetic-private-secret'));
});
test('validated chunk caching makes repeat analysis idempotent and resumes after model errors', async () => {
  let calls = 0;
  const cacheValues = new Map<string, ModelExtraction>();
  const cache = { read: (key: string) => cacheValues.get(key) ?? null, write: (key: string, value: ModelExtraction) => { cacheValues.set(key, value); } };
  const version: VersionText = { ...current, segments: segmentPages([{ pageNumber: 1, text: 'x'.repeat(20_000) }]) };
  const empty = { documentStatus: null, statusEvidence: [], businessAreas: [], effectiveDate: null, effectiveDateEvidence: [], obligations: [], references: [] };
  const model = { identity: 'synthetic-test-model-v1', async generate() { if (++calls === 2) throw new Error('Synthetic model interruption'); return empty; } };
  const engine = new AnalysisEngine(model);
  const context = { title: 'Synthetic fixture', kind: 'circular', regulatorName: 'Synthetic regulator' };
  await assert.rejects(engine.extract(version, context, cache, new AbortController().signal));
  assert.equal(cacheValues.size, 1);
  await engine.extract(version, context, cache, new AbortController().signal);
  assert.equal(calls, version.segments.length + 1);
  await engine.extract(version, context, cache, new AbortController().signal);
  assert.equal(calls, version.segments.length + 1);
});
test('invalid citations never enter the analysis cache', async () => {
  let writes = 0;
  const engine = new AnalysisEngine({ identity: 'synthetic-invalid', async generate() { return { ...extraction, statusEvidence: [{ ...evidence, excerpt: 'Invented status.' }] }; } });
  await assert.rejects(engine.extract(current, { title: 'Synthetic', kind: 'consultation', regulatorName: 'Synthetic' }, { read: () => null, write: () => { writes++; } }, new AbortController().signal));
  assert.equal(writes, 0);
});
test('model quote IDs restore only server-owned exact evidence; unknown IDs and cross-version evidence fail', () => {
  const transport = citationTransport(current, z.toJSONSchema(ModelExtractionSchema));
  const quote = transport.catalog.q1!;
  assert.equal(quote.excerpt, current.segments[0]!.text);
  assert.deepEqual(transport.restore({ evidence: [{ quoteId: 'q1' }] }), { evidence: [quote] });
  assert.throws(() => transport.restore({ quoteId: 'invented' }));
  assert.throws(() => transport.restore({ quoteId: 'q1', excerpt: 'Invented text' }));
  assert.throws(() => transport.restore({ quoteId: '__proto__' }));
  const evidenceSchema = (transport.schema as { properties: { statusEvidence: { items: { properties: unknown } } } }).properties.statusEvidence.items.properties;
  assert.deepEqual(evidenceSchema, { quoteId: { type: 'string', enum: ['q1'] } });
  assert.throws(() => validateEvidence(quote, { ...current, versionId: fixtureIds.predecessorVersion }));
});
test('a rejected schema gets one bounded correction attempt and only corrected output enters the cache', async () => {
  let calls = 0, writes = 0;
  const empty = { documentStatus: null, statusEvidence: [], businessAreas: [], effectiveDate: null, effectiveDateEvidence: [], obligations: [], references: [] };
  const model = { identity: 'synthetic-schema-repair', async generate(_prompt: string, payload: unknown) {
    calls++;
    if (calls === 1) return { ...empty, documentStatus: 'unknown' };
    assert.match((payload as { validationFeedback: string }).validationFeedback, /documentStatus/);
    return empty;
  } };
  const result = await new AnalysisEngine(model).extract(current, { title: 'Synthetic', kind: 'guideline', regulatorName: 'Synthetic' }, { read: () => null, write: () => { writes++; } }, new AbortController().signal);
  assert.equal(result.documentStatus, null);
  assert.equal(calls, 2);
  assert.equal(writes, 1);
});
