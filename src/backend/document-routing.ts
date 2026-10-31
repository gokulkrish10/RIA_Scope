import { createHash } from 'node:crypto';
import { BackendError } from './errors.js';
import { fileSignature } from './download-diagnostics.js';
import { regulatoryHtml } from './html-body.mjs';
import type { Candidate, Download } from './adapters/types.js';

export function routeDocument(download: Download, candidate: Candidate) {
  const signature = fileSignature(download.bytes);
  if (signature === 'pdf') return { candidate: { ...candidate, mediaType: 'application/pdf' as const } };
  if (signature === 'html') {
    if (!['www.rbi.org.in', 'rbi.org.in'].includes(new URL(download.finalUrl).hostname)) throw new BackendError('sourceUnavailable', 'HTML needs a verified source-specific regulatory body extractor; it is not a PDF.', 500);
    try {
      const body = regulatoryHtml(download.bytes.toString('utf8'));
      // Web session fields/navigation change on every fetch. Original bytes remain immutable,
      // while versions are keyed by regulatory text, reference links and status markers.
      const contentHash = createHash('sha256').update('ria-rbi-html-v1\0').update(JSON.stringify({ text: body.text, links: body.links })).digest('hex');
      return { candidate: { ...candidate, title: body.title, referenceNumber: body.referenceNumber, publicationDate: body.publicationDate, mediaType: 'text/html' as const }, contentHash };
    } catch (error) { throw new BackendError('sourceUnavailable', error instanceof Error ? error.message : 'Invalid regulatory HTML.', 500); }
  }
  if (signature === 'zip' && candidate.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return { candidate };
  // Keep malformed declared text as a failed extraction with its original retained.
  // HTML has already taken the guarded route above and cannot reach the text parser.
  if (['utf8Text', 'binary'].includes(signature) && candidate.mediaType === 'text/plain' && ['text/plain', 'application/octet-stream'].includes(download.contentType)) return { candidate };
  throw new BackendError('sourceUnavailable', 'Downloaded signature is incompatible with the regulatory document format.', 500);
}
