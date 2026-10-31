import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class OriginalStorage {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid original key');
    return join(this.root, key);
  }
  async put(bytes: Buffer): Promise<{ hash: string; key: string }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const hash = sha256(bytes);
    const temporary = join(this.root, `.tmp-${randomUUID()}`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, this.path(hash)); }
    finally { await unlink(temporary).catch(() => undefined); }
    return { hash, key: hash };
  }
  async read(key: string): Promise<Buffer> {
    const bytes = await readFile(this.path(key));
    if (sha256(bytes) !== key) throw new Error('Original integrity check failed');
    return bytes;
  }
}
