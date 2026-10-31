import { resolve4 } from 'node:dns/promises';
import { request } from 'node:https';
import type { Readable } from 'node:stream';
import { PublicUrlSchema } from '../shared/contracts/index.js';
import type { Download, OfficialFetcher } from './adapters/types.js';
import { BackendError } from './errors.js';
import { downloadDiagnostic } from './download-diagnostics.js';

export function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0);
}
export function validateOfficialUrl(value: string, hosts: readonly string[]): URL {
  const url = new URL(PublicUrlSchema.parse(value));
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || !hosts.includes(url.hostname)) throw new BackendError('sourceUnavailable', 'Source URL is outside the configured official HTTPS hosts.', 500);
  return url;
}
export async function readBounded(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) { stream.destroy(); throw new BackendError('sourceUnavailable', 'Download exceeds the byte limit.', 500); }
    chunks.push(bytes);
  }
  if (!size) throw new BackendError('sourceUnavailable', 'Source returned an empty document.', 500);
  return Buffer.concat(chunks, size);
}
export class HttpsOfficialFetcher implements OfficialFetcher {
  constructor(private hosts: readonly string[], private timeoutMs = 30_000) {}
  async get(value: string, maxBytes: number, parentSignal?: AbortSignal): Promise<Download> {
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    try {
      let url = validateOfficialUrl(value, this.hosts);
      for (let redirects = 0; redirects <= 3; redirects++) {
        const addresses = await Promise.race([resolve4(url.hostname), new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })]);
        if (!addresses.length || addresses.some(address => !isPublicIpv4(address))) throw new BackendError('sourceUnavailable', 'Official host resolved to a non-public address.', 500);
        const pinnedAddress = addresses[0]!;
        const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
          const req = request(url, {
            signal, agent: false,
            headers: { 'User-Agent': 'RIA-Level1/0.1 (regulatory-publication-monitor)', Accept: '*/*', 'Accept-Encoding': 'identity' },
            lookup: (_hostname, options, callback) => options.all
              ? callback(null, [{ address: pinnedAddress, family: 4 }])
              : callback(null, pinnedAddress, 4),
          }, resolve);
          req.on('error', reject);
          req.end();
        });
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          if (!location || redirects === 3) throw new BackendError('sourceUnavailable', 'Too many or invalid source redirects.', 500);
          url = validateOfficialUrl(new URL(location, url).href, this.hosts);
          continue;
        }
        if (Number(response.headers['content-length']) > maxBytes || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          response.destroy(); throw new BackendError('sourceUnavailable', 'Source response exceeds the limit or uses unsupported transport compression.', 500);
        }
        const bytes = await readBounded(response, maxBytes);
        const contentType = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (status !== 200) throw new BackendError('sourceUnavailable', `Official source returned HTTP ${status}.`, 500, status === 429 || status >= 500, downloadDiagnostic(status, url.href, contentType, bytes));
        return { bytes, contentType, finalUrl: url.href, httpStatus: status };
      }
      throw new BackendError('sourceUnavailable', 'Source redirect limit reached.', 500);
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError('sourceUnavailable', 'Official source download failed or timed out.', 500, true);
    }
  }
}
