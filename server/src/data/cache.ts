/**
 * Database cache for official data lookups. A fresh entry is returned as it is; otherwise the
 * lookup runs and its answer is stored. If the lookup fails and an older answer exists, the older
 * answer is returned (marked stale) rather than an error: flood maps and certificates change slowly.
 */
import { one, q } from '../db';

export interface Cached<T> { value: T; fetchedAt: Date; stale: boolean }

export async function cachedData<T>(key: string, ttlSec: number, fn: () => Promise<T>, opts: { store?: (v: T) => boolean } = {}): Promise<Cached<T>> {
  const row = await one<{ value: T; fetched_at: Date; fresh: boolean }>('SELECT value, fetched_at, expires_at > now() AS fresh FROM data_cache WHERE key = $1', [key]).catch(() => null);
  if (row?.fresh) return { value: row.value, fetchedAt: row.fetched_at, stale: false };
  try {
    const value = await fn();
    if (!opts.store || opts.store(value)) {
      await q(`INSERT INTO data_cache (key, value, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, fetched_at = now(), expires_at = EXCLUDED.expires_at`, [key, JSON.stringify(value), ttlSec]).catch(() => {});
    }
    return { value, fetchedAt: new Date(), stale: false };
  } catch (e) {
    if (row) return { value: row.value, fetchedAt: row.fetched_at, stale: true };
    throw e;
  }
}

export const DAY = 86_400;
