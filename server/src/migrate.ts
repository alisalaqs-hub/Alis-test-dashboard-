/**
 * Applies server/migrations/*.sql in order, once each, each inside its own transaction.
 * Safe with connection poolers (PgBouncer / Neon pooled URLs): uses transaction-scoped
 * advisory locks and re-checks inside the transaction, so concurrent cold starts can't
 * apply a migration twice.
 *
 * Source of migrations: the .sql files when the folder exists (development, Node server),
 * otherwise the copy embedded at build time (serverless bundles have no repo folder).
 * Run by hand: npm run db:migrate. Also runs on server start / first serverless request.
 */
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config, ROOT } from './config';
import { EMBEDDED_MIGRATIONS } from './migrations.generated';

export async function loadMigrations(): Promise<{ name: string; sql: string }[]> {
  const dir = path.join(ROOT, 'server/migrations');
  if (fss.existsSync(dir)) {
    const files = (await fs.readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    return Promise.all(files.map(async (name) => ({ name, sql: await fs.readFile(path.join(dir, name), 'utf8') })));
  }
  return [...EMBEDDED_MIGRATIONS].sort((a, b) => a.name.localeCompare(b.name));
}

let done: Promise<void> | null = null;
/** Run once per process (cheap when up to date: one query). */
export function ensureMigrated(log?: (m: string) => void) {
  if (!done) done = migrate(log).catch((e) => { done = null; throw e; });
  return done;
}

export async function migrate(log: (m: string) => void = () => {}) {
  const migrations = await loadMigrations();
  const client = new pg.Client({ connectionString: config.migrationsUrl, ssl: config.databaseSsl ? { rejectUnauthorized: config.databaseSslVerify } : undefined });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const m of migrations) {
      if (applied.has(m.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(727274)');
        const again = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [m.name]);
        if (!again.rowCount) {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
          log(`applied ${m.name}`);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${m.name} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}
