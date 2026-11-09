/**
 * Scheduled jobs. Run with: npm run job -- <name>
 *   alerts   email saved-search matches (instant/daily/weekly), run hourly. Each alert runs the filters the
 *            person saw when saving (older saves: their words, read by the built-in rules in the saved mode)
 *   cleanup  remove expired sessions and links, and raw analytics older than 13 months, run daily
 */
import { ensureLiveRegistry } from '../ai/registry';
import { knownPlaces } from '../ai/search/intent';
import { alertSearch } from '../ai/search/saved';
import { deleteFile } from '../services/storage';
import { runSearch } from '../../../src/engine/search';
import { applyExtras } from '../../../src/lib/ai/search';
import { one, q } from '../db';
import { mails } from '../services/email';
import { LISTING_SELECT, type ListingRow } from '../services/listings';

const DUE: Record<string, string> = { instant: '50 minutes', daily: '23 hours', weekly: '6 days 23 hours' };

export async function runAlerts(now = new Date(), o: { deadline?: number; limit?: number } = {}) {
  const searches = await q<{ id: string; query: string; mode: string; filters: unknown; alert_frequency: string; last_alerted_at: Date | null; created_at: Date; email: string }>(
    `SELECT s.id, s.query, s.mode, s.filters, s.alert_frequency, s.last_alerted_at, s.created_at, u.email FROM saved_searches s JOIN users u ON u.id = s.user_id
      WHERE u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL AND s.alert_frequency <> 'off'
        AND (s.last_alerted_at IS NULL OR s.last_alerted_at < $1::timestamptz - (CASE s.alert_frequency WHEN 'instant' THEN $2 WHEN 'daily' THEN $3 ELSE $4 END)::interval)
      ORDER BY s.last_alerted_at NULLS FIRST LIMIT $5`,
    [now, DUE.instant, DUE.daily, DUE.weekly, o.limit ?? 200]);
  if (!searches.length) return { searches: 0, emails: 0, more: false };
  const rows = await q<ListingRow>(`${LISTING_SELECT} WHERE l.status = 'live' AND l.published_at > now() - interval '8 days'`);
  const byRef = new Map(rows.map((r) => [r.ref, r]));
  // Search the same registry the website uses (demo + every live listing), then keep recent live matches.
  await ensureLiveRegistry(0);
  const places = knownPlaces();
  let emails = 0, done = 0;
  for (const s of searches) {
    if (o.deadline && Date.now() > o.deadline) break; // the rest go out next run
    const since = s.last_alerted_at ?? s.created_at;
    const { query, extras } = alertSearch(s, places);
    const hits = applyExtras(runSearch(query), extras).map((h) => byRef.get(h.property.id)).filter((r): r is ListingRow => !!r && !!r.published_at && r.published_at > since);
    if (hits.length) {
      await mails.searchAlert(s.email, s.query, hits.slice(0, 10).map((r) => ({ title: r.title ?? `${r.beds}-bed ${r.property_type} in ${r.town}`, ref: r.ref, price: `£${Math.round(r.price).toLocaleString('en-GB')}${r.channel === 'rent' ? ' pcm' : ''}` })));
      emails++;
    }
    await q('UPDATE saved_searches SET last_alerted_at = $2 WHERE id = $1', [s.id, now]);
    done++;
  }
  return { searches: done, emails, more: done < searches.length };
}

/** Daily housekeeping. With ifDue, runs only when the last run was over ~23 hours ago (safe to call hourly). */
export async function runCleanup(o: { ifDue?: boolean } = {}) {
  if (o.ifDue) {
    const last = await one<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'last_cleanup_at'`);
    if (last && Date.now() - Date.parse(last.value) < 23 * 3600_000) return { skipped: true };
  }
  await q(`INSERT INTO app_settings (key, value, updated_at) VALUES ('last_cleanup_at', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [new Date().toISOString()]);
  await q(`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`);
  await q(`DELETE FROM ai_cache WHERE expires_at < now()`);
  await q(`DELETE FROM ai_usage WHERE at < now() - interval '13 months'`);
  // Renovation photos are deleted when their job finishes; this catches jobs whose worker died.
  const refurb = await q<{ id: string; input: { photos?: { key?: string }[] } }>(
    `SELECT id, input FROM ai_jobs WHERE kind = 'property.refurb_photos' AND status IN ('done', 'failed') AND finished_at < now() - interval '1 day' AND NOT coalesce((input->>'filesRemoved')::boolean, false) LIMIT 200`);
  for (const j of refurb) {
    await Promise.allSettled((j.input.photos ?? []).map((p) => (p.key ? deleteFile(p.key) : Promise.resolve())));
    await q(`UPDATE ai_jobs SET input = input || '{"filesRemoved": true}'::jsonb WHERE id = $1`, [j.id]);
  }
  // Designs belonging to deleted accounts (erasure removes them at once; this is a safety net).
  const orphans = await q<{ id: string; source_key: string | null; result_key: string | null }>(
    `SELECT a.id, a.source_key, a.result_key FROM ai_images a JOIN users u ON u.id = a.user_id WHERE u.deleted_at IS NOT NULL LIMIT 500`);
  await Promise.allSettled(orphans.flatMap((o2) => [o2.source_key, o2.result_key].filter((k): k is string => !!k).map((k) => deleteFile(k))));
  if (orphans.length) await q('DELETE FROM ai_images WHERE id = ANY($1::uuid[])', [orphans.map((o2) => o2.id)]);
  const sessions = await q('DELETE FROM sessions WHERE expires_at < now() RETURNING 1');
  const tokens = await q(`DELETE FROM email_tokens WHERE expires_at < now() - interval '7 days' RETURNING 1`);
  const events = await q(`DELETE FROM engagement_events WHERE occurred_at < now() - interval '13 months' RETURNING 1`);
  return { sessions: sessions.length, tokens: tokens.length, events: events.length, refurbPhotos: refurb.length, orphanDesigns: orphans.length };
}
