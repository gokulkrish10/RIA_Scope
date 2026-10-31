import { UploadMetadataSchema, UploadFileDescriptorSchema, UPLOAD_LIMITS, MULTIPART_FIELDS } from '../shared/contracts/index.js';
import { BackendError } from './errors.js';
import { OriginalStorage } from './storage.js';
import { Repository } from './repository.js';

export async function uploadMultipart(repository: Repository, storage: OriginalStorage, contentType: string, bytes: Buffer) {
  if (!contentType.startsWith('multipart/form-data;') || !/boundary=/i.test(contentType)) throw new BackendError('unsupportedMediaType', 'Use multipart/form-data with a boundary.', 415);
  if (bytes.length > UPLOAD_LIMITS.maxRequestBytes) throw new BackendError('payloadTooLarge', 'Multipart request exceeds 21 MiB.', 413);
  let form: FormData;
  try { form = await new Request('http://localhost/', { method: 'POST', headers: { 'Content-Type': contentType }, body: new Uint8Array(bytes) }).formData(); }
  catch { throw new BackendError('validationError', 'Malformed multipart body.', 400); }
  const keys = [...form.keys()];
  if (keys.length !== 2 || keys.filter(k => k === MULTIPART_FIELDS.file).length !== 1 || keys.filter(k => k === MULTIPART_FIELDS.metadata).length !== 1) throw new BackendError('validationError', 'Supply exactly one file part and one metadata field, with no extra parts.', 400);
  const file = form.get(MULTIPART_FIELDS.file);
  const metadataText = form.get(MULTIPART_FIELDS.metadata);
  if (!(file instanceof File) || typeof metadataText !== 'string') throw new BackendError('validationError', 'file must be a binary file part; metadata must be a JSON text field.', 400);
  if (file.size > UPLOAD_LIMITS.maxFileBytes || Buffer.byteLength(metadataText, 'utf8') > UPLOAD_LIMITS.maxMetadataBytes) throw new BackendError('payloadTooLarge', 'File or metadata exceeds the upload limit.', 413);
  let input: unknown;
  try { input = JSON.parse(metadataText); } catch { throw new BackendError('validationError', 'metadata must contain valid JSON.', 400); }
  const metadata = UploadMetadataSchema.parse(input);
  const parsedFile = UploadFileDescriptorSchema.safeParse({ fileName: file.name, mediaType: file.type, sizeBytes: file.size });
  if (!parsedFile.success) throw new BackendError('unsupportedMediaType', 'Supported nonempty files are PDF, DOCX and UTF-8 TXT with matching extension/MIME.', 415);
  const original = Buffer.from(await file.arrayBuffer());
  if (file.type === 'application/pdf' && original.subarray(0, 5).toString() !== '%PDF-') throw new BackendError('unsupportedMediaType', 'File signature does not match PDF.', 415);
  if (file.type.includes('wordprocessingml') && original.subarray(0, 2).toString() !== 'PK') throw new BackendError('unsupportedMediaType', 'File signature does not match DOCX.', 415);
  if (file.type === 'text/plain') {
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(original); if (!text.trim() || text.includes('\u0000')) throw new Error(); }
    catch { throw new BackendError('validationError', 'Text documents must contain readable UTF-8 text.', 422); }
  }
  return repository.upload(metadata, parsedFile.data, await storage.put(original));
}
