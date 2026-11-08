/**
 * Scheduled jobs. Run with: npm run job -- <name>
 *   alerts   email saved-search matches (instant/daily/weekly), run hourly
 *   cleanup  remove expired sessions and links, and raw analytics older than 13 months, run daily
 */
import { setDynamicListings, type Property } from '../../../src/data/properties';
import { buildListing } from '../../../src/engine/listings';
import { parseQuery, runSearch } from '../../../src/engine/search';
import type { PropertyType } from '../../../src/engine/refurb';
import { q } from '../db';
import { mails } from '../services/email';
import { LISTING_SELECT, toDTO, type ListingRow } from '../services/listings';

const DUE: Record<string, string> = { instant: '50 minutes', daily: '23 hours', weekly: '6 days 23 hours' };

/** A live listing as the website's search engine sees it, so alerts match exactly what search shows. */
function asProperty(r: ListingRow): Property {
  const d = toDTO(r, [], {});
  return buildListing({
    id: d.ref, listing: d.channel, title: d.title ?? undefined, addressLine: d.addressLine, town: d.town, postcode: r.postcode,
    type: d.type as PropertyType, tenure: d.tenure, leaseYears: d.leaseYears ?? undefined, beds: d.beds, baths: d.baths, floorArea: d.floorArea,
    price: d.price, epc: d.epc ?? undefined, councilTax: d.councilTax ?? undefined, features: d.features, description: d.description ?? undefined,
    source: { kind: d.source.kind === 'landlord' ? 'landlord' : d.source.kind === 'owner' ? 'owner' : 'agent-feed', name: d.source.name, licence: '', verified: d.source.verified },
    geo: d.lat != null && d.lng != null ? { lat: d.lat, lng: d.lng } : undefined, status: 'live',
  });
}

export async function runAlerts(now = new Date()) {
  const searches = await q<{ id: string; query: string; mode: string; alert_frequency: string; last_alerted_at: Date | null; created_at: Date; email: string }>(
    `SELECT s.id, s.query, s.mode, s.alert_frequency, s.last_alerted_at, s.created_at, u.email FROM saved_searches s JOIN users u ON u.id = s.user_id
      WHERE u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL AND s.alert_frequency <> 'off'
        AND (s.last_alerted_at IS NULL OR s.last_alerted_at < $1::timestamptz - (CASE s.alert_frequency WHEN 'instant' THEN $2 WHEN 'daily' THEN $3 ELSE $4 END)::interval)`,
    [now, DUE.instant, DUE.daily, DUE.weekly]);
  if (!searches.length) return { searches: 0, emails: 0 };
  const rows = await q<ListingRow>(`${LISTING_SELECT} WHERE l.status = 'live' AND l.published_at > now() - interval '8 days'`);
  const byRef = new Map(rows.map((r) => [r.ref, r]));
  setDynamicListings(rows.map(asProperty));
  let emails = 0;
  for (const s of searches) {
    const since = s.last_alerted_at ?? s.created_at;
    const text = s.mode === 'rent' && !/\brent|to let\b/i.test(s.query) ? `${s.query} to rent` : s.query;
    const hits = runSearch(parseQuery(text)).map((h) => byRef.get(h.property.id)).filter((r): r is ListingRow => !!r && !!r.published_at && r.published_at > since);
    if (hits.length) {
      await mails.searchAlert(s.email, s.query, hits.slice(0, 10).map((r) => ({ title: r.title ?? `${r.beds}-bed ${r.property_type} in ${r.town}`, ref: r.ref, price: `£${Math.round(r.price).toLocaleString('en-GB')}${r.channel === 'rent' ? ' pcm' : ''}` })));
      emails++;
    }
    await q('UPDATE saved_searches SET last_alerted_at = $2 WHERE id = $1', [s.id, now]);
  }
  setDynamicListings([]);
  return { searches: searches.length, emails };
}

export async function runCleanup() {
  const sessions = await q('DELETE FROM sessions WHERE expires_at < now() RETURNING 1');
  const tokens = await q(`DELETE FROM email_tokens WHERE expires_at < now() - interval '7 days' RETURNING 1`);
  const events = await q(`DELETE FROM engagement_events WHERE occurred_at < now() - interval '13 months' RETURNING 1`);
  return { sessions: sessions.length, tokens: tokens.length, events: events.length };
}
