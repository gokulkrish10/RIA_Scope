import { z } from 'zod';
import { API_CONTRACT, ApiErrorSchema, MULTIPART_FIELDS, UploadFileDescriptorSchema, UploadMetadataSchema, UPLOAD_LIMITS, type UploadMetadata } from '../shared/contracts/index.js';

export class ApiFailure extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter: number = 2) { super(message); }
}
type Operation = { method: string; path: string };
export async function request<T>(operation: Operation, schema: z.ZodType<T>, options: { params?: Record<string, string>; query?: URLSearchParams; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let path = operation.path;
  for (const [key, value] of Object.entries(options.params ?? {})) path = path.replace(`:${key}`, encodeURIComponent(value));
  if (options.query?.size) path += `?${options.query}`;
  const response = await fetch(path, {
    method: operation.method, credentials: 'same-origin',
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.body === undefined ? {} : options.body instanceof FormData
      ? { body: options.body } : { body: JSON.stringify(options.body), headers: { 'Content-Type': 'application/json' } }),
  });
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new ApiFailure('The API did not return JSON. Confirm the backend is available at /api/v1.', response.status); }
  if (!response.ok) {
    const error = ApiErrorSchema.parse(payload);
    throw new ApiFailure(`${error.error.code}: ${error.error.message} (request ${error.requestId})`, response.status, Math.max(1, Number(response.headers.get('Retry-After')) || 2));
  }
  return schema.parse(payload);
}

export function upload(file: File, metadata: UploadMetadata, onProgress: (percent: number) => void) {
  const declaredTypes: Record<string, string> = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain' };
  const descriptor = UploadFileDescriptorSchema.parse({ fileName: file.name, mediaType: file.type || declaredTypes[file.name.split('.').pop()?.toLowerCase() ?? ''], sizeBytes: file.size });
  const serialized = JSON.stringify(UploadMetadataSchema.parse(metadata));
  if (new TextEncoder().encode(serialized).length > UPLOAD_LIMITS.maxMetadataBytes) throw new Error('Upload metadata exceeds 16 KiB.');
  const body = new FormData();
  body.append(MULTIPART_FIELDS.file, new Blob([file], { type: descriptor.mediaType }), file.name);
  body.append(MULTIPART_FIELDS.metadata, serialized);
  return new Promise<z.infer<typeof API_CONTRACT.uploadDocument.responses[202]>>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(API_CONTRACT.uploadDocument.method, API_CONTRACT.uploadDocument.path);
    xhr.timeout = 120000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onerror = () => reject(new Error('Upload connection failed. Check the backend before retrying.'));
    xhr.ontimeout = () => reject(new Error('Upload timed out. Check the repository before retrying.'));
    xhr.onload = () => {
      try {
        const payload: unknown = JSON.parse(xhr.responseText);
        if (xhr.status !== 202) { const failure = ApiErrorSchema.parse(payload); throw new ApiFailure(`${failure.error.code}: ${failure.error.message}`, xhr.status); }
        resolve(API_CONTRACT.uploadDocument.responses[202].parse(payload));
      } catch (error) { reject(error); }
    };
    xhr.send(body);
  });
}
