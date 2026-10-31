import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BackendError } from './errors.js';

export const ExtractedTextSchema = z.strictObject({
  text: z.string().trim().min(1).max(2_000_000),
  pages: z.array(z.strictObject({ pageNumber: z.number().int().positive().nullable(), text: z.string() })).min(1).max(300),
});
export type ExtractedText = z.infer<typeof ExtractedTextSchema>;
export async function extractText(filePath: string, mediaType: string, signal?: AbortSignal): Promise<ExtractedText> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--max-old-space-size=256', fileURLToPath(new URL('./extraction-child.mjs', import.meta.url)), filePath, mediaType], {
      timeout: 45_000, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL', env: {}, ...(signal ? { signal } : {}),
    }, (error, stdout) => {
      if (error) { reject(new BackendError('extractionFailed', 'Text extraction failed: unreadable, encrypted, corrupt or over-limit document.', 422)); return; }
      try { resolve(ExtractedTextSchema.parse(JSON.parse(stdout))); }
      catch { reject(new BackendError('extractionFailed', 'Text extractor returned no valid text.', 422)); }
    });
  });
}
