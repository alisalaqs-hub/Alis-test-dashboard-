-- Listing history, and the record that keeps saved-search alerts from repeating themselves.

-- ───────────── Listing history ─────────────
-- What happened to each listing on the market, so its page can show when it was first listed, every
-- change to the asking price and how long it has been on the market. One row per event:
--   listed        first went on the market
--   price_change  the asking price changed (old_price → price)
--   under_offer   marked under offer
--   available     back on the market after being under offer
--   sold | let    marked sold or let
--   withdrawn     taken off the market
--   relisted      back on the market after being withdrawn, sold or let
-- price is the asking price (the monthly rent for a rental) at that moment. Nothing about who made a
-- change is kept here (the audit trail has that), so the history can be shown publicly as it stands.
CREATE TABLE IF NOT EXISTS listing_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id  uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('listed', 'price_change', 'under_offer', 'available', 'sold', 'let', 'withdrawn', 'relisted')),
  price       numeric NOT NULL CHECK (price > 0),
  old_price   numeric CHECK (old_price > 0),
  at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'price_change') = (old_price IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS listing_events_listing_idx ON listing_events (listing_id, at, id);

-- Listings that have already been on the market get their history from what is known about them.
-- 1. First listed, on the day they were published. The price then is the "from" price of the first change
--    the audit trail recorded after that day, or today's price when it recorded none.
INSERT INTO listing_events (listing_id, kind, price, at)
SELECT l.id, 'listed', coalesce(c.old_price, l.price), l.published_at
  FROM listings l
  LEFT JOIN LATERAL (
    SELECT x.old_price
      FROM (SELECT a.at, a.id,
                   CASE WHEN a.detail->>'priceFrom' ~ '^[0-9]{1,12}(\.[0-9]{1,4})?$' THEN (a.detail->>'priceFrom')::numeric END AS old_price,
                   CASE WHEN a.detail->>'priceTo' ~ '^[0-9]{1,12}(\.[0-9]{1,4})?$' THEN (a.detail->>'priceTo')::numeric END AS price
              FROM audit_log a
             WHERE a.subject = 'listing:' || l.ref AND a.action = 'listing.updated' AND a.at > l.published_at) x
     WHERE x.old_price > 0 AND x.price > 0 AND x.old_price <> x.price
     ORDER BY x.at, x.id LIMIT 1
  ) c ON true
 WHERE l.published_at IS NOT NULL;

-- 2. The price changes the audit trail recorded since then (edits by the lister and agency feed updates).
INSERT INTO listing_events (listing_id, kind, price, old_price, at)
SELECT x.listing_id, 'price_change', x.price, x.old_price, x.at
  FROM (SELECT l.id AS listing_id, a.at, a.id,
               CASE WHEN a.detail->>'priceFrom' ~ '^[0-9]{1,12}(\.[0-9]{1,4})?$' THEN (a.detail->>'priceFrom')::numeric END AS old_price,
               CASE WHEN a.detail->>'priceTo' ~ '^[0-9]{1,12}(\.[0-9]{1,4})?$' THEN (a.detail->>'priceTo')::numeric END AS price
          FROM listings l JOIN audit_log a ON a.subject = 'listing:' || l.ref
         WHERE l.published_at IS NOT NULL AND a.action = 'listing.updated' AND a.at > l.published_at) x
 WHERE x.old_price > 0 AND x.price > 0 AND x.old_price <> x.price
 ORDER BY x.at, x.id;

-- 3. Listings that are no longer simply for sale or to let: where they stand now, dated when the listing
--    last changed (the exact day wasn't recorded before this table existed). A listing waiting for review
--    after an edit counts as still on the market.
INSERT INTO listing_events (listing_id, kind, price, at)
SELECT l.id, CASE l.status WHEN 'under_offer' THEN 'under_offer' WHEN 'sold' THEN 'sold' WHEN 'let' THEN 'let' ELSE 'withdrawn' END,
       l.price, greatest(l.updated_at, l.published_at)
  FROM listings l
 WHERE l.published_at IS NOT NULL AND l.status IN ('under_offer', 'sold', 'let', 'withdrawn', 'draft', 'rejected');

-- ───────────── Alerts: which listing has been emailed to which saved search ─────────────
-- Both ways an alert goes out (the moment a listing goes live, and the hourly job) claim a row here
-- before sending, so the same listing is never emailed twice to the same saved search.
CREATE TABLE IF NOT EXISTS search_alert_sends (
  saved_search_id uuid NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  listing_id      uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  via             text NOT NULL CHECK (via IN ('instant', 'hourly')),
  sent_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (saved_search_id, listing_id)
);
CREATE INDEX IF NOT EXISTS search_alert_sends_listing_idx ON search_alert_sends (listing_id);
-- Finding the searches that want an email "as soon as they're listed" must be quick: it runs each time a listing goes live.
CREATE INDEX IF NOT EXISTS saved_searches_instant_idx ON saved_searches ((coalesce(last_alerted_at, created_at))) WHERE alert_frequency = 'instant';
