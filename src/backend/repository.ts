import { randomUUID } from 'node:crypto';
import {
  DiscoveredPublicationSchema, DocumentVersionSchema, JobStatusSchema, MonitorRequestSchema,
  PublicationDetailSchema, PublicationSummarySchema, SourceConfigSchema,
  ComparisonSchema, SourceUpdateRequestSchema, UploadMetadataSchema, UploadFileDescriptorSchema,
  type SourceConfig, type JobStatus, type PublicationSearchQuery, type ErrorInfo, type MonitorRunResult,
} from '../shared/contracts/index.js';
import { Database } from './db.js';
import { BackendError, LeaseLostError, errorInfo } from './errors.js';
import type { Candidate } from './adapters/types.js';
import type { ExtractedText } from './extract.js';

export interface SourceRecord { config: SourceConfig; adapterKey: string; options: unknown }
interface SourceRow { id: string; config_json: string; adapter_key: string; options_json: string }
export interface JobRow {
  id: string; kind: 'monitor' | 'ingestion'; state: 'queued' | 'running' | 'succeeded' | 'failed';
  created_at: string; started_at: string | null; completed_at: string | null; error_json: string | null;
  result_json: string | null; payload_json: string; attempts: number; max_attempts: number;
  lease_until: number | null; claim_token: string | null; available_at: number; stage: string;
}
interface PublicationRow { id: string; source_id: string; canonical_key: string; document_id: string; current_version_id: string; discovery_json: string; review_json: string; updated_at: string }
export interface VersionRow { id: string; publication_id: string; version_number: number; content_hash: string; original_key: string; metadata_json: string; extracted_text: string | null }
export interface PreparedDocument { candidate: Candidate; hash: string; key: string; size: number }
export class Repository {
  constructor(readonly db: Database, readonly clock = () => Date.now()) {}
  now() { return new Date(this.clock()).toISOString(); }
  private source(row: SourceRow): SourceRecord { return { config: SourceConfigSchema.parse(JSON.parse(row.config_json)), adapterKey: row.adapter_key, options: JSON.parse(row.options_json) as unknown }; }
  sources(): SourceRecord[] { return this.db.all<SourceRow>('SELECT * FROM sources ORDER BY json_extract(config_json,\'$.name\'), id').map(row => this.source(row)); }
  seedSource(source: SourceConfig, adapterKey: string, options: unknown) {
    this.db.run('INSERT INTO sources VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING', source.id, JSON.stringify(SourceConfigSchema.parse(source)), adapterKey, JSON.stringify(options));
  }
  sourceById(id: string): SourceRecord {
    const row = this.db.get<SourceRow>('SELECT * FROM sources WHERE id=?', id);
    if (!row) throw new BackendError('notFound', 'Source not found.', 404);
    return this.source(row);
  }
  event(jobId: string, stage: string, detail: unknown = {}) { this.db.run('INSERT INTO job_events(job_id,at,stage,detail_json) VALUES (?,?,?,?)', jobId, this.now(), stage, JSON.stringify(detail)); }
  private enqueue(kind: JobRow['kind'], payload: unknown): string {
    const id = randomUUID();
    this.db.run('INSERT INTO jobs(id,kind,state,created_at,payload_json,available_at) VALUES (?,?,\'queued\',?,?,?)', id, kind, this.now(), JSON.stringify(payload), this.clock());
    this.event(id, 'queued');
    return id;
  }
  triggerMonitor(input: unknown, scheduled = false) {
    const request = MonitorRequestSchema.parse(input);
    return this.db.transaction(() => {
      const sources = request.sourceIds ? request.sourceIds.map(id => this.sourceById(id)) : this.sources().filter(s => s.config.enabled);
      if (!sources.length || sources.some(s => !s.config.enabled)) throw new BackendError('conflict', 'Select at least one enabled source.', 409);
      if (scheduled && sources.some(s => s.config.nextMonitorAt && s.config.nextMonitorAt > this.now())) throw new BackendError('conflict', 'Source is no longer due for a scheduled run.', 409);
      for (const source of sources) if (this.db.get('SELECT source_id FROM source_locks WHERE source_id=?', source.config.id)) throw new BackendError('conflict', 'A selected source already has an active monitor run.', 409);
      const jobId = this.enqueue('monitor', {});
      this.db.run('INSERT INTO monitoring_runs(job_id) VALUES (?)', jobId);
      for (const source of sources) {
        this.db.run('INSERT INTO source_locks VALUES (?,?)', source.config.id, jobId);
        this.db.run('INSERT INTO monitoring_run_sources(job_id,source_id,source_snapshot_json) VALUES (?,?,?)', jobId, source.config.id, JSON.stringify(source));
        const config = { ...source.config, nextMonitorAt: new Date(this.clock() + source.config.monitoringIntervalMinutes * 60_000).toISOString(), updatedAt: this.now() };
        this.db.run('UPDATE sources SET config_json=? WHERE id=?', JSON.stringify(config), config.id);
      }
      return { jobId, state: 'queued' as const };
    });
  }
  scheduleDue() {
    const jobs: string[] = [];
    for (const source of this.sources()) {
      if (!source.config.enabled || source.config.nextMonitorAt && source.config.nextMonitorAt > this.now()) continue;
      try { jobs.push(this.triggerMonitor({ sourceIds: [source.config.id] }, true).jobId); }
      catch (error) { if (!(error instanceof BackendError && error.code === 'conflict')) throw error; }
    }
    return jobs;
  }
  jobRow(id: string): JobRow {
    const row = this.db.get<JobRow>('SELECT * FROM jobs WHERE id=?', id);
    if (!row) throw new BackendError('notFound', 'Job not found.', 404);
    return row;
  }
  job(id: string): JobStatus {
    const row = this.db.get<JobRow>('SELECT * FROM jobs WHERE id=?', id) ?? this.db.get<JobRow>('SELECT * FROM analysis_jobs WHERE id=?', id);
    if (!row) throw new BackendError('notFound', 'Job not found.', 404);
    return JobStatusSchema.parse({ id, kind: row.kind, state: row.state, createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at, error: row.error_json ? JSON.parse(row.error_json) : null, result: row.result_json ? JSON.parse(row.result_json) : null });
  }
  claim(leaseMs: number): JobRow | undefined {
    return this.db.transaction(() => {
      const row = this.db.get<JobRow>(`SELECT * FROM jobs WHERE
        (state='queued' AND available_at<=?) OR
        (state='running' AND ((claim_token IS NULL AND available_at<=?) OR lease_until<=?))
        ORDER BY created_at,id LIMIT 1`, this.clock(), this.clock(), this.clock());
      if (!row) return;
      const token = randomUUID();
      // Recovery claims at the attempt cap are finalized by the worker without doing external work.
      this.db.run("UPDATE jobs SET state='running',started_at=coalesce(started_at,?),attempts=attempts+1,claim_token=?,lease_until=? WHERE id=?", this.now(), token, this.clock() + leaseMs, row.id);
      this.event(row.id, 'claimed', { attempt: row.attempts + 1 });
      return this.jobRow(row.id);
    });
  }
  assertLease(job: JobRow) {
    const row = this.jobRow(job.id);
    if (row.state !== 'running' || row.claim_token !== job.claim_token || (row.lease_until ?? 0) <= this.clock()) throw new LeaseLostError('Worker lease was lost');
  }
  heartbeat(job: JobRow, leaseMs: number): boolean {
    return Number(this.db.run("UPDATE jobs SET lease_until=? WHERE id=? AND claim_token=? AND state='running' AND lease_until>?", this.clock() + leaseMs, job.id, job.claim_token, this.clock()).changes) === 1;
  }
  progress(job: JobRow, stage: string, detail: unknown = {}) {
    this.db.transaction(() => { this.assertLease(job); this.db.run('UPDATE jobs SET stage=? WHERE id=?', stage, job.id); this.event(job.id, stage, detail); });
  }
  retry(job: JobRow, failure: ErrorInfo, delayMs: number) {
    this.db.transaction(() => {
      this.assertLease(job);
      // Remain publicly running during bounded retry backoff; never reset a terminal job.
      this.db.run("UPDATE jobs SET claim_token=NULL,lease_until=NULL,available_at=?,stage='retryWaiting' WHERE id=?", this.clock() + delayMs, job.id);
      this.event(job.id, 'retryWaiting', { error: failure, attempt: job.attempts, nextAttemptAt: new Date(this.clock() + delayMs).toISOString() });
    });
  }
  runSources(jobId: string) {
    return this.db.all<{ source_id: string; source_snapshot_json: string; result_json: string | null }>('SELECT * FROM monitoring_run_sources WHERE job_id=? ORDER BY source_id', jobId)
      .map(row => ({ source: JSON.parse(row.source_snapshot_json) as SourceRecord, result: row.result_json ? JSON.parse(row.result_json) as MonitorRunResult['sources'][number] : null }));
  }
  private finish(job: JobRow, state: 'succeeded' | 'failed', result: unknown, error: ErrorInfo | null, completedAt = this.now()) {
    const wire = JobStatusSchema.parse({ id: job.id, kind: job.kind, state, createdAt: job.created_at, startedAt: job.started_at, completedAt, result, error });
    this.db.run('UPDATE jobs SET state=?,completed_at=?,result_json=?,error_json=?,claim_token=NULL,lease_until=NULL,stage=? WHERE id=?', wire.state, wire.completedAt, JSON.stringify(wire.result), wire.error ? JSON.stringify(wire.error) : null, state, job.id);
    this.event(job.id, state);
  }
  commitSource(job: JobRow, source: SourceRecord, prepared: PreparedDocument[]) {
    this.db.transaction(() => {
      this.assertLease(job);
      const prior = this.db.get<{ result_json: string | null }>('SELECT result_json FROM monitoring_run_sources WHERE job_id=? AND source_id=?', job.id, source.config.id);
      if (prior?.result_json) return;
      const discovered: MonitorRunResult['sources'][number]['discoveredPublications'] = [];
      const ingestionJobIds: string[] = [];
      let alreadyKnownCount = 0;
      for (const item of prepared) {
        let publication = this.db.get<PublicationRow>('SELECT * FROM publications WHERE source_id=? AND canonical_key=?', source.config.id, item.candidate.canonicalKey);
        const isNew = !publication;
        if (publication) alreadyKnownCount++;
        else {
          const id = randomUUID(), documentId = randomUUID(), now = this.now();
          const discovery = DiscoveredPublicationSchema.parse({ id, sourceId: source.config.id, title: item.candidate.title, country: source.config.country, regulatorId: source.config.regulatorId, regulatorName: source.config.regulatorName, kind: item.candidate.kind, referenceNumber: item.candidate.referenceNumber, publicationDate: item.candidate.publicationDate, effectiveDate: item.candidate.effectiveDate, discoveredAt: now, sourceUrl: item.candidate.downloadUrl });
          this.db.run('INSERT INTO publications(id,source_id,canonical_key,document_id,discovery_json,review_json,updated_at) VALUES (?,?,?,?,?,?,?)', id, source.config.id, item.candidate.canonicalKey, documentId, JSON.stringify(discovery), JSON.stringify({ state: 'pending', note: null, reviewedBy: null, updatedAt: now }), now);
          publication = this.db.get<PublicationRow>('SELECT * FROM publications WHERE id=?', id)!;
          discovered.push(discovery);
        }
        const existing = this.db.get<VersionRow>('SELECT * FROM document_versions WHERE publication_id=? AND content_hash=?', publication.id, item.hash);
        if (existing) {
          // A prior hash is an already stored version, not another copy of the original.
          // The most recently observed version becomes current, including regulator rollbacks.
          if (publication.current_version_id !== existing.id) this.makeCurrent(publication, existing.id);
          const metadata = DocumentVersionSchema.parse(JSON.parse(existing.metadata_json));
          const active = this.db.get("SELECT j.id FROM jobs j JOIN ingestion_tasks t ON t.job_id=j.id WHERE t.version_id=? AND j.state IN ('queued','running')", existing.id);
          // A later manual monitor run explicitly permits a new ingestion job for failed extraction.
          if (metadata.processingState === 'failed' && !active) {
            this.db.run('UPDATE document_versions SET metadata_json=? WHERE id=?', JSON.stringify({ ...metadata, processingState: 'queued', processingError: null, extractedAt: null }), existing.id);
            this.enqueueIngestion(existing.id);
          }
          continue;
        }
        const versionId = randomUUID();
        const number = this.db.get<{ n: number }>('SELECT coalesce(max(version_number),0)+1 AS n FROM document_versions WHERE publication_id=?', publication.id)!.n;
        let fileName: string;
        try { fileName = decodeURIComponent(new URL(item.candidate.downloadUrl).pathname.split('/').pop()!); } catch { fileName = 'document'; }
        fileName = fileName.replace(/[\\/\u0000]/g, '_').slice(0, 255) || 'document';
        const metadata = DocumentVersionSchema.parse({ id: versionId, documentId: publication.document_id, publicationId: publication.id, versionNumber: number, fileName, mediaType: item.candidate.mediaType, sizeBytes: item.size, ingestionMethod: 'monitor', sourceUrl: item.candidate.downloadUrl, createdAt: this.now(), extractedAt: null, processingState: 'queued', processingError: null });
        this.db.run('INSERT INTO document_versions(id,publication_id,version_number,content_hash,original_key,metadata_json) VALUES (?,?,?,?,?,?)', versionId, publication.id, number, item.hash, item.key, JSON.stringify(metadata));
        this.makeCurrent(publication, versionId);
        const ingestionId = this.enqueueIngestion(versionId);
        if (isNew) ingestionJobIds.push(ingestionId);
      }
      const result = { sourceId: source.config.id, state: 'succeeded', publicationsFound: prepared.length, alreadyKnownCount, discoveredPublications: discovered, ingestionJobIds, error: null };
      this.db.run('UPDATE monitoring_run_sources SET result_json=? WHERE job_id=? AND source_id=?', JSON.stringify(result), job.id, source.config.id);
      this.updateSourceAttempt(source.config.id);
      this.event(job.id, 'sourceCommitted', { sourceId: source.config.id, publicationsFound: prepared.length });
    });
  }
  private makeCurrent(publication: PublicationRow, versionId: string) {
    const timestamp = new Date(Math.max(this.clock(), Date.parse(publication.updated_at) + 1)).toISOString();
    this.db.run('UPDATE publications SET current_version_id=?,updated_at=?,review_json=? WHERE id=?', versionId, timestamp, JSON.stringify({ state: 'pending', note: null, reviewedBy: null, updatedAt: timestamp }), publication.id);
  }
  private enqueueIngestion(versionId: string) {
    const jobId = this.enqueue('ingestion', { versionId });
    this.db.run('INSERT INTO ingestion_tasks VALUES (?,?)', jobId, versionId);
    return jobId;
  }
  private updateSourceAttempt(sourceId: string) {
    const { config } = this.sourceById(sourceId);
    this.db.run('UPDATE sources SET config_json=? WHERE id=?', JSON.stringify({ ...config, lastMonitoredAt: this.now(), updatedAt: this.now() }), sourceId);
  }
  failSource(job: JobRow, sourceId: string, error: ErrorInfo) {
    this.db.transaction(() => {
      this.assertLease(job);
      this.db.run('UPDATE monitoring_run_sources SET result_json=? WHERE job_id=? AND source_id=? AND result_json IS NULL', JSON.stringify({ sourceId, state: 'failed', publicationsFound: 0, alreadyKnownCount: 0, discoveredPublications: [], ingestionJobIds: [], error }), job.id, sourceId);
      this.updateSourceAttempt(sourceId);
    });
  }
  completeMonitor(job: JobRow) {
    this.db.transaction(() => {
      this.assertLease(job);
      const sources = this.runSources(job.id).map(s => s.result);
      if (sources.some(s => !s)) throw new Error('Monitor has unfinished sources');
      const failures = sources.filter(s => s?.state === 'failed').length;
      const outcome = failures === 0 ? 'succeeded' : failures === sources.length ? 'failed' : 'partial';
      const completedAt = this.now();
      const result = { jobId: job.id, outcome, startedAt: job.started_at, completedAt, sources };
      this.finish(job, outcome === 'failed' ? 'failed' : 'succeeded', { kind: 'monitor', monitorRun: result }, outcome === 'failed' ? errorInfo('sourceUnavailable', 'All selected official sources failed.') : null, completedAt);
      this.db.run('UPDATE monitoring_runs SET result_json=? WHERE job_id=?', JSON.stringify(result), job.id);
      this.db.run('DELETE FROM source_locks WHERE job_id=?', job.id);
    });
  }
  versionForJob(job: JobRow): VersionRow {
    const row = this.db.get<VersionRow>('SELECT v.* FROM document_versions v JOIN ingestion_tasks t ON t.version_id=v.id WHERE t.job_id=?', job.id);
    if (!row) throw new Error('Ingestion version missing');
    return row;
  }
  startExtraction(job: JobRow) {
    this.db.transaction(() => {
      this.assertLease(job);
      const version = this.versionForJob(job);
      const metadata = DocumentVersionSchema.parse(JSON.parse(version.metadata_json));
      this.db.run('UPDATE document_versions SET metadata_json=? WHERE id=?', JSON.stringify({ ...metadata, processingState: 'processing', processingError: null, extractedAt: null }), version.id);
      this.event(job.id, 'extracting', { versionId: version.id });
    });
  }
  completeExtraction(job: JobRow, text: ExtractedText | null, error: ErrorInfo | null) {
    this.db.transaction(() => {
      this.assertLease(job);
      const version = this.versionForJob(job);
      const metadata = DocumentVersionSchema.parse(JSON.parse(version.metadata_json));
      const state = error ? 'failed' : 'succeeded';
      this.db.run('UPDATE document_versions SET metadata_json=?,extracted_text=?,extracted_pages_json=? WHERE id=?', JSON.stringify({ ...metadata, processingState: state, processingError: error, extractedAt: text ? this.now() : null }), text?.text ?? null, text ? JSON.stringify(text.pages) : null, version.id);
      this.db.run('UPDATE publications SET updated_at=? WHERE id=? AND current_version_id=?', this.now(), version.publication_id, version.id);
      const publication = this.detail(version.publication_id, version.id);
      this.finish(job, state, { kind: 'ingestion', publication }, error);
    });
  }
  detail(id: string, versionId?: string) {
    const row = this.db.get<PublicationRow>('SELECT * FROM publications WHERE id=?', id);
    if (!row) throw new BackendError('notFound', 'Publication not found.', 404);
    const analyses = this.db.all<{ version_id: string; state: string; public_json: string | null; error_json: string | null }>('SELECT a.* FROM version_analysis a JOIN document_versions v ON v.id=a.version_id WHERE v.publication_id=?', id);
    const versions = this.db.all<VersionRow>('SELECT * FROM document_versions WHERE publication_id=? ORDER BY version_number', id).map(v => {
      const metadata = DocumentVersionSchema.parse(JSON.parse(v.metadata_json));
      const analysis = analyses.find(a => a.version_id === v.id);
      if (!analysis || analysis.state === 'succeeded') return metadata;
      return DocumentVersionSchema.parse({ ...metadata, processingState: analysis.state, processingError: analysis.error_json ? JSON.parse(analysis.error_json) : null, extractedAt: null });
    });
    const currentVersionId = versionId ?? row.current_version_id;
    const current = versions.find(v => v.id === currentVersionId)!;
    const analysis = analyses.find(a => a.version_id === currentVersionId);
    const structured = analysis?.state === 'succeeded' && analysis.public_json ? JSON.parse(analysis.public_json) as Partial<import('../shared/contracts/index.js').PublicationDetail> : {};
    const latestRow = this.db.get<{ result_json: string }>('SELECT result_json FROM comparisons WHERE current_version_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', currentVersionId);
    const latest = latestRow ? ComparisonSchema.parse(JSON.parse(latestRow.result_json)) : null;
    const raw = JSON.parse(row.discovery_json) as Record<string, unknown>;
    const changes = latest?.state === 'succeeded' && ['resolved', 'notRequired'].includes(structured.relationshipState ?? '') ? [...new Set(latest.changes.map(c => c.classification))] : [];
    return PublicationDetailSchema.parse({
      ...raw, documentId: row.document_id, currentVersionId,
      businessAreas: [], processingState: current.processingState, processingError: current.processingError,
      review: JSON.parse(row.review_json), relationshipState: 'unchecked',
      updatedAt: row.updated_at, summary: null, versions, obligations: [], references: [],
      ...structured, effectiveDate: raw.effectiveDate ?? structured.effectiveDate ?? null,
      changeClasses: changes, latestComparisonId: latest?.id ?? null,
    });
  }
  listPublications(query: PublicationSearchQuery) {
    // Snapshot includes count and rows. Bound SQL filters; never expose internal storage/text columns.
    return this.db.transaction(() => {
      const conditions: string[] = [];
      const values: SQLValue[] = [];
      const filter = (column: string, entries: string[] | undefined) => { if (entries) { conditions.push(`${column} IN (${entries.map(() => '?').join(',')})`); values.push(...entries); } };
      filter("json_extract(p.discovery_json,'$.country')", query.country);
      filter("json_extract(p.discovery_json,'$.regulatorId')", query.regulatorId);
      filter("coalesce(a.state,json_extract(v.metadata_json,'$.processingState'))", query.processingState ? [query.processingState] : undefined);
      filter("json_extract(p.review_json,'$.state')", query.reviewState ? [query.reviewState] : undefined);
      if (query.relationshipState) { conditions.push("(CASE WHEN a.state='succeeded' THEN json_extract(a.public_json,'$.relationshipState') ELSE 'unchecked' END)=?"); values.push(query.relationshipState); }
      if (query.businessArea) { conditions.push(`a.state='succeeded' AND EXISTS (SELECT 1 FROM json_each(a.public_json,'$.businessAreas') WHERE value IN (${query.businessArea.map(() => '?').join(',')}))`); values.push(...query.businessArea); }
      if (query.changeClass) { conditions.push(`a.state='succeeded' AND json_extract(a.public_json,'$.relationshipState') IN ('resolved','notRequired') AND json_extract(c.result_json,'$.state')='succeeded' AND EXISTS (SELECT 1 FROM json_each(c.result_json,'$.changes') WHERE json_extract(value,'$.classification') IN (${query.changeClass.map(() => '?').join(',')}))`); values.push(...query.changeClass); }
      if (query.publicationDateFrom) { conditions.push("substr(json_extract(p.discovery_json,'$.publicationDate'),1,10)>=?"); values.push(query.publicationDateFrom); }
      if (query.publicationDateTo) { conditions.push("substr(json_extract(p.discovery_json,'$.publicationDate'),1,10)<=?"); values.push(query.publicationDateTo); }
      if (query.q) {
        conditions.push("(instr(lower(json_extract(p.discovery_json,'$.title')),lower(?))>0 OR instr(lower(coalesce(json_extract(p.discovery_json,'$.referenceNumber'),'')),lower(?))>0 OR instr(lower(coalesce(v.extracted_text,'')),lower(?))>0)");
        values.push(query.q, query.q, query.q);
      }
      const from = `FROM publications p JOIN document_versions v ON v.id=p.current_version_id LEFT JOIN version_analysis a ON a.version_id=v.id LEFT JOIN comparisons c ON c.id=(SELECT c2.id FROM comparisons c2 WHERE c2.current_version_id=v.id ORDER BY c2.created_at DESC,c2.rowid DESC LIMIT 1) ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}`;
      const total = this.db.get<{ n: number }>(`SELECT count(*) AS n ${from}`, ...values)!.n;
      const ids = this.db.all<{ id: string }>(`SELECT p.id ${from} ORDER BY json_extract(p.discovery_json,'$.discoveredAt') DESC,p.id ASC LIMIT ? OFFSET ?`, ...values, query.pageSize, (query.page - 1) * query.pageSize);
      const items = ids.map(({ id }) => { const { summary: _, versions: _v, obligations: _o, references: _r, ...summary } = this.detail(id); return PublicationSummarySchema.parse(summary); });
      return { items, page: query.page, pageSize: query.pageSize, total, hasNextPage: query.page * query.pageSize < total };
    });
  }
  updateSource(id: string, input: unknown) {
    const update = SourceUpdateRequestSchema.parse(input);
    return this.db.transaction(() => {
      const record = this.sourceById(id);
      if (this.db.get('SELECT source_id FROM source_locks WHERE source_id=?', id)) throw new BackendError('conflict', 'Wait for the active source run before updating configuration.', 409);
      if (update.url && new URL(update.url).origin !== new URL(record.config.url).origin) throw new BackendError('conflict', 'Source URL must remain on its configured official origin.', 409);
      const enabled = update.enabled ?? record.config.enabled;
      const next = SourceConfigSchema.parse({ ...record.config, ...update, nextMonitorAt: enabled ? new Date(this.clock() + (update.monitoringIntervalMinutes ?? record.config.monitoringIntervalMinutes) * 60_000).toISOString() : null, updatedAt: this.now() });
      this.db.run('UPDATE sources SET config_json=? WHERE id=?', JSON.stringify(next), id);
      return next;
    });
  }
  upload(input: unknown, file: unknown, stored: { key: string; hash: string }) {
    const metadata = UploadMetadataSchema.parse(input);
    const descriptor = UploadFileDescriptorSchema.parse(file);
    return this.db.transaction(() => {
      const source = metadata.sourceId ? this.sourceById(metadata.sourceId) : this.sources().find(s => s.config.regulatorId === metadata.regulatorId && s.config.country === metadata.country);
      if (!source) throw new BackendError('notFound', 'Regulator/source is not configured. Add the official catalog entry before uploading.', 404);
      if (source.config.regulatorId !== metadata.regulatorId || source.config.country !== metadata.country) throw new BackendError('conflict', 'Country/regulator must match the configured source.', 409);
      if (this.db.get('SELECT v.id FROM document_versions v JOIN publications p ON p.id=v.publication_id WHERE p.source_id=? AND v.content_hash=?', source.config.id, stored.hash)) throw new BackendError('conflict', 'This content is already catalogued for the source. Use the stored publication/version.', 409);
      const publicationId = randomUUID(), documentId = randomUUID(), versionId = randomUUID(), now = this.now();
      const discovery = DiscoveredPublicationSchema.parse({ id: publicationId, sourceId: metadata.sourceId, title: metadata.title, country: metadata.country, regulatorId: metadata.regulatorId, regulatorName: source.config.regulatorName, kind: metadata.kind, referenceNumber: metadata.referenceNumber, publicationDate: metadata.publicationDate, effectiveDate: metadata.effectiveDate, discoveredAt: now, sourceUrl: null });
      this.db.run('INSERT INTO publications(id,source_id,canonical_key,document_id,current_version_id,discovery_json,review_json,updated_at) VALUES (?,?,?,?,?,?,?,?)', publicationId, source.config.id, `upload:${stored.hash}`, documentId, versionId, JSON.stringify(discovery), JSON.stringify({ state: 'pending', note: null, reviewedBy: null, updatedAt: now }), now);
      const version = DocumentVersionSchema.parse({ id: versionId, documentId, publicationId, versionNumber: 1, ...descriptor, ingestionMethod: 'upload', sourceUrl: null, createdAt: now, extractedAt: null, processingState: 'queued', processingError: null });
      this.db.run('INSERT INTO document_versions(id,publication_id,version_number,content_hash,original_key,metadata_json) VALUES (?,?,1,?,?,?)', versionId, publicationId, stored.hash, stored.key, JSON.stringify(version));
      const jobId = this.enqueueIngestion(versionId);
      return { jobId, publicationId, documentId, versionId, state: 'queued' as const };
    });
  }
}
type SQLValue = string | number;
