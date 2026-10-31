import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import {
  ComparisonSchema, ComparisonRequestSchema, PredecessorLinkRequestSchema, JobStatusSchema,
  PublicationObligationsResponseSchema, ReviewUpdateRequestSchema, ReviewRecordSchema,
  type Comparison, type ErrorInfo, type RegulatoryReference, type PublicationDetail,
} from '../../shared/contracts/index.js';
import { Repository } from '../repository.js';
import { BackendError, LeaseLostError, errorInfo, safeFailure } from '../errors.js';
import { AnalysisEngine } from './engine.js';
import { ModelExtractionSchema, type ModelExtraction } from './schemas.js';
import { segmentPages, type VersionText } from './evidence.js';
import { publicObligations } from './validate.js';
import { resolveReferences, relationshipState, normalizeReference, type ReferenceCandidate } from './resolve.js';
import { highlightDiff } from '../../shared/presentation/diff.js';

interface AnalysisJob {
  id: string; kind: 'ingestion' | 'comparison'; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked';
  version_id: string; request_json: string; created_at: string; started_at: string | null; completed_at: string | null;
  attempts: number; available_at: number; claim_token: string | null; lease_until: number | null; error_json: string | null; result_json: string | null;
}
interface VersionRow { id: string; publication_id: string; metadata_json: string; extracted_text: string | null; extracted_pages_json: string | null }
interface AnalysisRow { version_id: string; model_identity: string; state: string; result_json: string | null; public_json: string | null; error_json: string | null }
interface ComparisonRow { id: string; job_id: string; publication_id: string; current_version_id: string; predecessor_version_id: string | null; result_json: string }
export class AnalysisService {
  constructor(readonly repository: Repository, readonly engine: AnalysisEngine, private retryBaseMs = 1000, private leaseMs = 60_000) {}
  get db() { return this.repository.db; }
  private event(id: string, stage: string, detail: unknown = {}) { this.db.run('INSERT INTO analysis_job_events(job_id,at,stage,detail_json) VALUES (?,?,?,?)', id, this.repository.now(), stage, JSON.stringify(detail)); }
  private version(id: string): VersionRow {
    const row = this.db.get<VersionRow>('SELECT * FROM document_versions WHERE id=?', id);
    if (!row) throw new BackendError('notFound', 'Document version not found.', 404);
    return row;
  }
  private text(id: string): VersionText {
    const row = this.version(id);
    if (!row.extracted_text || !row.extracted_pages_json) throw new BackendError('extractionFailed', 'Persisted readable text is required. Complete or retry document ingestion first.', 422);
    const metadata = JSON.parse(row.metadata_json) as { documentId: string };
    return { publicationId: row.publication_id, documentId: metadata.documentId, versionId: id, segments: segmentPages(JSON.parse(row.extracted_pages_json) as { pageNumber: number | null; text: string }[]) };
  }
  private catalog(): ReferenceCandidate[] {
    return this.db.all<{ id: string; current_version_id: string; discovery_json: string }>('SELECT id,current_version_id,discovery_json FROM publications').map(row => {
      const metadata = JSON.parse(row.discovery_json) as { regulatorId: string; regulatorName: string; referenceNumber: string | null };
      return { publicationId: row.id, versionId: row.current_version_id, ...metadata };
    });
  }
  private rawPublication(id: string) {
    const row = this.db.get<{ discovery_json: string; current_version_id: string }>('SELECT discovery_json,current_version_id FROM publications WHERE id=?', id);
    if (!row) throw new BackendError('notFound', 'Publication not found.', 404);
    return { ...JSON.parse(row.discovery_json) as { title: string; kind: string; regulatorName: string; regulatorId: string }, currentVersionId: row.current_version_id };
  }
  private enqueue(kind: AnalysisJob['kind'], versionId: string, request: unknown) {
    const id = randomUUID();
    this.db.run("INSERT INTO analysis_jobs(id,kind,state,version_id,request_json,created_at,available_at) VALUES (?,?,'queued',?,?,?,?)", id, kind, versionId, JSON.stringify(request), this.repository.now(), this.repository.clock());
    this.event(id, 'queued');
    return id;
  }
  requestAnalysis(versionId: string) {
    this.version(versionId);
    return this.db.transaction(() => {
      const active = this.db.get<{ id: string }>("SELECT id FROM analysis_jobs WHERE version_id=? AND kind='ingestion' AND state IN ('queued','running')", versionId);
      if (active) return { jobId: active.id, state: 'queued' as const };
      const cached = this.db.get<AnalysisRow>("SELECT * FROM version_analysis WHERE version_id=? AND state='succeeded' AND model_identity=?", versionId, this.engine.model.identity);
      if (cached) {
        const complete = this.db.get<{ id: string }>("SELECT id FROM analysis_jobs WHERE version_id=? AND kind='ingestion' AND state='succeeded' AND json_extract(request_json,'$.modelIdentity')=? ORDER BY created_at DESC LIMIT 1", versionId, this.engine.model.identity);
        if (complete) return { jobId: complete.id, state: 'queued' as const };
      }
      const jobId = this.enqueue('ingestion', versionId, { modelIdentity: this.engine.model.identity });
      this.db.run("INSERT INTO version_analysis(version_id,model_identity,state,updated_at) VALUES (?,?,'queued',?) ON CONFLICT(version_id) DO UPDATE SET model_identity=excluded.model_identity,state='queued',error_json=NULL,updated_at=excluded.updated_at", versionId, this.engine.model.identity, this.repository.now());
      return { jobId, state: 'queued' as const };
    });
  }
  queueMissing(limit = 10) {
    const rows = this.db.all<{ id: string }>("SELECT v.id FROM document_versions v LEFT JOIN version_analysis a ON a.version_id=v.id WHERE a.version_id IS NULL AND v.extracted_text IS NOT NULL AND json_extract(v.metadata_json,'$.processingState')='succeeded' LIMIT ?", limit);
    return rows.map(row => this.requestAnalysis(row.id));
  }
  requestComparison(publicationId: string, input: unknown) {
    const request = ComparisonRequestSchema.parse(input);
    return this.db.transaction(() => this.enqueueComparison(publicationId, request));
  }
  private enqueueComparison(publicationId: string, request: { currentVersionId: string; predecessorVersionId: string | null }) {
    const publication = this.rawPublication(publicationId);
    const current = this.version(request.currentVersionId);
    if (current.publication_id !== publicationId || publication.currentVersionId !== request.currentVersionId) throw new BackendError('conflict', 'Current version is stale or belongs to another publication.', 409);
    if (request.predecessorVersionId) {
      const prior = this.version(request.predecessorVersionId);
      if (prior.publication_id === publicationId) throw new BackendError('conflict', 'A publication cannot be its own predecessor.', 409);
    }
    if (this.db.get("SELECT id FROM analysis_jobs WHERE version_id=? AND kind='comparison' AND state IN ('queued','running')", current.id)) throw new BackendError('conflict', 'A comparison is already active for this version.', 409);
    const requestJson = JSON.stringify({ ...request, modelIdentity: this.engine.model.identity });
    const priorSuccess = this.db.get<{ job_id: string; id: string }>("SELECT c.id,c.job_id FROM comparisons c JOIN analysis_jobs j ON j.id=c.job_id WHERE c.current_version_id=? AND j.request_json=? AND j.state='succeeded' ORDER BY c.created_at DESC,c.rowid DESC LIMIT 1", current.id, requestJson);
    if (priorSuccess) return { jobId: priorSuccess.job_id, comparisonId: priorSuccess.id, publicationId, state: 'queued' as const };
    const id = randomUUID();
    const jobId = this.enqueue('comparison', current.id, { ...request, modelIdentity: this.engine.model.identity });
    const comparison = ComparisonSchema.parse({ id, publicationId, currentDocumentId: (JSON.parse(current.metadata_json) as { documentId: string }).documentId, currentVersionId: current.id, predecessorPublicationId: null, predecessorDocumentId: null, predecessorVersionId: null, createdAt: this.repository.now(), state: 'queued', completedAt: null, changes: [], issue: null });
    this.db.run('INSERT INTO comparisons(id,job_id,publication_id,current_version_id,predecessor_version_id,result_json,created_at) VALUES (?,?,?,?,?,?,?)', id, jobId, publicationId, current.id, request.predecessorVersionId, JSON.stringify(comparison), comparison.createdAt);
    this.resetReview(publicationId);
    return { jobId, comparisonId: id, publicationId, state: 'queued' as const };
  }
  job(id: string) {
    const row = this.db.get<AnalysisJob>('SELECT * FROM analysis_jobs WHERE id=?', id);
    if (!row) return null;
    return JobStatusSchema.parse({ id, kind: row.kind, state: row.state, createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at, error: row.error_json ? JSON.parse(row.error_json) : null, result: row.result_json ? JSON.parse(row.result_json) : null });
  }
  comparison(id: string): Comparison {
    const row = this.db.get<{ result_json: string }>('SELECT result_json FROM comparisons WHERE id=?', id);
    if (!row) throw new BackendError('notFound', 'Comparison not found.', 404);
    return ComparisonSchema.parse(JSON.parse(row.result_json));
  }
  obligations(id: string) {
    const detail = this.repository.detail(id);
    const analysis = this.db.get<AnalysisRow>('SELECT * FROM version_analysis WHERE version_id=?', detail.currentVersionId);
    if (detail.processingState === 'failed') throw new BackendError('extractionFailed', detail.processingError!.message, 422);
    if (!analysis || analysis.state !== 'succeeded') throw new BackendError('resultNotReady', 'Structured analysis has not completed. Queue analysis in the trusted backend or request a comparison.', 409);
    return PublicationObligationsResponseSchema.parse({ publicationId: id, versionId: detail.currentVersionId, processingState: 'succeeded', obligations: detail.obligations });
  }
  private claim(): AnalysisJob | undefined {
    return this.db.transaction(() => {
      const row = this.db.get<AnalysisJob>("SELECT * FROM analysis_jobs WHERE (state='queued' AND available_at<=?) OR (state='running' AND ((claim_token IS NULL AND available_at<=?) OR lease_until<=?)) ORDER BY created_at,id LIMIT 1", this.repository.clock(), this.repository.clock(), this.repository.clock());
      if (!row) return;
      this.db.run("UPDATE analysis_jobs SET state='running',started_at=coalesce(started_at,?),attempts=attempts+1,claim_token=?,lease_until=? WHERE id=?", this.repository.now(), randomUUID(), this.repository.clock() + this.leaseMs, row.id);
      this.event(row.id, 'claimed', { attempt: row.attempts + 1 });
      return this.db.get<AnalysisJob>('SELECT * FROM analysis_jobs WHERE id=?', row.id)!;
    });
  }
  private assertLease(job: AnalysisJob) {
    const row = this.db.get<AnalysisJob>('SELECT * FROM analysis_jobs WHERE id=?', job.id);
    if (!row || row.state !== 'running' || row.claim_token !== job.claim_token || (row.lease_until ?? 0) <= this.repository.clock()) throw new LeaseLostError('Analysis worker lease lost');
  }
  private resetReview(publicationId: string) {
    const row = this.db.get<{ review_json: string }>('SELECT review_json FROM publications WHERE id=?', publicationId)!;
    const previous = JSON.parse(row.review_json) as { updatedAt: string };
    const updatedAt = new Date(Math.max(this.repository.clock(), Date.parse(previous.updatedAt) + 1)).toISOString();
    this.db.run('UPDATE publications SET review_json=?,updated_at=? WHERE id=?', JSON.stringify({ state: 'pending', reviewedBy: null, note: null, updatedAt }), updatedAt, publicationId);
  }
  private createsCycle(currentVersionId: string, targetVersionId: string) {
    return Boolean(this.db.get(`WITH RECURSIVE edges(source,target) AS (
      SELECT version_id,predecessor_version_id FROM predecessor_links
      UNION SELECT a.version_id,json_extract(r.value,'$.targetVersionId')
      FROM version_analysis a,json_each(a.public_json,'$.references') r
      WHERE json_extract(r.value,'$.resolution')='resolved' AND json_extract(r.value,'$.relation')!='cites'
    ), lineage(version_id) AS (SELECT ? UNION SELECT e.target FROM edges e JOIN lineage x ON e.source=x.version_id)
    SELECT 1 AS found FROM lineage WHERE version_id=?`, targetVersionId, currentVersionId));
  }
  private publish(version: VersionText, result: ModelExtraction, job: AnalysisJob) {
    this.assertLease(job);
    const metadata = this.rawPublication(version.publicationId);
    let references = resolveReferences(result, version, this.catalog());
    const links = this.db.all<{ reference_id: string; predecessor_version_id: string }>('SELECT reference_id,predecessor_version_id FROM predecessor_links WHERE version_id=?', version.versionId);
    references = references.map(reference => {
      const link = links.find(link => link.reference_id === reference.id);
      if (!link) return reference;
      const target = this.version(link.predecessor_version_id);
      const { resolution: _, ...base } = reference;
      const common = { id: base.id, referenceText: base.referenceText, referenceNumber: base.referenceNumber, relation: base.relation, evidence: base.evidence };
      return { ...common, resolution: 'resolved' as const, targetPublicationId: target.publication_id, targetVersionId: target.id };
    });
    references = references.map(reference => {
      if (reference.relation === 'cites' || reference.resolution !== 'resolved' || !this.createsCycle(version.versionId, reference.targetVersionId)) return reference;
      return { id: reference.id, referenceText: reference.referenceText, referenceNumber: reference.referenceNumber, relation: reference.relation, evidence: reference.evidence, resolution: 'unresolved' as const, reason: 'The proposed predecessor would create a reference cycle. Human review is required.' };
    });
    const status = result.documentStatus ?? 'unknown';
    const value = {
      summary: `Document status: ${metadata.kind === 'consultation' ? 'consultation (proposed requirements)' : status}. Structured findings are awaiting human review.`,
      businessAreas: [...new Set([...result.businessAreas, ...result.obligations.flatMap(o => o.businessAreas)])],
      obligations: publicObligations(result, version, metadata.kind === 'consultation'), references,
      relationshipState: relationshipState(references), effectiveDate: result.effectiveDate,
    };
    const prior = this.db.get<{ public_json: string | null }>('SELECT public_json FROM version_analysis WHERE version_id=?', version.versionId);
    this.db.run("INSERT INTO version_analysis(version_id,model_identity,state,result_json,public_json,error_json,updated_at) VALUES (?,?,'succeeded',?,?,NULL,?) ON CONFLICT(version_id) DO UPDATE SET model_identity=excluded.model_identity,state='succeeded',result_json=excluded.result_json,public_json=excluded.public_json,error_json=NULL,updated_at=excluded.updated_at", version.versionId, this.engine.model.identity, JSON.stringify(result), JSON.stringify(value), this.repository.now());
    if (metadata.currentVersionId === version.versionId && prior?.public_json !== JSON.stringify(value)) this.resetReview(version.publicationId);
    return value;
  }
  private async ensure(versionId: string, job: AnalysisJob, signal: AbortSignal) {
    this.version(versionId);
    for (;;) {
      signal.throwIfAborted();
      const acquired = this.db.transaction(() => {
        this.assertLease(job);
        const owner = this.db.get<{ claim_token: string; active_token: string | null; state: string; lease_until: number | null }>('SELECT l.claim_token,j.claim_token AS active_token,j.state,j.lease_until FROM analysis_version_locks l JOIN analysis_jobs j ON j.id=l.job_id WHERE l.version_id=?', versionId);
        if (owner?.state === 'running' && owner.claim_token === owner.active_token && (owner.lease_until ?? 0) > this.repository.clock()) return false;
        this.db.run('INSERT INTO analysis_version_locks VALUES (?,?,?) ON CONFLICT(version_id) DO UPDATE SET job_id=excluded.job_id,claim_token=excluded.claim_token', versionId, job.id, job.claim_token);
        return true;
      });
      if (acquired) break;
      await wait(100, undefined, { signal });
    }
    try { return await this.ensureLocked(versionId, job, signal); }
    finally { this.db.run('DELETE FROM analysis_version_locks WHERE version_id=? AND job_id=? AND claim_token=?', versionId, job.id, job.claim_token); }
  }
  private async ensureLocked(versionId: string, job: AnalysisJob, signal: AbortSignal) {
    const version = this.text(versionId);
    const existing = this.db.get<AnalysisRow>("SELECT * FROM version_analysis WHERE version_id=? AND state='succeeded' AND model_identity=?", versionId, this.engine.model.identity);
    if (existing?.result_json) {
      // Refresh explicit reference resolution against newly ingested predecessors without rerunning the model.
      return this.db.transaction(() => this.publish(version, ModelExtractionSchema.parse(JSON.parse(existing.result_json!)), job));
    }
    this.db.transaction(() => {
      this.assertLease(job);
      this.db.run("INSERT INTO version_analysis(version_id,model_identity,state,updated_at) VALUES (?,?,'processing',?) ON CONFLICT(version_id) DO UPDATE SET model_identity=excluded.model_identity,state='processing',error_json=NULL,updated_at=excluded.updated_at", versionId, this.engine.model.identity, this.repository.now());
    });
    try {
      const result = await this.engine.extract(version, this.rawPublication(version.publicationId), {
        read: key => { const row = this.db.get<{ result_json: string }>('SELECT result_json FROM analysis_chunks WHERE cache_key=? AND version_id=?', key, versionId); return row ? ModelExtractionSchema.parse(JSON.parse(row.result_json)) : null; },
        write: (key, result) => this.db.transaction(() => { this.assertLease(job); this.db.run('INSERT INTO analysis_chunks VALUES (?,?,?) ON CONFLICT(cache_key) DO NOTHING', key, versionId, JSON.stringify(result)); }),
      }, signal);
      return this.db.transaction(() => this.publish(version, result, job));
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      const failure = safeFailure(error, 'extractionFailed');
      this.db.transaction(() => { this.assertLease(job); this.db.run("UPDATE version_analysis SET state='failed',error_json=?,updated_at=? WHERE version_id=?", JSON.stringify(failure), this.repository.now(), versionId); });
      throw new BackendError('extractionFailed', failure.message, 422, failure.retryable);
    }
  }
  private complete(job: AnalysisJob, state: 'succeeded' | 'failed' | 'blocked', result: unknown, error: ErrorInfo | null, completedAt = this.repository.now()) {
    this.assertLease(job);
    const wire = JobStatusSchema.parse({ id: job.id, kind: job.kind, state, createdAt: job.created_at, startedAt: job.started_at, completedAt, error, result });
    this.db.run('UPDATE analysis_jobs SET state=?,completed_at=?,error_json=?,result_json=?,lease_until=NULL,claim_token=NULL WHERE id=?', wire.state, wire.completedAt, error ? JSON.stringify(error) : null, JSON.stringify(result), job.id);
    this.event(job.id, state);
  }
  private finishComparison(job: AnalysisJob, comparison: Comparison) {
    this.db.transaction(() => {
      this.assertLease(job);
      const result = ComparisonSchema.parse(comparison);
      const diffs = result.changes.map(change => ({ changeId: change.id, segments: highlightDiff(change.before?.excerpt ?? '', change.after.excerpt) }));
      this.db.run('UPDATE comparisons SET predecessor_version_id=?,result_json=?,diff_json=? WHERE job_id=?', result.predecessorVersionId, JSON.stringify(result), JSON.stringify(diffs), job.id);
      if (result.state !== 'succeeded' && result.state !== 'failed' && result.state !== 'blocked') throw new Error('Comparison is not terminal');
      this.complete(job, result.state, { kind: 'comparison', comparison: result }, result.issue, result.completedAt);
    });
  }
  private async compare(job: AnalysisJob, signal: AbortSignal) {
    const row = this.db.get<ComparisonRow>('SELECT * FROM comparisons WHERE job_id=?', job.id)!;
    const base = this.comparison(row.id);
    const request = JSON.parse(job.request_json) as { predecessorVersionId: string | null };
    this.db.transaction(() => { this.assertLease(job); this.db.run('UPDATE comparisons SET result_json=? WHERE id=?', JSON.stringify({ ...base, state: 'processing' }), row.id); });
    const current = this.text(job.version_id);
    const extracted = await this.ensure(job.version_id, job, signal);
    const required = extracted.references.filter(r => r.relation !== 'cites');
    const unresolved = required.filter(r => r.resolution !== 'resolved');
    let target = request.predecessorVersionId;
    if (!target) {
      const targets = [...new Set(required.flatMap(r => r.resolution === 'resolved' ? [r.targetVersionId] : []))];
      if (unresolved.length || targets.length > 1) {
        this.finishComparison(job, ComparisonSchema.parse({ ...base, state: 'blocked', completedAt: this.repository.now(), changes: [], issue: errorInfo(unresolved.some(r => r.resolution === 'ambiguous') || targets.length > 1 ? 'ambiguousPredecessor' : 'missingPredecessor', 'Upload or explicitly select the referenced predecessor, then link it and rerun.'), unresolvedReferenceIds: (unresolved.length ? unresolved : required).map(r => r.id) }));
        return;
      }
      target = targets[0] ?? null;
    } else if (!required.some(r => r.resolution === 'resolved' && r.targetVersionId === target)) {
      throw new BackendError('comparisonFailed', 'The selected version is not supported by a resolved predecessor reference. Link the exact cited predecessor first.', 422);
    }
    if (!target && !extracted.obligations.length) throw new BackendError('comparisonFailed', 'No supported obligations or predecessor clauses are available; comparison remains unresolved.', 422);
    const previous = target ? this.text(target) : null;
    if (target) await this.ensure(target, job, signal);
    const changes = await this.engine.compare(current, previous, { currentPublication: this.rawPublication(current.publicationId), previousPublication: previous ? this.rawPublication(previous.publicationId) : null }, signal);
    this.finishComparison(job, ComparisonSchema.parse({ ...base, state: 'succeeded', completedAt: this.repository.now(), changes, issue: null, predecessorPublicationId: previous?.publicationId ?? null, predecessorDocumentId: previous?.documentId ?? null, predecessorVersionId: previous?.versionId ?? null }));
  }
  async runOne(): Promise<boolean> {
    const job = this.claim();
    if (!job) return false;
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      try { if (!this.db.run("UPDATE analysis_jobs SET lease_until=? WHERE id=? AND claim_token=? AND state='running' AND lease_until>?", this.repository.clock() + this.leaseMs, job.id, job.claim_token, this.repository.clock()).changes) controller.abort(); }
      catch { controller.abort(); }
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
    try {
      if (job.attempts > 3) throw new BackendError(job.kind === 'comparison' ? 'comparisonFailed' : 'extractionFailed', 'Analysis retry budget exhausted after interrupted processing. Retry explicitly after inspecting the job.', 422);
      if (job.kind === 'comparison') await this.compare(job, signal);
      else {
        await this.ensure(job.version_id, job, signal);
        this.db.transaction(() => this.complete(job, 'succeeded', { kind: 'ingestion', publication: this.repository.detail(this.version(job.version_id).publication_id, job.version_id) }, null));
      }
    } catch (error) {
      if (error instanceof LeaseLostError || controller.signal.aborted) return true;
      const code = error instanceof BackendError && error.code === 'extractionFailed' ? 'extractionFailed' : job.kind === 'comparison' ? 'comparisonFailed' : 'extractionFailed';
      const failure = safeFailure(error, code);
      try { this.db.transaction(() => {
        this.assertLease(job);
        if (failure.retryable && job.attempts < 3) {
          this.db.run('UPDATE analysis_jobs SET claim_token=NULL,lease_until=NULL,available_at=? WHERE id=?', this.repository.clock() + this.retryBaseMs * 2 ** (job.attempts - 1), job.id);
          this.event(job.id, 'retryWaiting', { error: failure });
        } else if (job.kind === 'ingestion') {
          this.db.run("UPDATE version_analysis SET state='failed',error_json=?,updated_at=? WHERE version_id=?", JSON.stringify(failure), this.repository.now(), job.version_id);
          const publication = this.repository.detail(this.version(job.version_id).publication_id, job.version_id);
          this.complete(job, 'failed', { kind: 'ingestion', publication }, failure);
        } else {
          const row = this.db.get<ComparisonRow>('SELECT * FROM comparisons WHERE job_id=?', job.id)!;
          const result = ComparisonSchema.parse({ ...this.comparison(row.id), state: 'failed', completedAt: this.repository.now(), changes: [], issue: failure });
          this.db.run('UPDATE comparisons SET result_json=? WHERE id=?', JSON.stringify(result), row.id);
          this.complete(job, 'failed', { kind: 'comparison', comparison: result }, failure, result.completedAt!);
        }
      }); } catch (completionError) { if (!(completionError instanceof LeaseLostError)) throw completionError; }
    } finally { clearInterval(heartbeat); }
    return true;
  }
  linkPredecessor(publicationId: string, input: unknown) {
    const request = PredecessorLinkRequestSchema.parse(input);
    return this.db.transaction(() => {
      const current = this.repository.detail(publicationId);
      if (current.currentVersionId !== request.currentVersionId) throw new BackendError('conflict', 'Current version changed; refresh before linking.', 409);
      const reference = current.references.find(r => r.id === request.referenceId);
      if (!reference) throw new BackendError('notFound', 'Reference not found in the current version.', 404);
      if (reference.relation === 'cites') throw new BackendError('conflict', 'An ordinary citation cannot be linked as a predecessor.', 409);
      const target = this.version(request.predecessorVersionId);
      if (target.publication_id !== request.predecessorPublicationId || target.publication_id === publicationId) throw new BackendError('conflict', 'Predecessor version ownership is invalid.', 409);
      const predecessor = this.rawPublication(target.publication_id);
      const priorRow = this.db.get<{ discovery_json: string }>('SELECT discovery_json FROM publications WHERE id=?', target.publication_id)!;
      const number = (JSON.parse(priorRow.discovery_json) as { referenceNumber: string | null }).referenceNumber;
      if (!reference.referenceNumber || !number || normalizeReference(reference.referenceNumber) !== normalizeReference(number)) throw new BackendError('conflict', 'Predecessor reference number does not match the cited regulation.', 409);
      const analysis = this.db.get<AnalysisRow>('SELECT * FROM version_analysis WHERE version_id=?', current.currentVersionId);
      const extraction = analysis?.result_json ? ModelExtractionSchema.parse(JSON.parse(analysis.result_json)) : null;
      const original = extraction?.references.find(r => r.referenceNumber === reference.referenceNumber);
      if (original?.issuingAuthority && original.issuingAuthority.trim().toLowerCase() !== predecessor.regulatorName.trim().toLowerCase()) throw new BackendError('conflict', 'Predecessor issuing authority does not match the cited regulator.', 409);
      const targetState = (JSON.parse(target.metadata_json) as { processingState: string }).processingState;
      if (targetState === 'failed') throw new BackendError('extractionFailed', 'Predecessor text extraction failed.', 422);
      if (!target.extracted_text) throw new BackendError('conflict', 'Predecessor text extraction has not completed.', 409);
      if (this.createsCycle(current.currentVersionId, target.id)) throw new BackendError('conflict', 'Link would create a predecessor cycle.', 409);
      this.db.run('INSERT INTO predecessor_links VALUES (?,?,?,?,?) ON CONFLICT(version_id,reference_id) DO UPDATE SET predecessor_version_id=excluded.predecessor_version_id,evidence_json=excluded.evidence_json,linked_at=excluded.linked_at', current.currentVersionId, reference.id, target.id, JSON.stringify(reference.evidence), this.repository.now());
      return this.enqueueComparison(publicationId, { currentVersionId: current.currentVersionId, predecessorVersionId: target.id });
    });
  }
  updateReview(publicationId: string, input: unknown, reviewerId: string | undefined) {
    if (!reviewerId) throw new BackendError('forbidden', 'Configure a trusted server-side reviewer identity before updating review status.', 403);
    const request = ReviewUpdateRequestSchema.parse(input);
    return this.db.transaction(() => {
      const publication = this.repository.detail(publicationId);
      if (publication.review.updatedAt !== request.expectedUpdatedAt) throw new BackendError('conflict', 'Review has changed. Refresh and reconcile before retrying.', 409);
      if (['approved', 'rejected'].includes(request.state) && publication.processingState !== 'succeeded') throw new BackendError('conflict', 'Processing must succeed before completing review.', 409);
      if (request.state === 'approved' && !['resolved', 'notRequired'].includes(publication.relationshipState)) throw new BackendError('conflict', 'Resolve predecessor relationships before approval.', 409);
      if (request.state === 'approved' && publication.latestComparisonId && this.comparison(publication.latestComparisonId).state !== 'succeeded') throw new BackendError('conflict', 'The latest comparison must succeed before approval.', 409);
      const updatedAt = new Date(Math.max(this.repository.clock(), Date.parse(publication.review.updatedAt) + 1)).toISOString();
      const review = ReviewRecordSchema.parse({ state: request.state, note: request.note, reviewedBy: reviewerId, updatedAt });
      this.db.run('UPDATE publications SET review_json=?,updated_at=? WHERE id=?', JSON.stringify(review), updatedAt, publicationId);
      return review;
    });
  }
}
