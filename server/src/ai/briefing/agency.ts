/**
 * "My agency (live)": the briefing snapshot built on the server from an agency's own live
 * listings, so figures come from the database rather than from the browser.
 *
 * Per listing: views (last 30 days and the 30 before), saves, enquiries (last 30 days, total,
 * unanswered), days live, photos, price changes, and the asking price against the indicative
 * area range Streetkey shows listers (areaEvidence from the shared listings engine, the same
 * formula as the listing form's price check).
 */
import { areaEvidence } from '../../../../src/engine/listings';
import { q } from '../../db';
import { LISTING_SELECT, type ListingRow } from '../../services/listings';
import { orgIdsFor } from '../../routes/listings';
import { forbidden } from '../../services/http';
import { clip, LIMITS, Snapshot, type SnapshotT } from './snapshot';

interface Row extends ListingRow {
  views_30d: number; views_prev_30d: number; saves: number; enquiries_30d: number; enquiries_total: number; new_enquiries: number;
  photos: number; price_changes: number; previous_price: number | null; days_live: number;
}

const COND_ADJ: Record<string, number> = { good: 0.97, fair: 0.9, poor: 0.8, derelict: 0.68 };

/** Indicative area range for a listing (same method as the listing form's price check). */
export function areaRange(r: Pick<ListingRow, 'postcode' | 'channel' | 'floor_area' | 'condition'>) {
  let ev: ReturnType<typeof areaEvidence> = null;
  try { ev = areaEvidence(r.postcode); } catch { ev = null; }
  if (!ev) return null;
  const area = Number(r.floor_area);
  if (r.channel === 'rent') {
    return { low: Math.round((ev.rentPerM2 * area * 0.92) / 25) * 25, high: Math.round((ev.rentPerM2 * area * 1.08) / 25) * 25, scope: ev.scope, n: ev.n };
  }
  const adj = COND_ADJ[r.condition ?? 'fair'] ?? 0.9;
  return { low: Math.round((ev.refurbishedPerM2 * area * adj * 0.92) / 1000) * 1000, high: Math.round((ev.refurbishedPerM2 * area * adj * 1.08) / 1000) * 1000, scope: ev.scope, n: ev.n };
}

/** The agencies (organisations of kind 'agency') this person belongs to. */
export async function agenciesFor(userId: string) {
  const ids = await orgIdsFor(userId);
  if (!ids.length) return [];
  return q<{ id: string; name: string }>(`SELECT id, name FROM organisations WHERE id = ANY($1) AND kind = 'agency' ORDER BY name`, [ids]);
}

