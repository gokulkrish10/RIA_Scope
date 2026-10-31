// Server-only diagnostics: no response headers, cookies, credentials or body excerpts.
export type FileSignature = 'pdf' | 'zip' | 'html' | 'utf8Text' | 'binary';
export function fileSignature(bytes: Buffer): FileSignature {
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'zip';
  const prefix = bytes.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(prefix)) return 'html';
  try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return text.includes('\0') ? 'binary' : 'utf8Text'; }
  catch { return 'binary'; }
}
export function diagnosticUrl(value: string): string {
  const url = new URL(value);
  url.username = ''; url.password = ''; url.hash = '';
  // Only known public document identifiers are useful in diagnostic URLs.
  for (const key of [...url.searchParams.keys()]) if (!/^(id|mode|node|page|year|month)$/i.test(key)) url.searchParams.set(key, '[redacted]');
  return url.href;
}
export interface DownloadDiagnostic {
  httpStatus: number; finalUrl: string; declaredContentType: string; byteCount: number;
  signature: FileSignature; extractionError: string | null;
}
export function downloadDiagnostic(status: number, finalUrl: string, contentType: string, bytes: Buffer): DownloadDiagnostic {
  return { httpStatus: status, finalUrl: diagnosticUrl(finalUrl), declaredContentType: contentType.slice(0, 160), byteCount: bytes.length, signature: fileSignature(bytes), extractionError: null };
}
