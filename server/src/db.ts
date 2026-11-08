import pg from 'pg';
import { config } from './config';

// Return bigint counts as numbers and numeric as numbers (prices, areas): values here are well within safe range.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: config.databaseSslVerify } : undefined,
  max: config.databasePoolMax,
  // Serverless instances freeze between requests: drop idle connections quickly and fail fast.
  idleTimeoutMillis: config.runtime === 'netlify' ? 10_000 : 30_000,
  connectionTimeoutMillis: 10_000,
});
pool.on('error', () => { /* an idle client died (e.g. instance thawed); the pool replaces it */ });

export type Q = Pick<pg.PoolClient, 'query'>;

export async function q<T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = [], db: Q = pool): Promise<T[]> {
  const r = await db.query<T>(text, params);
  return r.rows;
}
export async function one<T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = [], db: Q = pool): Promise<T | null> {
  const r = await db.query<T>(text, params);
  return r.rows[0] ?? null;
}

/** Run work inside a transaction; rolls back on any error. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
