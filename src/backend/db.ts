import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export class Database {
  readonly sql: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    this.migrate();
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined { return this.sql.prepare(sql).get(...params) as T | undefined; }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] { return this.sql.prepare(sql).all(...params) as T[]; }
  run(sql: string, ...params: SQLInputValue[]) { return this.sql.prepare(sql).run(...params); }
  transaction<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.sql.exec('COMMIT'); return result; }
    catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
  private migrate() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
    const root = new URL('../../migrations/', import.meta.url);
    for (const name of readdirSync(root).filter(v => v.endsWith('.sql')).sort()) {
      const sql = readFileSync(new URL(name, root), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      this.transaction(() => {
        const prior = this.get<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name=?', name);
        if (prior) { if (prior.checksum !== checksum) throw new Error(`Applied migration was edited: ${name}`); return; }
        this.sql.exec(sql);
        this.run('INSERT INTO schema_migrations VALUES (?, ?, ?)', name, checksum, new Date().toISOString());
      });
    }
  }
  close() { this.sql.close(); }
}