/** Builds the snapshot from the database. Throws 403 if the person isn't an agency member. */
export async function agencySnapshot(userId: string): Promise<{ snapshot: SnapshotT; orgIds: string[]; empty: boolean }> {
  const orgs = await agenciesFor(userId);
  if (!orgs.length) throw forbidden();
  const orgIds = orgs.map((o) => o.id);
  const rows = await q<Row>(
    `WITH mine AS (
       ${LISTING_SELECT} WHERE l.organisation_id = ANY($1) AND l.status IN ('live', 'under_offer')
       ORDER BY coalesce(l.published_at, l.created_at) DESC LIMIT ${LIMITS.items}
     )
     SELECT m.*,
       greatest(0, floor(extract(epoch FROM now() - coalesce(m.published_at, m.created_at)) / 86400))::int AS days_live,
       coalesce(v.n30, 0)::int AS views_30d, coalesce(v.n60, 0)::int AS views_prev_30d,
       coalesce(s.n, 0)::int AS saves,
       coalesce(e.n30, 0)::int AS enquiries_30d, coalesce(e.n, 0)::int AS enquiries_total, coalesce(e.new_n, 0)::int AS new_enquiries,
       coalesce(ph.n, 0)::int AS photos,
       coalesce(pc.n, 0)::int AS price_changes, pc.previous_price
     FROM mine m
     LEFT JOIN (SELECT listing_id,
                  count(*) FILTER (WHERE occurred_at > now() - interval '30 days') n30,
                  count(*) FILTER (WHERE occurred_at <= now() - interval '30 days') n60
                FROM engagement_events
               WHERE name = 'listing_view' AND occurred_at > now() - interval '60 days' AND listing_id IN (SELECT id FROM mine)
               GROUP BY listing_id) v ON v.listing_id = m.id
     LEFT JOIN (SELECT listing_key, count(*) n FROM saved_listings WHERE listing_key IN (SELECT ref FROM mine) GROUP BY listing_key) s ON s.listing_key = m.ref
     LEFT JOIN (SELECT listing_id, count(*) n,
                  count(*) FILTER (WHERE created_at > now() - interval '30 days') n30,
                  count(*) FILTER (WHERE status = 'new') new_n
                FROM enquiries WHERE NOT filtered AND listing_id IN (SELECT id FROM mine) GROUP BY listing_id) e ON e.listing_id = m.id
     LEFT JOIN (SELECT listing_id, count(*) n FROM listing_photos WHERE listing_id IN (SELECT id FROM mine) GROUP BY listing_id) ph ON ph.listing_id = m.id
     LEFT JOIN LATERAL (
       SELECT count(*) n, (array_agg((detail->>'priceFrom')::numeric ORDER BY at DESC))[1] AS previous_price
         FROM audit_log WHERE action = 'listing.updated' AND subject = 'listing:' || m.ref AND detail ? 'priceTo'
     ) pc ON true
     ORDER BY coalesce(m.published_at, m.created_at) DESC`, [orgIds]);

  const items = rows.map((r) => {
    const range = areaRange(r);
    const price = Number(r.price);
    const position = range ? (price > range.high ? 'above area range' : price < range.low ? 'below area range' : 'within area range') : 'no area evidence';
    const notes: string[] = [];
    if (range) notes.push(clip(`Area range from ${range.n} demonstration comparable${range.n === 1 ? '' : 's'} in ${range.scope}`, 200));
    if (r.status === 'under_offer') notes.push('Under offer');
    return {
      id: r.ref,
      label: clip(`${r.title || `${r.beds}-bed ${r.property_type}`}, ${r.address_line}, ${r.town}`, 120),
      group: r.channel === 'rent' ? 'to let' : 'for sale',
      fields: {
        price, priceBasis: r.channel === 'rent' ? 'pcm' : clip(r.price_qualifier || 'asking', 30), property: clip(`${r.beds}-bed ${r.property_type}`, 60),
        daysLive: r.days_live, views30d: r.views_30d, viewsPrior30d: r.views_prev_30d, saves: r.saves,
        enquiries30d: r.enquiries_30d, enquiriesTotal: r.enquiries_total, unansweredEnquiries: r.new_enquiries, photos: r.photos,
        priceChanges: r.price_changes, previousPrice: r.previous_price == null ? null : Number(r.previous_price),
        areaRangeLow: range?.low ?? null, areaRangeHigh: range?.high ?? null, priceVsArea: position,
      },
      notes,
    };
  });
  const sum = (k: 'views_30d' | 'enquiries_30d' | 'new_enquiries' | 'saves') => rows.reduce((s, r) => s + r[k], 0);
  const metrics = rows.length ? [
    { label: 'Live listings', value: rows.length },
    { label: 'Views in the last 30 days', value: sum('views_30d') },
    { label: 'Enquiries in the last 30 days', value: sum('enquiries_30d') },
    { label: 'Unanswered enquiries', value: sum('new_enquiries') },
    { label: 'Saves', value: sum('saves') },
  ] : [{ label: 'Live listings', value: 0 }];
  const base = {
    title: clip(`${orgs.map((o) => o.name).join(', ')}: live listings`, 120),
    scope: 'Live Streetkey listings for your agency. Views are counted only for visitors who consented to analytics, so they understate total interest.',
    asOf: new Date().toISOString().slice(0, 10),
    metrics,
  };
  // Stay inside the snapshot size limit: drop the oldest listings first and say so.
  let kept = items;
  while (kept.length > 1 && JSON.stringify({ ...base, items: kept }).length > LIMITS.chars - 400) kept = kept.slice(0, -1);
  const notes = kept.length < rows.length || rows.length >= LIMITS.items ? [`Covers the ${kept.length} most recently published listings.`] : [];
  const snapshot = Snapshot.parse({ ...base, items: kept, notes });
  return { snapshot, orgIds, empty: rows.length === 0 };
}
