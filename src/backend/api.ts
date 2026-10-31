import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  API_CONTRACT, ApiErrorSchema, IdSchema, MonitorRunResultSchema,
  PublicationListResponseSchema, SourceListResponseSchema,
  parsePaginationSearchParams, parsePublicationSearchParams,
  UPLOAD_LIMITS,
} from '../shared/contracts/index.js';
import { Repository } from './repository.js';
import { BackendError } from './errors.js';
import type { AnalysisService } from './analysis/service.js';
import type { OriginalStorage } from './storage.js';
import { uploadMultipart } from './upload.js';

type Request = { method: string; url: string; headers: Record<string, string | undefined>; body?: unknown };
export type ApiResponse = { status: number; headers: Record<string, string>; body: unknown };
export interface ApiOptions { analysis?: AnalysisService; storage?: OriginalStorage; reviewerId?: string }
export function createApi(repository: Repository, writeToken: string, options: ApiOptions = {}) {
  if (writeToken.length < 32) throw new Error('RIA_WRITE_TOKEN must contain at least 32 characters');
  const matches = (template: string, path: string, name: string): string | null => {
    const prefix = template.slice(0, template.indexOf(`:${name}`));
    const suffix = template.slice(template.indexOf(`:${name}`) + name.length + 1);
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
    const candidate = path.slice(prefix.length, suffix ? -suffix.length : undefined);
    return candidate && !candidate.includes('/') ? candidate : null;
  };
  const failure = (error: unknown): ApiResponse => {
    const invalid = error instanceof z.ZodError;
    const known = error instanceof BackendError;
    return {
      status: invalid ? 400 : known ? error.status : 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: ApiErrorSchema.parse({
        error: {
          code: invalid ? 'validationError' : known ? error.code : 'internalError',
          message: invalid ? 'Invalid request.' : known ? error.message : 'Unexpected server error.',
          retryable: known ? error.retryable : false,
          details: invalid ? error.issues.map(issue => ({ path: issue.path.filter(v => typeof v === 'string' || typeof v === 'number'), message: 'Invalid field value.' })) : [],
        }, requestId: randomUUID(), timestamp: repository.now(),
      }),
    };
  };
  const handle = async (request: Request): Promise<ApiResponse> => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      // The same trusted server credential protects direct reads and writes.
      // Browsers authenticate to the local gateway; it injects this token server-side.
      {
        const actual = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${writeToken}`);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BackendError('unauthorized', 'A valid backend write token is required.', 401);
      }
      const json = (schema: z.ZodType, value: unknown, status = 200, headers: Record<string, string> = {}): ApiResponse => {
        const result = schema.safeParse(value);
        if (!result.success) throw new BackendError('internalError', 'Server response failed contract validation.', 500);
        return { status, body: result.data, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } };
      };
      const acceptedComparison = (value: { jobId: string }) => json(API_CONTRACT.requestComparison.responses[202], value, 202, { Location: API_CONTRACT.readJob.path.replace(':jobId', value.jobId) });
      if (request.method === API_CONTRACT.uploadDocument.method && path === API_CONTRACT.uploadDocument.path && options.storage) {
        if (!Buffer.isBuffer(request.body)) throw new BackendError('validationError', 'Upload requires a multipart request body.', 400);
        const accepted = await uploadMultipart(repository, options.storage, request.headers['content-type'] ?? '', request.body);
        return json(API_CONTRACT.uploadDocument.responses[202], accepted, 202, { Location: API_CONTRACT.readJob.path.replace(':jobId', accepted.jobId) });
      }
      if (['POST', 'PATCH'].includes(request.method) && path !== API_CONTRACT.uploadDocument.path) {
        if (url.search || request.headers['content-type']?.split(';')[0] !== 'application/json') throw new BackendError('validationError', 'Use application/json without query parameters.', 400);
        const sourceId = matches(API_CONTRACT.updateSource.path, path, 'sourceId');
        if (request.method === API_CONTRACT.updateSource.method && sourceId) return json(API_CONTRACT.updateSource.responses[200], repository.updateSource(IdSchema.parse(sourceId), request.body));
        if (options.analysis) {
          const compareId = matches(API_CONTRACT.requestComparison.path, path, 'publicationId');
          if (request.method === API_CONTRACT.requestComparison.method && compareId) return acceptedComparison(options.analysis.requestComparison(IdSchema.parse(compareId), request.body));
          const linkId = matches(API_CONTRACT.linkPredecessor.path, path, 'publicationId');
          if (request.method === API_CONTRACT.linkPredecessor.method && linkId) return acceptedComparison(options.analysis.linkPredecessor(IdSchema.parse(linkId), request.body));
          const reviewId = matches(API_CONTRACT.updateReview.path, path, 'publicationId');
          if (request.method === API_CONTRACT.updateReview.method && reviewId) return json(API_CONTRACT.updateReview.responses[200], options.analysis.updateReview(IdSchema.parse(reviewId), request.body, options.reviewerId));
        }
      }
      if (request.method === API_CONTRACT.listSources.method && path === API_CONTRACT.listSources.path) {
        const { page, pageSize } = parsePaginationSearchParams(url.searchParams);
        const all = repository.sources().map(s => s.config);
        return json(SourceListResponseSchema, { items: all.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: all.length, hasNextPage: page * pageSize < all.length });
      }
      if (request.method === API_CONTRACT.triggerMonitor.method && path === API_CONTRACT.triggerMonitor.path) {
        if (url.search) throw new BackendError('validationError', 'This endpoint does not accept query parameters.', 400);
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new BackendError('validationError', 'Use application/json.', 400);
        const accepted = repository.triggerMonitor(API_CONTRACT.triggerMonitor.body.parse(request.body));
        return json(API_CONTRACT.triggerMonitor.responses[202], accepted, 202, { Location: API_CONTRACT.readJob.path.replace(':jobId', accepted.jobId) });
      }
      if (request.method === 'GET' && path === API_CONTRACT.searchPublications.path) return json(PublicationListResponseSchema, repository.listPublications(parsePublicationSearchParams(url.searchParams)));
      if (request.method === 'GET') {
        if (options.analysis) {
          const comparisonId = matches(API_CONTRACT.readComparison.path, path, 'comparisonId');
          const obligationId = matches(API_CONTRACT.readObligations.path, path, 'publicationId');
          if ((comparisonId || obligationId) && url.search) throw new BackendError('validationError', 'This endpoint does not accept query parameters.', 400);
          if (comparisonId) return json(API_CONTRACT.readComparison.responses[200], options.analysis.comparison(IdSchema.parse(comparisonId)));
          if (obligationId) return json(API_CONTRACT.readObligations.responses[200], options.analysis.obligations(IdSchema.parse(obligationId)));
        }
        const jobId = matches(API_CONTRACT.readJob.path, path, 'jobId');
        const monitorId = matches(API_CONTRACT.readMonitorResult.path, path, 'jobId');
        const publicationId = matches(API_CONTRACT.readPublication.path, path, 'publicationId');
        if ((jobId || monitorId || publicationId) && url.search) throw new BackendError('validationError', 'This endpoint does not accept query parameters.', 400);
        if (jobId) return json(API_CONTRACT.readJob.responses[200], repository.job(IdSchema.parse(jobId)));
        if (monitorId) {
          const job = repository.job(IdSchema.parse(monitorId));
          if (job.kind !== 'monitor') throw new BackendError('notFound', 'Monitoring job not found.', 404);
          if (job.state === 'queued' || job.state === 'running') throw new BackendError('resultNotReady', 'Monitor result is not ready.', 409);
          if (!job.result || job.result.kind !== 'monitor') throw new BackendError('jobFailed', 'No monitor result could be produced.', 409);
          return json(MonitorRunResultSchema, job.result.monitorRun);
        }
        if (publicationId) return json(API_CONTRACT.readPublication.responses[200], repository.detail(IdSchema.parse(publicationId)));
      }
      throw new BackendError('notFound', 'Endpoint is not implemented at this ingestion checkpoint.', 404);
    } catch (error) { return failure(error); }
  };
  return { handle, failure };
}
export function createHttpServer(repository: Repository, writeToken: string, options: ApiOptions = {}) {
  const api = createApi(repository, writeToken, options);
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        const bytes = Buffer.from(part);
        size += bytes.length;
        const isUpload = req.method === 'POST' && req.url === API_CONTRACT.uploadDocument.path;
        if (size > (isUpload ? UPLOAD_LIMITS.maxRequestBytes : 16 * 1024)) throw new BackendError(isUpload ? 'payloadTooLarge' : 'validationError', isUpload ? 'Upload request exceeds 21 MiB.' : 'JSON request body exceeds 16 KiB.', isUpload ? 413 : 400);
        chunks.push(bytes);
      }
      let body: unknown;
      if (req.method === 'POST' && req.url === API_CONTRACT.uploadDocument.path) body = Buffer.concat(chunks);
      else if (size) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
        catch { throw new BackendError('validationError', 'Malformed JSON.', 400); }
      }
      const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value]));
      const response = await api.handle({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body });
      res.writeHead(response.status, response.headers).end(JSON.stringify(response.body));
    } catch (error) {
      const response = api.failure(error);
      res.writeHead(response.status, response.headers).end(JSON.stringify(response.body));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
