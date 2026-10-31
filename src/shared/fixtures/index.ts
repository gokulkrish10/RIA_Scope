import { z } from 'zod';
import * as c from '../contracts/index.js';

// Entirely synthetic: example.org URLs and invented circulars, clauses and obligations.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
export const fixtureIds = {
  publication: id(1), document: id(2), version: id(3), predecessor: id(4),
  predecessorDocument: id(5), predecessorVersion: id(6), reference: id(7),
  comparison: id(8), job: id(9), ingestionJob: id(10), monitorJob: id(11),
  source: id(20), regulator: id(30), reviewer: id(40), request: id(50),
};
const f = fixtureIds;
const createdAt = '2026-10-31T04:30:00.000Z';
const startedAt = '2026-10-31T04:30:01.000Z';
const completedAt = '2026-10-31T04:30:05.000Z';
const error = (code: c.ErrorInfo['code'], message: string) => c.ErrorInfoSchema.parse({ code, message, retryable: false, details: [] });
export const missingPredecessorError = error('missingPredecessor', 'Referenced circular DEMO/2025/01 has not been uploaded.');
export const extractionError = error('extractionFailed', 'No readable text could be extracted from this synthetic document.');
export const sourcesFixture = c.SourceListResponseSchema.parse({
  items: [
    { country: 'SA', region: 'ksa', name: 'Synthetic Saudi source' },
    { country: 'AE', region: 'uae', name: 'Synthetic UAE source' },
    { country: 'IN', region: 'india', name: 'Synthetic India source' },
    { country: 'ZA', region: 'africa', name: 'Synthetic South Africa source' },
  ].map((s, i) => ({
    ...s, id: id(20 + i), regulatorId: id(30 + i), regulatorName: `${s.name} regulator`,
    url: `https://example.org/regulators/${s.country.toLowerCase()}`, enabled: true,
    monitoringIntervalMinutes: 60, lastMonitoredAt: null, nextMonitorAt: createdAt, createdAt, updatedAt: createdAt,
  })),
  page: 1, pageSize: 20, total: 4, hasNextPage: false,
});
export const discoveredFixture = c.DiscoveredPublicationSchema.parse({
  id: f.publication, sourceId: f.source, title: 'SYNTHETIC: AI lending governance amendment', country: 'SA',
  regulatorId: f.regulator, regulatorName: 'Synthetic Saudi source regulator', kind: 'amendment',
  referenceNumber: 'DEMO/2026/02', publicationDate: '2026-10-30', effectiveDate: null,
  discoveredAt: createdAt, sourceUrl: 'https://example.org/circulars/demo-2026-02.pdf',
});
export const versionFixture = c.DocumentVersionSchema.parse({
  id: f.version, documentId: f.document, publicationId: f.publication, versionNumber: 1,
  fileName: 'demo-2026-02.pdf', mediaType: 'application/pdf', sizeBytes: 1024,
  ingestionMethod: 'monitor', sourceUrl: discoveredFixture.sourceUrl, createdAt,
  extractedAt: completedAt, processingState: 'succeeded', processingError: null,
});
export const htmlVersionFixture = c.DocumentVersionSchema.parse({ ...versionFixture, fileName: 'synthetic-notification.html', mediaType: 'text/html', sourceUrl: 'https://example.org/synthetic-notification.html' });
export const evidenceFixture = c.SourceEvidenceSchema.parse({
  documentId: f.document, versionId: f.version, locator: 'Section 4.2', pageNumber: 2,
  excerpt: 'The deadline in DEMO/2025/01 is extended to 31 March 2027.',
});
const previousEvidence = c.SourceEvidenceSchema.parse({
  documentId: f.predecessorDocument, versionId: f.predecessorVersion, locator: 'Section 4.2', pageNumber: 1,
  excerpt: 'Institutions must complete model governance review by 31 December 2026.',
});
export const obligationFixture = c.ObligationSchema.parse({
  id: id(60), publicationId: f.publication, text: 'Complete model governance review by 31 March 2027.',
  businessAreas: ['ai', 'lending'], applicableEntities: ['Licensed lenders'], departments: ['Risk'],
  regulatedActivities: ['AI-assisted lending'], effectiveDate: null, complianceDeadline: '2027-03-31',
  evidence: [evidenceFixture],
});
export const unresolvedReferenceFixture = c.RegulatoryReferenceSchema.parse({
  id: f.reference, referenceText: 'DEMO/2025/01', referenceNumber: 'DEMO/2025/01', relation: 'amends',
  evidence: [evidenceFixture], resolution: 'unresolved', reason: 'No matching predecessor is in the repository.',
});
export const ambiguousReferenceFixture = c.RegulatoryReferenceSchema.parse({
  ...unresolvedReferenceFixture, resolution: 'ambiguous', reason: 'Two candidate circulars share this reference number.',
  candidatePublicationIds: [f.predecessor, id(100)],
});
const resolvedReference = c.RegulatoryReferenceSchema.parse({
  id: f.reference, referenceText: 'DEMO/2025/01', referenceNumber: 'DEMO/2025/01', relation: 'amends',
  evidence: [evidenceFixture], resolution: 'resolved', targetPublicationId: f.predecessor, targetVersionId: f.predecessorVersion,
});
export const publicationSummaryFixture = c.PublicationSummarySchema.parse({
  ...discoveredFixture, documentId: f.document, currentVersionId: f.version, businessAreas: ['ai', 'lending'],
  processingState: 'succeeded', processingError: null,
  review: { state: 'pending', note: null, reviewedBy: null, updatedAt: createdAt },
  relationshipState: 'resolved', changeClasses: ['deadlineChanged'], latestComparisonId: f.comparison, updatedAt: completedAt,
});
export const publicationFixture = c.PublicationDetailSchema.parse({
  ...publicationSummaryFixture, summary: 'SYNTHETIC: Model review deadline extended by three months.',
  versions: [versionFixture], obligations: [obligationFixture], references: [resolvedReference],
});
export const missingPredecessorPublicationFixture = c.PublicationDetailSchema.parse({
  ...publicationFixture, relationshipState: 'missingPredecessor', changeClasses: [], references: [unresolvedReferenceFixture],
});
export const ambiguousPublicationFixture = c.PublicationDetailSchema.parse({
  ...publicationFixture, relationshipState: 'ambiguous', changeClasses: [], references: [ambiguousReferenceFixture],
});
export const extractionFailedPublicationFixture = c.PublicationDetailSchema.parse({
  ...publicationFixture, processingState: 'failed', processingError: extractionError,
  relationshipState: 'unchecked', changeClasses: [], latestComparisonId: null, summary: null, obligations: [], references: [],
  versions: [{ ...versionFixture, processingState: 'failed', processingError: extractionError, extractedAt: null }],
});
export const queuedPublicationFixture = c.PublicationDetailSchema.parse({
  ...extractionFailedPublicationFixture, processingState: 'queued', processingError: null,
  versions: [{ ...versionFixture, processingState: 'queued', processingError: null, extractedAt: null }],
});
export const changeFixtures = [
  c.ChangeItemSchema.parse({ id: id(70), classification: 'newObligation', before: null, after: { ...evidenceFixture, excerpt: 'Maintain a model inventory.' }, explanation: 'A model inventory is now required.' }),
  c.ChangeItemSchema.parse({ id: id(71), classification: 'modifiedObligation', before: { ...previousEvidence, excerpt: 'Review annually.' }, after: { ...evidenceFixture, excerpt: 'Review quarterly.' }, explanation: 'Increase review frequency from annual to quarterly.' }),
  c.ChangeItemSchema.parse({ id: id(72), classification: 'withdrawnOrSuperseded', before: { ...previousEvidence, excerpt: 'Submit form A.' }, after: { ...evidenceFixture, excerpt: 'The requirement to submit form A is withdrawn.' }, explanation: 'Form A is no longer required.' }),
  c.ChangeItemSchema.parse({ id: id(73), classification: 'deadlineChanged', before: previousEvidence, after: evidenceFixture, explanation: 'The compliance deadline is extended by three months.', deadlineDirection: 'extended', previousDeadline: '2026-12-31', updatedDeadline: '2027-03-31' }),
  c.ChangeItemSchema.parse({ id: id(74), classification: 'clarification', before: { ...previousEvidence, excerpt: 'Retain model records.' }, after: { ...evidenceFixture, excerpt: 'Model records include validation reports.' }, explanation: 'Validation reports are explicitly included in retained records.' }),
  c.ChangeItemSchema.parse({ id: id(75), classification: 'noMaterialChange', before: { ...previousEvidence, excerpt: 'Review models annually.' }, after: { ...evidenceFixture, excerpt: 'Review models once per year.' }, explanation: 'The wording changed but the annual review obligation is unchanged.' }),
];
export const shortenedDeadlineFixture = c.ChangeItemSchema.parse({
  ...changeFixtures[3], deadlineDirection: 'shortened', previousDeadline: '2027-03-31', updatedDeadline: '2026-12-31',
  before: { ...previousEvidence, excerpt: 'Complete review by 31 March 2027.' },
  after: { ...evidenceFixture, excerpt: 'The deadline is shortened to 31 December 2026.' }, explanation: 'The deadline is three months earlier.',
});
export const comparisonFixture = c.ComparisonSchema.parse({
  id: f.comparison, publicationId: f.publication, currentDocumentId: f.document, currentVersionId: f.version,
  predecessorPublicationId: f.predecessor, predecessorDocumentId: f.predecessorDocument, predecessorVersionId: f.predecessorVersion,
  createdAt, completedAt, state: 'succeeded', changes: [changeFixtures[3]], issue: null,
});
export const missingComparisonFixture = c.ComparisonSchema.parse({
  ...comparisonFixture, predecessorPublicationId: null, predecessorDocumentId: null, predecessorVersionId: null,
  state: 'blocked', changes: [], issue: missingPredecessorError, unresolvedReferenceIds: [f.reference],
});
export const failedComparisonFixture = c.ComparisonSchema.parse({
  ...comparisonFixture, state: 'failed', changes: [], issue: error('comparisonFailed', 'Synthetic comparison engine failure.'),
});
export const queuedComparisonFixture = c.ComparisonSchema.parse({ ...comparisonFixture, state: 'queued', completedAt: null, changes: [] });
export const processingComparisonFixture = c.ComparisonSchema.parse({ ...queuedComparisonFixture, state: 'processing' });
export const monitorResultFixture = c.MonitorRunResultSchema.parse({
  jobId: f.monitorJob, outcome: 'succeeded', startedAt, completedAt,
  sources: sourcesFixture.items.map((source, i) => ({
    sourceId: source.id, state: 'succeeded', publicationsFound: i === 0 ? 2 : 0,
    alreadyKnownCount: i === 0 ? 1 : 0, discoveredPublications: i === 0 ? [discoveredFixture] : [],
    ingestionJobIds: i === 0 ? [f.ingestionJob] : [], error: null,
  })),
});
const failedSource = { sourceId: f.source, state: 'failed', publicationsFound: 0, alreadyKnownCount: 0, discoveredPublications: [], ingestionJobIds: [], error: error('sourceUnavailable', 'Synthetic regulator endpoint did not respond.') };
export const partialMonitorResultFixture = c.MonitorRunResultSchema.parse({
  ...monitorResultFixture, outcome: 'partial', sources: [failedSource, ...monitorResultFixture.sources.slice(1)],
});
export const failedMonitorResultFixture = c.MonitorRunResultSchema.parse({ ...monitorResultFixture, outcome: 'failed', sources: [failedSource] });
export const queuedJobFixture = c.JobStatusSchema.parse({
  id: f.job, kind: 'comparison', state: 'queued', createdAt, startedAt: null, completedAt: null, error: null, result: null,
});
export const runningJobFixture = c.JobStatusSchema.parse({ ...queuedJobFixture, state: 'running', startedAt });
export const succeededJobFixture = c.JobStatusSchema.parse({ ...runningJobFixture, state: 'succeeded', completedAt, result: { kind: 'comparison', comparison: comparisonFixture } });
export const blockedJobFixture = c.JobStatusSchema.parse({ ...runningJobFixture, state: 'blocked', completedAt, error: missingPredecessorError, result: { kind: 'comparison', comparison: missingComparisonFixture } });
export const failedJobFixture = c.JobStatusSchema.parse({ ...runningJobFixture, state: 'failed', completedAt, error: failedComparisonFixture.issue, result: { kind: 'comparison', comparison: failedComparisonFixture } });
export const failedIngestionJobFixture = c.JobStatusSchema.parse({ ...failedJobFixture, id: f.ingestionJob, kind: 'ingestion', error: extractionError, result: { kind: 'ingestion', publication: extractionFailedPublicationFixture } });
export const succeededIngestionJobFixture = c.JobStatusSchema.parse({ ...succeededJobFixture, id: f.ingestionJob, kind: 'ingestion', result: { kind: 'ingestion', publication: publicationFixture } });
export const monitorJobFixture = c.JobStatusSchema.parse({ ...succeededJobFixture, id: f.monitorJob, kind: 'monitor', result: { kind: 'monitor', monitorRun: monitorResultFixture } });
export const partialMonitorJobFixture = c.JobStatusSchema.parse({ ...monitorJobFixture, result: { kind: 'monitor', monitorRun: partialMonitorResultFixture } });
export const failedMonitorJobFixture = c.JobStatusSchema.parse({ ...monitorJobFixture, state: 'failed', error: error('sourceUnavailable', 'All selected synthetic sources failed.'), result: { kind: 'monitor', monitorRun: failedMonitorResultFixture } });
export const apiErrorFixture = c.ApiErrorSchema.parse({ error: { code: 'validationError', message: 'Invalid request.', retryable: false, details: [{ path: ['publicationDate'], message: 'Expected a calendar date or UTC timestamp.' }] }, requestId: f.request, timestamp: completedAt });
export const publicationPageFixture = c.PublicationListResponseSchema.parse({ items: [publicationSummaryFixture], page: 1, pageSize: 20, total: 1, hasNextPage: false });
export const emptyPageFixture = c.PublicationListResponseSchema.parse({ items: [], page: 2, pageSize: 20, total: 1, hasNextPage: false });
export const uploadMetadataFixture = c.UploadMetadataSchema.parse({ title: 'SYNTHETIC: predecessor circular', country: 'SA', regulatorId: f.regulator, kind: 'circular', referenceNumber: 'DEMO/2025/01', publicationDate: '2025-12-01', effectiveDate: null, sourceId: null });
export const acceptedMonitorFixture = c.MonitorAcceptedResponseSchema.parse({ jobId: f.monitorJob, state: 'queued' });
export const acceptedUploadFixture = c.UploadAcceptedResponseSchema.parse({ jobId: f.ingestionJob, state: 'queued', publicationId: f.publication, documentId: f.document, versionId: f.version });
export const acceptedComparisonFixture = c.ComparisonAcceptedResponseSchema.parse({ jobId: f.job, state: 'queued', comparisonId: f.comparison, publicationId: f.publication });
export const obligationsResponseFixture = c.PublicationObligationsResponseSchema.parse({ publicationId: f.publication, versionId: f.version, processingState: 'succeeded', obligations: [obligationFixture] });
export const reviewRequestFixture = c.ReviewUpdateRequestSchema.parse({ state: 'approved', note: 'Synthetic reviewer checked the source clause.', expectedUpdatedAt: createdAt });
export const reviewResponseFixture = c.ReviewRecordSchema.parse({ state: 'approved', note: reviewRequestFixture.note, reviewedBy: f.reviewer, updatedAt: completedAt });
export const linkRequestFixture = c.PredecessorLinkRequestSchema.parse({ referenceId: f.reference, currentVersionId: f.version, predecessorPublicationId: f.predecessor, predecessorVersionId: f.predecessorVersion });
export const comparisonRequestFixture = c.ComparisonRequestSchema.parse({ currentVersionId: f.version, predecessorVersionId: null });

