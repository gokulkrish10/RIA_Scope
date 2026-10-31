import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BackendError } from './errors.js';

export const ExtractedTextSchema = z.strictObject({
  text: z.string().trim().min(1).max(2_000_000),
  pages: z.array(z.strictObject({ pageNumber: z.number().int().positive().nullable(), text: z.string(), locator: z.string().min(1).max(400).optional() })).min(1).max(300),
});
export type ExtractedText = z.infer<typeof ExtractedTextSchema>;
export async function extractText(filePath: string, mediaType: string, signal?: AbortSignal, sourceUrl?: string): Promise<ExtractedText> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--max-old-space-size=256', fileURLToPath(new URL('./extraction-child.mjs', import.meta.url)), filePath, mediaType, ...(sourceUrl ? [sourceUrl] : [])], {
      timeout: 45_000, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL', env: {}, ...(signal ? { signal } : {}),
    }, (error, stdout, stderr) => {
      if (error) {
        const code = /RIA_EXTRACTION_ERROR:(\w+)/.exec(stderr)?.[1];
        const messages: Record<string, string> = {
          accessContent: 'Official source returned access-denied, login or challenge HTML. No regulatory text was extracted.',
          unverifiedHtml: 'HTML landing page or unsupported regulatory body. A verified official document link or body adapter is required.',
          imageOnlyPdf: 'PDF parsed successfully but contains images with no readable text layer. A verified accessible text source or separately reviewed OCR is required.',
          noReadableText: 'Document contains no readable text.',
          encryptedPdf: 'PDF is password protected; supply an authorized accessible document.',
        };
        reject(new BackendError('extractionFailed', messages[code ?? ''] ?? 'Text extraction failed: invalid, corrupt, unsupported or over-limit document.', 422)); return;
      }
      try { resolve(ExtractedTextSchema.parse(JSON.parse(stdout))); }
      catch { reject(new BackendError('extractionFailed', 'Text extractor returned no valid text.', 422)); }
    });
  });
}
