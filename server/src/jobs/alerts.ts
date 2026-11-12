/**
 * Saved-search alerts: who may be emailed, what counts as a match and the one way an alert goes out.
 * Two paths use it, and neither repeats the other:
 *
 *   instant  the moment listings become publicly live (sendInstantAlerts, called from the
 *            'listingsPublished' hook): saved searches set to "as soon as they're listed"
 *   hourly   the scheduled job (runAlerts in jobs/run.ts): daily and weekly digests, and everything the
 *            instant path didn't get to
 *
 * Never twice: before a listing is put in an email it is claimed for that saved search in
 * search_alert_sends (one row per search and listing, migration 016). Whichever path claims it sends
 * it; the other finds the row and leaves it out. If the email provider refuses the message (nothing
 * was sent), the claim is released and the hourly job tries again each run until it is accepted. A
 * timeout is not a refusal (the email may have gone), so that claim stays and the failure is on record
 * in the emails table.
 *
 * Safe on serverless: the instant path never moves a saved search's "last alerted" mark, so the hourly
 * job needs nothing from it and finds whatever it left (time ran out, a cap was reached, the function
 * was stopped, an email was refused). The instant path only starts work it has time for, and lets an
 * email it has started finish rather than abandoning it half-sent.
 */
import type { Property } from '../../../src/data/properties';
import { runSearch } from '../../../src/engine/search';
import { applyExtras } from '../../../src/lib/ai/search';
import { ensureLiveRegistry, rowToProperty } from '../ai/registry';
import { knownPlaces } from '../ai/search/intent';
import { alertSearch } from '../ai/search/saved';
import { config } from '../config';
import { q } from '../db';
import { mails } from '../services/email';
import { LISTING_SELECT, type ListingRow } from '../services/listings';
import { hit } from '../services/ratelimit';

export interface AlertSearch {
  id: string; user_id: string; query: string; mode: string; filters: unknown; alert_frequency: string;
  last_alerted_at: Date | null; created_at: Date; email: string;
}

/** Saved searches whose owner may be emailed: alerts switched on, a confirmed email address, an account that still exists. */
export const ALERT_SEARCHES = `SELECT s.id, s.user_id, s.query, s.mode, s.filters, s.alert_frequency, s.last_alerted_at, s.created_at, u.email
  FROM saved_searches s JOIN users u ON u.id = s.user_id
 WHERE u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL AND s.alert_frequency <> 'off'`;

/** Listings an alert may mention: publicly live now, and published in the last 8 days. */
export const ALERTABLE_LISTINGS = `${LISTING_SELECT} WHERE l.status = 'live' AND l.published_at > now() - interval '8 days'`;

/** Listings in one alert email. */
export const MAX_LISTINGS_PER_EMAIL = 10;

/**
 * The listings a saved search matches and hasn't been told about (published since its last alert), best
 * match first. byRef: the listings that may be mentioned. pool: what to search, as the engines see
 * listings (the whole registry unless given).
 */
export function alertHits(s: AlertSearch, places: string[], byRef: Map<string, ListingRow>, pool?: Property[]): ListingRow[] {
  const since = s.last_alerted_at ?? s.created_at;
  const { query, extras } = alertSearch(s, places);
  return applyExtras(runSearch(query, pool), extras).map((h) => byRef.get(h.property.id)).filter((r): r is ListingRow => !!r && !!r.published_at && r.published_at > since);
}

/** A listing as an alert email shows it. */
const alertItem = (r: ListingRow) => ({ title: r.title ?? `${r.beds}-bed ${r.property_type} in ${r.town}`, ref: r.ref, price: `£${Math.round(r.price).toLocaleString('en-GB')}${r.channel === 'rent' ? ' pcm' : ''}` });

/**
 * Emails one saved search its matches: the first 10 it hasn't had, in the order given. Each is claimed
 * for this search first, so it can never be emailed to it again by either path. Returns how many
 * listings were emailed (0: nothing new, or the email failed) and whether the provider refused the email
 * (the claim is then released for the hourly job).
 */
export async function sendAlert(s: AlertSearch, hits: ListingRow[], via: 'instant' | 'hourly', o: { timeoutMs?: number } = {}): Promise<{ emailed: number; refused: boolean }> {
  if (!hits.length) return { emailed: 0, refused: false };
  const claimed = new Set((await q<{ listing_id: string }>(
    `INSERT INTO search_alert_sends (saved_search_id, listing_id, via)
     SELECT $1, x.id, $3 FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, n)
      WHERE NOT EXISTS (SELECT 1 FROM search_alert_sends a WHERE a.saved_search_id = $1 AND a.listing_id = x.id)
      ORDER BY x.n LIMIT $4
     ON CONFLICT DO NOTHING RETURNING listing_id`, [s.id, hits.map((r) => r.id), via, MAX_LISTINGS_PER_EMAIL])).map((c) => c.listing_id));
  const rows = hits.filter((r) => claimed.has(r.id));
  if (!rows.length) return { emailed: 0, refused: false };
  const sent = await mails.searchAlert(s.email, s.query, rows.map(alertItem), o);
  if (sent.status !== 'failed') return { emailed: rows.length, refused: false };
  if (sent.refused) await q('DELETE FROM search_alert_sends WHERE saved_search_id = $1 AND listing_id = ANY($2::uuid[])', [s.id, rows.map((r) => r.id)]);
  return { emailed: 0, refused: sent.refused };
}

