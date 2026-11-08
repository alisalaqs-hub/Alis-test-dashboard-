/**
 * Applies server/migrations/*.sql in order, once each, inside a transaction.
 * Run: npm run db:migrate   (also runs automatically when the server starts; CLI in bin/migrate.ts)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './config';
import { pool } from './db';

export async function migrate(log: (m: string) => void = () => {}) {
  const dir = path.join(ROOT, 'server/migrations');
  const files = (await fs.readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const c = await pool.connect();
  try {
    // One server at a time applies migrations.
    await c.query('SELECT pg_advisory_lock(727274)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await fs.readFile(path.join(dir, f), 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        log(`applied ${f}`);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    c.release();
  }
}
