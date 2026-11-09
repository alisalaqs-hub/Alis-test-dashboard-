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
import { createHash } from 'node:crypto';
import pg from 'pg';
import { config, ROOT } from './config';
import { pool } from './db';
import { EMBEDDED_MIGRATIONS } from './migrations.generated';

export async function loadMigrations(): Promise<{ name: string; sql: string }[]> {
  const dir = path.join(ROOT, 'server/migrations');
  if (fss.existsSync(dir)) {
    const files = (await fs.readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    return Promise.all(files.map(async (name) => ({ name, sql: await fs.readFile(path.join(dir, name), 'utf8') })));
  }
  return [...EMBEDDED_MIGRATIONS].sort((a, b) => a.name.localeCompare(b.name));
}

const checksum = (sql: string) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

let done: Promise<void> | null = null;
/**
 * Run once per process. Cheap when up to date: one query on the normal (pooled) connection;
 * the direct connection used for migrating is only opened when something is actually pending.
 */
export function ensureMigrated(log?: (m: string) => void) {
  if (!done) {
    done = (async () => {
      const wanted = (await loadMigrations()).map((m) => m.name);
      const have = await pool.query<{ name: string }>('SELECT name FROM schema_migrations').then((r) => new Set(r.rows.map((x) => x.name))).catch(() => new Set<string>());
      if (wanted.every((n) => have.has(n))) return;
      await migrate(log);
    })().catch((e) => { done = null; throw e; });
  }
  return done;
}

export async function migrate(log: (m: string) => void = () => {}) {
  const migrations = await loadMigrations();
  const client = new pg.Client({ connectionString: config.migrationsUrl, ssl: config.databaseSsl ? { rejectUnauthorized: config.databaseSslVerify } : undefined });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
    const rows = (await client.query<{ name: string; checksum: string | null }>('SELECT name, checksum FROM schema_migrations')).rows;
    const applied = new Set(rows.map((r) => r.name));
    // An applied migration must never change: new schema goes in a new numbered file.
    for (const r of rows) {
      const m = migrations.find((x) => x.name === r.name);
      if (!m) continue;
      const sum = checksum(m.sql);
      if (!r.checksum) await client.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [r.name, sum]);
      else if (r.checksum !== sum) {
        const msg = `Migration ${r.name} was changed after it was applied. Put schema changes in a new numbered migration instead.`;
        if (config.isProd) console.error(`[migrate] ${msg}`); else throw new Error(msg);
      }
    }
    for (const m of migrations) {
      if (applied.has(m.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(727274)');
        const again = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [m.name]);
        if (!again.rowCount) {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [m.name, checksum(m.sql)]);
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
