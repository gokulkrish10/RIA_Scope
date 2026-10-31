import type { ErrorInfo } from '../shared/contracts/index.js';
import type { DownloadDiagnostic } from './download-diagnostics.js';

export class BackendError extends Error {
  constructor(public code: ErrorInfo['code'], message: string, public status = 500, public retryable = false, public diagnostic?: DownloadDiagnostic) { super(message); }
}
export class LeaseLostError extends Error {}
export const errorInfo = (code: ErrorInfo['code'], message: string, retryable = false): ErrorInfo => ({ code, message, retryable, details: [] });
export function safeFailure(error: unknown, code: ErrorInfo['code']): ErrorInfo {
  return error instanceof BackendError
    ? errorInfo(code, error.message, error.retryable)
    : errorInfo(code, 'Processing failed. Consult the server job log using the job ID.', true);
}
