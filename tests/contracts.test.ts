import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import * as c from '../src/shared/contracts/index.js';
import * as f from '../src/shared/fixtures/index.js';

for (const fixture of f.fixtureCases) {
  test(`valid JSON fixture: ${fixture.name}`, () => {
    assert.doesNotThrow(() => fixture.schema.parse(JSON.parse(JSON.stringify(fixture.value))));
  });
}

const invalid: Array<[string, z.ZodType, unknown]> = [
  ['numeric ID', c.IdSchema, 42],
  ['non-UUID ID', c.IdSchema, 'publication-1'],
  ['uppercase UUID', c.IdSchema, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'],
  ['impossible date', c.SourceDateSchema, '2026-02-30'],
  ['timestamp without timezone', c.SourceDateSchema, '2026-10-31T10:00:00.000'],
  ['non-UTC offset', c.SourceDateSchema, '2026-10-31T10:00:00.000+05:30'],
  ['timestamp without millisecond precision', c.UtcTimestampSchema, '2026-10-31T10:00:00Z'],
  ['date-only discovery', c.DiscoveredPublicationSchema, { ...f.discoveredFixture, discoveredAt: '2026-10-31' }],
  ['omitted nullable date', c.UploadMetadataSchema, { ...f.uploadMetadataFixture, publicationDate: undefined }],
  ['invented review enum', c.ReviewUpdateRequestSchema, { ...f.reviewRequestFixture, state: 'done' }],
  ['seventh change class', c.ChangeClassSchema, 'deadlineExtended'],
  ['missing clause locator', c.SourceEvidenceSchema, { ...f.evidenceFixture, locator: '' }],
  ['page zero', c.SourceEvidenceSchema, { ...f.evidenceFixture, pageNumber: 0 }],
  ['nullable optional page', c.SourceEvidenceSchema, { ...f.evidenceFixture, pageNumber: null }],
  ['untraceable obligation', c.ObligationSchema, { ...f.obligationFixture, evidence: [] }],
  ['unresolved reference with invented target', c.RegulatoryReferenceSchema, { ...f.unresolvedReferenceFixture, targetPublicationId: f.fixtureIds.predecessor }],
  ['resolved reference without target', c.RegulatoryReferenceSchema, { ...f.unresolvedReferenceFixture, resolution: 'resolved', reason: undefined }],
  ['ambiguous reference with one candidate', c.RegulatoryReferenceSchema, { ...f.ambiguousReferenceFixture, candidatePublicationIds: [f.fixtureIds.predecessor] }],
  ['fake resolved relationship', c.PublicationDetailSchema, { ...f.missingPredecessorPublicationFixture, relationshipState: 'resolved' }],
  ['unresolved publication with classifications', c.PublicationDetailSchema, { ...f.missingPredecessorPublicationFixture, changeClasses: ['noMaterialChange'] }],
  ['failed extraction without error', c.PublicationDetailSchema, { ...f.extractionFailedPublicationFixture, processingError: null }],
  ['failed extraction with obligations', c.PublicationDetailSchema, { ...f.extractionFailedPublicationFixture, obligations: [f.obligationFixture] }],
  ['version missing from publication', c.PublicationDetailSchema, { ...f.publicationFixture, currentVersionId: f.fixtureIds.predecessorVersion }],
  ['private storage path leaked', c.DocumentVersionSchema, { ...f.versionFixture, storagePath: '/private/bucket/file.pdf' }],
  ['credentials leaked', c.SourceConfigSchema, { ...f.sourcesFixture.items[0], apiKey: 'must-not-appear' }],
  ['credentials in URL', c.PublicUrlSchema, 'https://user:password@example.org/file'],
  ['secret URL parameter', c.PublicUrlSchema, 'https://example.org/file?access_token=private'],
  ['unknown error code', c.ApiErrorSchema, { ...f.apiErrorFixture, error: { ...f.apiErrorFixture.error, code: 'oops' } }],
  ['error without correlation ID', c.ApiErrorSchema, { ...f.apiErrorFixture, requestId: undefined }],
  ['stack trace leaked', c.ApiErrorSchema, { ...f.apiErrorFixture, stack: 'internal stack' }],
  ['page zero', c.PublicationListResponseSchema, { ...f.publicationPageFixture, page: 0 }],
  ['oversize page', c.PublicationListResponseSchema, { ...f.publicationPageFixture, pageSize: 101 }],
  ['inconsistent hasNextPage', c.PublicationListResponseSchema, { ...f.publicationPageFixture, hasNextPage: true }],
  ['missing items in page', c.PublicationListResponseSchema, { ...f.publicationPageFixture, total: 2 }],
  ['negative total', c.PublicationListResponseSchema, { ...f.emptyPageFixture, total: -1 }],
  ['empty source update', c.SourceUpdateRequestSchema, {}],
  ['unknown source update field', c.SourceUpdateRequestSchema, { frequency: 60 }],
  ['invalid monitoring frequency', c.SourceUpdateRequestSchema, { monitoringIntervalMinutes: 0 }],
  ['empty selected sources', c.MonitorRequestSchema, { sourceIds: [] }],
  ['repeated selected sources', c.MonitorRequestSchema, { sourceIds: [f.fixtureIds.source, f.fixtureIds.source] }],
  ['no direction on deadline change', c.ChangeItemSchema, { ...f.changeFixtures[3], deadlineDirection: undefined }],
  ['wrong deadline direction', c.ChangeItemSchema, { ...f.changeFixtures[3], deadlineDirection: 'shortened' }],
  ['equal changed deadlines', c.ChangeItemSchema, { ...f.changeFixtures[3], previousDeadline: '2027-03-31' }],
  ['mixed deadline precision', c.ChangeItemSchema, { ...f.changeFixtures[3], updatedDeadline: '2027-03-31T00:00:00.000Z' }],
  ['successful empty comparison', c.ComparisonSchema, { ...f.comparisonFixture, changes: [] }],
  ['no material change mixed with change', c.ComparisonSchema, { ...f.comparisonFixture, changes: [f.changeFixtures[3], f.changeFixtures[5]] }],
  ['wrong predecessor evidence', c.ComparisonSchema, { ...f.comparisonFixture, changes: [{ ...f.changeFixtures[3], before: f.evidenceFixture }] }],
  ['blocked comparison without references', c.ComparisonSchema, { ...f.missingComparisonFixture, unresolvedReferenceIds: [] }],
  ['blocked comparison with success issue', c.ComparisonSchema, { ...f.missingComparisonFixture, issue: null }],
  ['queued job with result', c.JobStatusSchema, { ...f.queuedJobFixture, result: f.succeededJobFixture.result }],
  ['succeeded job without result', c.JobStatusSchema, { ...f.succeededJobFixture, result: null }],
  ['failed job without error', c.JobStatusSchema, { ...f.failedJobFixture, error: null }],
  ['job/domain error mismatch', c.JobStatusSchema, { ...f.failedIngestionJobFixture, error: { ...f.extractionError, code: 'internalError' } }],
  ['blocked job without result', c.JobStatusSchema, { ...f.blockedJobFixture, result: null }],
  ['job result kind mismatch', c.JobStatusSchema, { ...f.succeededJobFixture, kind: 'ingestion' }],
  ['failed comparison reported as succeeded job', c.JobStatusSchema, { ...f.succeededJobFixture, result: { kind: 'comparison', comparison: f.failedComparisonFixture } }],
  ['failed extraction reported as succeeded job', c.JobStatusSchema, { ...f.succeededIngestionJobFixture, result: { kind: 'ingestion', publication: f.extractionFailedPublicationFixture } }],
  ['job completes before creation', c.JobStatusSchema, { ...f.succeededJobFixture, completedAt: '2020-01-01T00:00:00.000Z' }],
  ['success for failed monitor', c.MonitorRunResultSchema, { ...f.failedMonitorResultFixture, outcome: 'succeeded' }],
  ['monitor without sources', c.MonitorRunResultSchema, { ...f.monitorResultFixture, sources: [] }],
  ['monitor discovery without ingestion job', c.SourceMonitorResultSchema, { ...f.monitorResultFixture.sources[0], ingestionJobIds: [] }],
  ['accepted implies success', c.MonitorAcceptedResponseSchema, { ...f.acceptedMonitorFixture, state: 'succeeded' }],
  ['rejection without note', c.ReviewUpdateRequestSchema, { ...f.reviewRequestFixture, state: 'rejected', note: null }],
  ['rejected review response without note', c.ReviewRecordSchema, { ...f.reviewResponseFixture, state: 'rejected', note: null }],
  ['review missing concurrency token', c.ReviewUpdateRequestSchema, { state: 'approved', note: null }],
  ['empty upload', c.UploadFileDescriptorSchema, { fileName: 'test.pdf', mediaType: 'application/pdf', sizeBytes: 0 }],
  ['oversize upload', c.UploadFileDescriptorSchema, { fileName: 'test.pdf', mediaType: 'application/pdf', sizeBytes: c.UPLOAD_LIMITS.maxFileBytes + 1 }],
  ['MIME/extension mismatch', c.UploadFileDescriptorSchema, { fileName: 'test.docx', mediaType: 'application/pdf', sizeBytes: 100 }],
  ['unsafe filename', c.UploadFileDescriptorSchema, { fileName: '../test.pdf', mediaType: 'application/pdf', sizeBytes: 100 }],
  ['unsupported upload', c.UploadFileDescriptorSchema, { fileName: 'test.doc', mediaType: 'application/msword', sizeBytes: 100 }],
];
for (const [name, schema, value] of invalid) {
  test(`reject invalid payload: ${name}`, () => assert.equal(schema.safeParse(value).success, false));
}

test('all six classes and both deadline directions have fixtures', () => {
  assert.deepEqual(new Set(f.changeFixtures.map(v => v.classification)), new Set(c.ChangeClassSchema.options));
  assert.equal(c.DeadlineDirectionSchema.parse('extended'), 'extended');
  assert.equal(c.DeadlineDirectionSchema.parse('shortened'), 'shortened');
});
test('all job states have explicit fixtures', () => {
  assert.deepEqual(new Set([f.queuedJobFixture, f.runningJobFixture, f.succeededJobFixture, f.blockedJobFixture, f.failedJobFixture].map(v => v.state)), new Set(c.JobStateSchema.options));
});
test('source dates preserve null and date-only precision', () => {
  const parsed = c.DiscoveredPublicationSchema.parse({ ...f.discoveredFixture, publicationDate: null, effectiveDate: null });
  assert.equal(parsed.publicationDate, null);
  assert.equal(parsed.effectiveDate, null);
  assert.equal(c.SourceDateSchema.parse('2024-02-29'), '2024-02-29');
  assert.equal(c.SourceDateSchema.parse('2026-10-31T04:30:00.000Z'), '2026-10-31T04:30:00.000Z');
});
test('page number is optional and evidence is always traceable', () => {
  const { pageNumber: _, ...withoutPage } = f.evidenceFixture;
  assert.doesNotThrow(() => c.SourceEvidenceSchema.parse(withoutPage));
});
test('monitor partial result is explicit even when job completed successfully', () => {
  assert.equal(f.partialMonitorJobFixture.state, 'succeeded');
  assert.equal(f.partialMonitorResultFixture.outcome, 'partial');
  assert.equal(f.failedMonitorJobFixture.state, 'failed');
});
test('first publication may compare against no predecessor with evidence of new obligations', () => {
  assert.doesNotThrow(() => c.ComparisonSchema.parse({ ...f.comparisonFixture, predecessorPublicationId: null, predecessorDocumentId: null, predecessorVersionId: null, changes: [f.changeFixtures[0]] }));
});
test('source URLs retain public query identifiers', () => assert.equal(c.PublicUrlSchema.parse('https://example.org/circular?id=42'), 'https://example.org/circular?id=42'));
test('pagination defaults and repeated filters decode from URL', () => {
  assert.deepEqual(c.parsePaginationSearchParams(new URLSearchParams()), { page: 1, pageSize: 20 });
  const query = c.parsePublicationSearchParams(new URLSearchParams('country=SA&country=IN&businessArea=ai&changeClass=deadlineChanged&page=2&pageSize=10'));
  assert.deepEqual(query.country, ['SA', 'IN']);
  assert.equal(query.page, 2);
  assert.equal(query.pageSize, 10);
});
for (const query of ['page=0', 'page=1.5', 'page=01', 'pageSize=', 'page=1&page=2', 'country=SA,IN', 'country=SA&country=SA', 'changeClass=deadlineExtended', 'unknown=1', 'publicationDateFrom=2026-12-01&publicationDateTo=2026-01-01', 'page=9007199254740993']) {
  test(`reject invalid wire query: ${query}`, () => assert.throws(() => c.parsePublicationSearchParams(new URLSearchParams(query)), z.ZodError));
}
test('all upload formats and exact size boundary validate', () => {
  for (const [fileName, mediaType] of [['test.pdf', 'application/pdf'], ['test.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['test.txt', 'text/plain']]) {
    assert.doesNotThrow(() => c.UploadFileDescriptorSchema.parse({ fileName, mediaType, sizeBytes: c.UPLOAD_LIMITS.maxFileBytes }));
  }
});
test('every endpoint has a validated success response fixture', () => {
  const responses = {
    listSources: [200, f.sourcesFixture], updateSource: [200, f.sourcesFixture.items[0]],
    triggerMonitor: [202, f.acceptedMonitorFixture], readJob: [200, f.succeededJobFixture],
    readMonitorResult: [200, f.monitorResultFixture], uploadDocument: [202, f.acceptedUploadFixture],
    searchPublications: [200, f.publicationPageFixture], readPublication: [200, f.publicationFixture],
    readObligations: [200, f.obligationsResponseFixture], requestComparison: [202, f.acceptedComparisonFixture],
    readComparison: [200, f.comparisonFixture], linkPredecessor: [202, f.acceptedComparisonFixture], updateReview: [200, f.reviewResponseFixture],
  } satisfies Record<keyof typeof c.API_CONTRACT, [number, unknown]>;
  for (const [key, endpoint] of Object.entries(c.API_CONTRACT)) {
    const [status, value] = responses[key as keyof typeof responses];
    const schema = (endpoint.responses as Record<number, z.ZodType>)[status];
    assert.ok(schema);
    assert.doesNotThrow(() => schema.parse(value));
    for (const [status, schema] of Object.entries(endpoint.responses)) {
      if (Number(status) >= 400) assert.equal(schema, c.ApiErrorSchema);
    }
  }
});
test('every registry endpoint is documented with the same method and path', () => {
  const documentation = readFileSync(new URL('../docs/API_CONTRACT.md', import.meta.url), 'utf8');
  for (const endpoint of Object.values(c.API_CONTRACT)) {
    const escapedPath = endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(documentation, new RegExp(`${endpoint.method} (?:\x60)?${escapedPath}`));
  }
});
test('shared module imports are local or Zod; no server dependencies', () => {
  for (const directory of ['contracts', 'fixtures']) {
    const root = new URL(`../src/shared/${directory}/`, import.meta.url);
    for (const file of readdirSync(root).filter(f => f.endsWith('.ts'))) {
      const source = readFileSync(new URL(file, root), 'utf8');
      for (const match of source.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/g)) {
        assert.ok(match[1] === 'zod' || match[1]?.startsWith('.'), `Unsafe dependency in ${file}: ${match[1]}`);
      }
      assert.doesNotMatch(source, /\b(?:process\.env|require\s*\(|Buffer\.)/);
    }
  }
});