// Explicit registry supports scripts and tests; no filesystem or Node dependencies in shared modules.
export const fixtureCases: ReadonlyArray<{ name: string; schema: z.ZodType; value: unknown }> = [
  { name: 'monitored-html-version', schema: c.DocumentVersionSchema, value: htmlVersionFixture },
  { name: 'sources', schema: c.SourceListResponseSchema, value: sourcesFixture },
  { name: 'discovered', schema: c.DiscoveredPublicationSchema, value: discoveredFixture },
  ...[publicationFixture, missingPredecessorPublicationFixture, ambiguousPublicationFixture, extractionFailedPublicationFixture, queuedPublicationFixture].map((value, i) => ({ name: `publication-${i}`, schema: c.PublicationDetailSchema, value })),
  ...[...changeFixtures, shortenedDeadlineFixture].map((value, i) => ({ name: `change-${i}`, schema: c.ChangeItemSchema, value })),
  ...[comparisonFixture, missingComparisonFixture, failedComparisonFixture, queuedComparisonFixture, processingComparisonFixture].map((value, i) => ({ name: `comparison-${i}`, schema: c.ComparisonSchema, value })),
  ...[monitorResultFixture, partialMonitorResultFixture, failedMonitorResultFixture].map((value, i) => ({ name: `monitor-${i}`, schema: c.MonitorRunResultSchema, value })),
  ...[queuedJobFixture, runningJobFixture, succeededJobFixture, blockedJobFixture, failedJobFixture, failedIngestionJobFixture, succeededIngestionJobFixture, monitorJobFixture, partialMonitorJobFixture, failedMonitorJobFixture].map((value, i) => ({ name: `job-${i}`, schema: c.JobStatusSchema, value })),
  { name: 'error', schema: c.ApiErrorSchema, value: apiErrorFixture },
  { name: 'page', schema: c.PublicationListResponseSchema, value: publicationPageFixture },
  { name: 'empty-page', schema: c.PublicationListResponseSchema, value: emptyPageFixture },
  { name: 'upload-metadata', schema: c.UploadMetadataSchema, value: uploadMetadataFixture },
  { name: 'monitor-accepted', schema: c.MonitorAcceptedResponseSchema, value: acceptedMonitorFixture },
  { name: 'upload-accepted', schema: c.UploadAcceptedResponseSchema, value: acceptedUploadFixture },
  { name: 'comparison-accepted', schema: c.ComparisonAcceptedResponseSchema, value: acceptedComparisonFixture },
  { name: 'obligations-response', schema: c.PublicationObligationsResponseSchema, value: obligationsResponseFixture },
  { name: 'review-request', schema: c.ReviewUpdateRequestSchema, value: reviewRequestFixture },
  { name: 'review-response', schema: c.ReviewRecordSchema, value: reviewResponseFixture },
  { name: 'link-request', schema: c.PredecessorLinkRequestSchema, value: linkRequestFixture },
  { name: 'comparison-request', schema: c.ComparisonRequestSchema, value: comparisonRequestFixture },
  { name: 'source-update', schema: c.SourceUpdateRequestSchema, value: { enabled: true, monitoringIntervalMinutes: 60 } },
  { name: 'monitor-request', schema: c.MonitorRequestSchema, value: { sourceIds: sourcesFixture.items.map(s => s.id) } },
  { name: 'search-query', schema: c.PublicationSearchQuerySchema, value: { country: ['SA'], businessArea: ['ai'], changeClass: ['deadlineChanged'] } },
];
