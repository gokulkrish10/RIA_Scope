import { CandidateSchema, type AdapterRegistry, type OfficialFetcher } from './adapters/types.js';
import { HttpsOfficialFetcher } from './fetch.js';
import { BackendError, LeaseLostError, safeFailure, errorInfo } from './errors.js';
import { extractText } from './extract.js';
import { OriginalStorage } from './storage.js';
import { Repository, type JobRow, type PreparedDocument } from './repository.js';
import { UPLOAD_LIMITS, type ErrorInfo } from '../shared/contracts/index.js';

export class Worker {
  constructor(
    readonly repository: Repository,
    readonly storage: OriginalStorage,
    readonly adapters: AdapterRegistry,
    private fetcherFactory: (hosts: readonly string[]) => OfficialFetcher = hosts => new HttpsOfficialFetcher(hosts),
    private retryBaseMs = 1000,
    private leaseMs = 60_000,
    private afterTextExtraction?: (versionId: string) => void,
  ) {}
  async runOne(): Promise<boolean> {
    const job = this.repository.claim(this.leaseMs);
    if (!job) return false;
    const controller = new AbortController();
    const timer = setInterval(() => {
      try { if (!this.repository.heartbeat(job, this.leaseMs)) controller.abort(new LeaseLostError()); }
      catch { controller.abort(new LeaseLostError()); }
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    timer.unref();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    try {
      if (job.attempts > job.max_attempts) {
        this.finalFailure(job, errorInfo(job.kind === 'monitor' ? 'sourceUnavailable' : 'extractionFailed', 'Worker retry budget exhausted after interrupted processing.'));
      } else if (job.kind === 'monitor') await this.monitor(job, signal);
      else await this.ingest(job, signal);
    } catch (error) {
      if (error instanceof LeaseLostError || controller.signal.aborted) return true;
      const failure = safeFailure(error, job.kind === 'monitor' ? 'sourceUnavailable' : 'extractionFailed');
      try {
        if (failure.retryable && job.attempts < job.max_attempts) this.repository.retry(job, failure, this.retryBaseMs * 2 ** (job.attempts - 1));
        else this.finalFailure(job, failure);
      } catch (finalError) { if (!(finalError instanceof LeaseLostError)) throw finalError; }
    } finally { clearInterval(timer); }
    return true;
  }
  private finalFailure(job: JobRow, failure: ErrorInfo) {
    if (job.kind === 'ingestion') this.repository.completeExtraction(job, null, failure);
    else {
      for (const entry of this.repository.runSources(job.id)) if (!entry.result) this.repository.failSource(job, entry.source.config.id, failure);
      this.repository.completeMonitor(job);
    }
  }
  private async monitor(job: JobRow, signal: AbortSignal) {
    let retry: ErrorInfo | null = null;
    for (const { source, result } of this.repository.runSources(job.id)) {
      if (result) continue; // Source result + publications + ingestion jobs committed atomically.
      try {
        signal.throwIfAborted();
        this.repository.progress(job, 'discovering', { sourceId: source.config.id });
        const adapter = this.adapters.get(source.adapterKey);
        if (!adapter) throw new BackendError('sourceUnavailable', 'No adapter is registered for this source.', 500);
        const fetcher = this.fetcherFactory(adapter.allowedHosts);
        const raw = await adapter.discover(source.config, source.options, fetcher, signal);
        if (raw.length > 100) throw new BackendError('sourceUnavailable', 'Adapter discovery limit exceeded.', 500);
        const candidates = [...new Map(raw.map(value => { const candidate = CandidateSchema.parse(value); return [candidate.canonicalKey, candidate] as const; })).values()];
        const prepared: PreparedDocument[] = [];
        for (const candidate of candidates) {
          this.repository.progress(job, 'downloading', { sourceId: source.config.id, index: prepared.length + 1, total: candidates.length });
          const download = await fetcher.get(candidate.downloadUrl, UPLOAD_LIMITS.maxFileBytes, signal);
          if (!download.bytes.length || download.bytes.length > UPLOAD_LIMITS.maxFileBytes) throw new BackendError('sourceUnavailable', 'Downloaded file violates the byte limit.', 500);
          const expected = candidate.mediaType;
          if (download.contentType !== expected && download.contentType !== 'application/octet-stream') throw new BackendError('sourceUnavailable', 'Downloaded file does not match the declared document format.', 500);
          if (expected === 'application/pdf' && download.bytes.subarray(0, 5).toString() !== '%PDF-') throw new BackendError('sourceUnavailable', 'Source returned a non-PDF document.', 500);
          const stored = await this.storage.put(download.bytes);
          prepared.push({ candidate, ...stored, size: download.bytes.length });
        }
        this.repository.commitSource(job, source, prepared);
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        const failure = safeFailure(error, 'sourceUnavailable');
        this.repository.progress(job, 'sourceError', { sourceId: source.config.id, error: failure });
        if (failure.retryable && job.attempts < job.max_attempts) retry = failure;
        else this.repository.failSource(job, source.config.id, failure);
      }
    }
    if (retry) this.repository.retry(job, retry, this.retryBaseMs * 2 ** (job.attempts - 1));
    else this.repository.completeMonitor(job);
  }
  private async ingest(job: JobRow, signal: AbortSignal) {
    const version = this.repository.versionForJob(job);
    this.repository.startExtraction(job);
    await this.storage.read(version.original_key); // Verify the stored bytes before parsing.
    const mediaType = (JSON.parse(version.metadata_json) as { mediaType: string }).mediaType;
    const extracted = await extractText(this.storage.path(version.original_key), mediaType, signal);
    this.repository.completeExtraction(job, extracted, null);
    this.afterTextExtraction?.(version.id);
  }
}
