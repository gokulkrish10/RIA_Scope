import { CandidateSchema, type AdapterRegistry, type OfficialFetcher } from './adapters/types.js';
import { HttpsOfficialFetcher } from './fetch.js';
import { BackendError, LeaseLostError, safeFailure, errorInfo } from './errors.js';
import { extractText } from './extract.js';
import { OriginalStorage } from './storage.js';
import { Repository, type JobRow, type PreparedDocument } from './repository.js';
import { UPLOAD_LIMITS, type ErrorInfo } from '../shared/contracts/index.js';
import { downloadDiagnostic, fileSignature } from './download-diagnostics.js';
import { routeDocument } from './document-routing.js';
import { officialDocumentLinks } from './html-body.mjs';

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
          let download = await fetcher.get(candidate.downloadUrl, UPLOAD_LIMITS.maxFileBytes, signal);
          if (!download.bytes.length || download.bytes.length > UPLOAD_LIMITS.maxFileBytes) throw new BackendError('sourceUnavailable', 'Downloaded file violates the byte limit.', 500);
          let stored = await this.storage.put(download.bytes);
          this.repository.progress(job, 'downloadDiagnostic', { ...downloadDiagnostic(download.httpStatus ?? 200, download.finalUrl, download.contentType, download.bytes), originalHash: stored.hash });
          let routed;
          try { routed = routeDocument(download, candidate); }
          catch (error) {
            const links = fileSignature(download.bytes) === 'html' ? officialDocumentLinks(download.bytes.toString('utf8'), download.finalUrl, adapter.allowedHosts) : [];
            // Exactly one explicitly advertised official document; ambiguous landing pages fail closed.
            if (links.length !== 1) {
              if (error instanceof BackendError) error.diagnostic = { ...downloadDiagnostic(download.httpStatus ?? 200, download.finalUrl, download.contentType, download.bytes), extractionError: error.message };
              throw error;
            }
            download = await fetcher.get(links[0]!, UPLOAD_LIMITS.maxFileBytes, signal);
            stored = await this.storage.put(download.bytes);
            this.repository.progress(job, 'downloadDiagnostic', { ...downloadDiagnostic(download.httpStatus ?? 200, download.finalUrl, download.contentType, download.bytes), originalHash: stored.hash });
            routed = routeDocument(download, { ...candidate, downloadUrl: download.finalUrl });
          }
          prepared.push({ candidate: routed.candidate, ...stored, hash: routed.contentHash ?? stored.hash, size: download.bytes.length });
        }
        this.repository.commitSource(job, source, prepared);
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        const failure = safeFailure(error, 'sourceUnavailable');
        this.repository.progress(job, 'sourceError', { sourceId: source.config.id, error: failure, ...(error instanceof BackendError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) });
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
    const { mediaType, sourceUrl } = JSON.parse(version.metadata_json) as { mediaType: string; sourceUrl: string | null };
    let extracted;
    try { extracted = await extractText(this.storage.path(version.original_key), mediaType, signal, sourceUrl ?? undefined); }
    catch (error) {
      this.repository.progress(job, 'extractionDiagnostic', { versionId: version.id, originalHash: version.original_key, extractionError: safeFailure(error, 'extractionFailed').message });
      throw error;
    }
    this.repository.completeExtraction(job, extracted, null);
    this.afterTextExtraction?.(version.id);
  }
}
