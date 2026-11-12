/**
 * Listing history: Streetkey records when a listing was first listed, each change to its asking price
 * and when it went under offer, was sold or let, was withdrawn or came back (table listing_events,
 * migration 016). Rightmove and Zoopla hide price changes; Streetkey shows them.
 *
 * recordHistory is the one place events are written. It compares where a listing stands now (status
 * and price) with the last thing its history says and adds whatever is missing, so every route that
 * changes a listing calls it straight after the change, in the same transaction, and never has to work
 * out what happened. Calling it again adds nothing.
 *
 * What counts:
 *   - on the market = live or under offer. The first time: 'listed'. Again after being withdrawn, sold
 *     or let: 'relisted'. Under offer and back: 'under_offer', 'available'.
 *   - off the market = sold, let, withdrawn, and a listing that was taken down (rejected) or is a draft
 *     again: 'sold', 'let' or 'withdrawn'.
 *   - waiting for review (pending) changes nothing: a listing held for a check after an edit is still
 *     the same listing when it comes back, and one that has never been public has no history yet.
 *   - the asking price is compared only while the listing is on the market, with the last price the
 *     history recorded. So a price changed in a draft before the first publication is not a "change",
 *     and one changed while the listing was off the market shows up on the day it comes back.
 * Events carry prices and dates only: nothing about who made the change (the audit trail has that).
 */
import type { ListingHistoryDTO } from '../../../src/lib/apiTypes';
import { summariseHistory, type ListingEvent, type ListingEventKind } from '../../../src/engine/history';
import { q, type Q } from '../db';

export async function recordHistory(listingIds: string[], db?: Q): Promise<void> {
  const ids = [...new Set(listingIds)];
  if (!ids.length) return;
  await q(
    `WITH st AS (
       SELECT l.id, l.status, l.price, l.published_at, e.price AS last_price,
              CASE WHEN s.kind IS NULL THEN 'never' WHEN s.kind IN ('listed', 'relisted', 'available') THEN 'on' WHEN s.kind = 'under_offer' THEN 'offer' ELSE 'off' END AS was,
              CASE l.status WHEN 'live' THEN 'on' WHEN 'under_offer' THEN 'offer' WHEN 'pending' THEN 'same' ELSE 'off' END AS becomes
         FROM listings l
         LEFT JOIN LATERAL (SELECT kind FROM listing_events WHERE listing_id = l.id AND kind <> 'price_change' ORDER BY at DESC, id DESC LIMIT 1) s ON true
         LEFT JOIN LATERAL (SELECT price FROM listing_events WHERE listing_id = l.id ORDER BY at DESC, id DESC LIMIT 1) e ON true
        WHERE l.id = ANY($1::uuid[])
     ), ev AS (
                 SELECT id, 1 AS step, 'listed' AS kind, price, NULL::numeric AS old_price, coalesce(published_at, now()) AS at FROM st WHERE was = 'never' AND becomes IN ('on', 'offer')
       UNION ALL SELECT id, 1, 'relisted', price, NULL, now() FROM st WHERE was = 'off' AND becomes IN ('on', 'offer')
       UNION ALL SELECT id, 1, 'available', price, NULL, now() FROM st WHERE was = 'offer' AND becomes = 'on'
       UNION ALL SELECT id, 2, 'price_change', price, last_price, now() FROM st WHERE was <> 'never' AND becomes IN ('on', 'offer') AND last_price <> price
       UNION ALL SELECT id, 3, 'under_offer', price, NULL, now() FROM st WHERE was <> 'offer' AND becomes = 'offer'
       UNION ALL SELECT id, 3, CASE status WHEN 'sold' THEN 'sold' WHEN 'let' THEN 'let' ELSE 'withdrawn' END, price, NULL, now() FROM st WHERE was IN ('on', 'offer') AND becomes = 'off'
     )
     INSERT INTO listing_events (listing_id, kind, price, old_price, at)
     SELECT id, kind, price, old_price, at FROM ev ORDER BY id, step`, [ids], db);
}

/** The public history of each listing that has been on the market (prices and dates only), keyed by listing id. */
export async function historyFor(listingIds: string[], db?: Q, now = new Date()): Promise<Map<string, ListingHistoryDTO>> {
  const out = new Map<string, ListingHistoryDTO>();
  if (!listingIds.length) return out;
  const rows = await q<{ listing_id: string; kind: ListingEventKind; price: number; old_price: number | null; at: Date }>(
    'SELECT listing_id, kind, price, old_price, at FROM listing_events WHERE listing_id = ANY($1) ORDER BY listing_id, at, id', [listingIds], db);
  const byListing = new Map<string, ListingEvent[]>();
  for (const r of rows) {
    const events = byListing.get(r.listing_id) ?? [];
    events.push({ kind: r.kind, at: r.at.toISOString(), price: Number(r.price), oldPrice: r.old_price == null ? null : Number(r.old_price) });
    byListing.set(r.listing_id, events);
  }
  for (const [id, events] of byListing) {
    const h = summariseHistory(events, now);
    if (h) out.set(id, h);
  }
  return out;
}
