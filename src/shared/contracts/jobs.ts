import { z } from 'zod';
import { ErrorInfoSchema, IdSchema, JobKindSchema, JobStateSchema, MonitorOutcomeSchema, SourceRunStateSchema, UtcTimestampSchema } from './common.js';
import { ComparisonSchema } from './comparisons.js';
import { DiscoveredPublicationSchema, PublicationDetailSchema } from './publications.js';

export const MonitorRequestSchema = z.strictObject({
  sourceIds: z.array(IdSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Source IDs must be unique').optional(),
});
const sourceRunFields = {
  sourceId: IdSchema,
  publicationsFound: z.number().int().nonnegative(),
  alreadyKnownCount: z.number().int().nonnegative(),
  discoveredPublications: z.array(DiscoveredPublicationSchema),
  ingestionJobIds: z.array(IdSchema),
};
export const SourceMonitorResultSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...sourceRunFields, state: z.literal(SourceRunStateSchema.enum.succeeded), error: z.null() }),
  z.strictObject({ ...sourceRunFields, state: z.literal(SourceRunStateSchema.enum.failed), error: ErrorInfoSchema }),
]).superRefine((v, ctx) => {
  if (v.publicationsFound !== v.alreadyKnownCount + v.discoveredPublications.length) ctx.addIssue({ code: 'custom', path: ['publicationsFound'], message: 'Found count must equal new plus already known' });
  if (v.ingestionJobIds.length !== v.discoveredPublications.length || new Set(v.ingestionJobIds).size !== v.ingestionJobIds.length) ctx.addIssue({ code: 'custom', path: ['ingestionJobIds'], message: 'One distinct ingestion job per new publication, in the same order' });
  if (v.discoveredPublications.some(p => p.sourceId !== v.sourceId)) ctx.addIssue({ code: 'custom', path: ['discoveredPublications'], message: 'Publication source must match this source run' });
  if (new Set(v.discoveredPublications.map(p => p.id)).size !== v.discoveredPublications.length) ctx.addIssue({ code: 'custom', path: ['discoveredPublications'], message: 'New publications must be distinct' });
  if (v.state === 'failed' && (v.publicationsFound !== 0 || v.error.code !== 'sourceUnavailable')) ctx.addIssue({ code: 'custom', path: ['error'], message: 'Failed sources commit no discoveries and use sourceUnavailable' });
});
export const MonitorRunResultSchema = z.strictObject({
  jobId: IdSchema,
  outcome: MonitorOutcomeSchema,
  startedAt: UtcTimestampSchema,
  completedAt: UtcTimestampSchema,
  sources: z.array(SourceMonitorResultSchema).min(1),
}).superRefine((v, ctx) => {
  const failures = v.sources.filter(s => s.state === 'failed').length;
  const expected = failures === 0 ? 'succeeded' : failures === v.sources.length ? 'failed' : 'partial';
  if (v.outcome !== expected) ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'Outcome must match source results' });
  if (v.completedAt < v.startedAt) ctx.addIssue({ code: 'custom', path: ['completedAt'], message: 'Completion cannot precede start' });
  if (new Set(v.sources.map(s => s.sourceId)).size !== v.sources.length) ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Source runs must be unique' });
});
export const JobResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(JobKindSchema.enum.monitor), monitorRun: MonitorRunResultSchema }),
  z.strictObject({ kind: z.literal(JobKindSchema.enum.ingestion), publication: PublicationDetailSchema }),
  z.strictObject({ kind: z.literal(JobKindSchema.enum.comparison), comparison: ComparisonSchema }),
]);
const jobFields = { id: IdSchema, kind: JobKindSchema, createdAt: UtcTimestampSchema };
export const JobStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...jobFields, state: z.literal(JobStateSchema.enum.queued), startedAt: z.null(), completedAt: z.null(), error: z.null(), result: z.null() }),
  z.strictObject({ ...jobFields, state: z.literal(JobStateSchema.enum.running), startedAt: UtcTimestampSchema, completedAt: z.null(), error: z.null(), result: z.null() }),
  z.strictObject({ ...jobFields, state: z.literal(JobStateSchema.enum.succeeded), startedAt: UtcTimestampSchema, completedAt: UtcTimestampSchema, error: z.null(), result: JobResultSchema }),
  z.strictObject({ ...jobFields, state: z.literal(JobStateSchema.enum.blocked), startedAt: UtcTimestampSchema, completedAt: UtcTimestampSchema, error: ErrorInfoSchema, result: JobResultSchema }),
  z.strictObject({ ...jobFields, state: z.literal(JobStateSchema.enum.failed), startedAt: UtcTimestampSchema.nullable(), completedAt: UtcTimestampSchema, error: ErrorInfoSchema, result: JobResultSchema.nullable() }),
]).superRefine((v, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (v.startedAt && v.startedAt < v.createdAt) issue('startedAt', 'Start cannot precede creation');
  if (v.completedAt && v.completedAt < (v.startedAt ?? v.createdAt)) issue('completedAt', 'Completion cannot precede start/creation');
  if (v.state === 'blocked' && (v.kind !== 'comparison' || !['missingPredecessor', 'ambiguousPredecessor'].includes(v.error.code) || v.result.kind !== 'comparison' || v.result.comparison.state !== 'blocked')) issue('error', 'Only unresolved comparisons can block');
  if (v.state === 'failed' && ['missingPredecessor', 'ambiguousPredecessor'].includes(v.error.code)) issue('error', 'Unresolved predecessors are blocked, not failed');
  if (!v.result) return;
  if (v.result.kind !== v.kind) issue('result', 'Result kind must match job kind');
  if (v.startedAt === null) issue('startedAt', 'A result requires a started job');
  if (v.result.kind === 'monitor') {
    const run = v.result.monitorRun;
    if (run.jobId !== v.id || run.startedAt !== v.startedAt || run.completedAt !== v.completedAt) issue('result', 'Monitor run must match job ID and times');
    if ((run.outcome === 'failed' ? 'failed' : 'succeeded') !== v.state) issue('state', 'Monitor job state must match run outcome');
    if (run.outcome === 'failed' && v.error?.code !== 'sourceUnavailable') issue('error', 'All-source failure requires sourceUnavailable');
  } else if (v.result.kind === 'ingestion') {
    if (v.result.publication.processingState !== v.state) issue('result', 'Ingestion result must match job state');
    if (v.error?.code !== v.result.publication.processingError?.code) issue('error', 'Job and ingestion error codes must match');
  } else {
    if (v.result.comparison.state !== v.state) issue('result', 'Comparison result must match job state');
    if (v.error?.code !== v.result.comparison.issue?.code) issue('error', 'Job and comparison error codes must match');
  }
});
export const MonitorAcceptedResponseSchema = z.strictObject({ jobId: IdSchema, state: z.literal(JobStateSchema.enum.queued) });
export const UploadAcceptedResponseSchema = MonitorAcceptedResponseSchema.extend({ publicationId: IdSchema, documentId: IdSchema, versionId: IdSchema });
export const ComparisonAcceptedResponseSchema = MonitorAcceptedResponseSchema.extend({ comparisonId: IdSchema, publicationId: IdSchema });
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type MonitorRunResult = z.infer<typeof MonitorRunResultSchema>;
export type MonitorRequest = z.infer<typeof MonitorRequestSchema>;
export type JobResult = z.infer<typeof JobResultSchema>;