/* ───────────── the moment a listing goes live ───────────── */

export const INSTANT = {
  /** How long the instant path may keep starting work, in milliseconds. Matching stops at half of it, so there is always time to send. */
  budgetMs: 2000,
  /** The longest one email may take. An email that has been started is finished, so the publisher's wait is at most the budget plus this. */
  sendTimeoutMs: 2500,
  /** Listings looked at per event (a large feed upload): the newest. The rest go out with the hourly job. */
  maxListings: 200,
  /** Saved searches looked at per event, longest-waiting first. */
  maxSearches: 2000,
  /** Instant alert emails one person can get in an hour, across all their saved searches. Further matches arrive with the hourly job. */
  perPersonPerHour: 10,
};

export interface InstantResult {
  /** Listings that are publicly live and new enough to alert on. */
  listings: number;
  /** Saved searches with something new to hear about. */
  searches: number;
  emails: number;
  /** Something was left for the hourly job: time ran out, a cap was reached, or an email wasn't accepted. */
  more: boolean;
}

/**
 * Emails saved searches set to "as soon as they're listed" about listings that have just gone live.
 * The listings are read again here, so only ones the public can see at this moment are ever mentioned
 * (a listing still waiting for review, or taken down again, is skipped). budgetMs: see INSTANT.
 */
export async function sendInstantAlerts(listingIds: string[], o: { budgetMs?: number } = {}): Promise<InstantResult> {
  const started = Date.now();
  const budget = o.budgetMs ?? INSTANT.budgetMs;
  const out: InstantResult = { listings: 0, searches: 0, emails: 0, more: false };
  const ids = [...new Set(listingIds)];
  if (!ids.length) return out;
  const rows = await q<ListingRow>(`${ALERTABLE_LISTINGS} AND l.id = ANY($1::uuid[]) ORDER BY l.published_at DESC LIMIT $2`, [ids, INSTANT.maxListings + 1]);
  if (rows.length > INSTANT.maxListings) { rows.length = INSTANT.maxListings; out.more = true; }
  out.listings = rows.length;
  if (!rows.length) return out;

  // Only searches that could be owed one of these listings: nothing published since their last alert means nothing to do.
  const searches = await q<AlertSearch>(
    `${ALERT_SEARCHES} AND s.alert_frequency = 'instant' AND coalesce(s.last_alerted_at, s.created_at) < $1
      ORDER BY coalesce(s.last_alerted_at, s.created_at) LIMIT $2`, [rows[0].published_at, INSTANT.maxSearches + 1]);
  if (searches.length > INSTANT.maxSearches) { searches.length = INSTANT.maxSearches; out.more = true; }
  if (!searches.length) return out;

  // The same matching as the hourly job, run over just these listings.
  await ensureLiveRegistry(0);
  const places = knownPlaces();
  const byRef = new Map(rows.map((r) => [r.ref, r]));
  const pool = rows.map((r) => rowToProperty(r));
  const due: { s: AlertSearch; hits: ListingRow[] }[] = [];
  for (const s of searches) {
    if (Date.now() - started > budget / 2) { out.more = true; break; }
    const hits = alertHits(s, places, byRef, pool);
    if (hits.length) due.push({ s, hits });
  }
  if (!due.length) return out;

  // What either path has already emailed (one query, so a feed sending its whole stock again costs next to nothing).
  const sent = new Set((await q<{ k: string }>(
    `SELECT saved_search_id::text || ':' || listing_id::text AS k FROM search_alert_sends WHERE saved_search_id = ANY($1::uuid[]) AND listing_id = ANY($2::uuid[])`,
    [due.map((d) => d.s.id), rows.map((r) => r.id)])).map((r) => r.k));
  for (const { s, hits } of due) {
    const fresh = hits.filter((r) => !sent.has(`${s.id}:${r.id}`));
    if (!fresh.length) continue;
    out.searches++;
    if (Date.now() - started > budget) { out.more = true; continue; }
    if (!(await hit(`alerts.instant:${s.user_id}`, INSTANT.perPersonPerHour, 3600)).ok) { out.more = true; continue; }
    try {
      const r = await sendAlert(s, fresh, 'instant', { timeoutMs: INSTANT.sendTimeoutMs });
      if (r.emailed) out.emails++;
      if (r.refused || fresh.length > MAX_LISTINGS_PER_EMAIL) out.more = true;
    } catch { out.more = true; } // e.g. the saved search was deleted a moment ago
  }
  return out;
}

/** The 'listingsPublished' hook: send instant alerts and say in the log what was sent or left for the hourly job. */
export async function instantAlerts(listingIds: string[]): Promise<void> {
  const r = await sendInstantAlerts(listingIds);
  if (!config.isTest && (r.emails || r.more)) console.log('[alerts] instant', JSON.stringify(r));
}
