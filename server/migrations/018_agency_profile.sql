-- Agency profiles, and view and call counts for listings.
--
-- 1. What an agency says about itself on its public page (/agent/<id>), and where its leads are emailed.
--    Letting agents in England must show their fees, their redress scheme and their client money protection
--    scheme wherever they advertise, so the page has a place for each. leads_email is never shown publicly:
--    when set, enquiries and valuation requests for the agency go to it instead of to individual members.
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS phone               text,
  ADD COLUMN IF NOT EXISTS leads_email         citext,
  ADD COLUMN IF NOT EXISTS website             text,     -- https only
  ADD COLUMN IF NOT EXISTS about               text,     -- short plain text
  ADD COLUMN IF NOT EXISTS address             text,
  ADD COLUMN IF NOT EXISTS client_money_scheme text,
  ADD COLUMN IF NOT EXISTS redress_number      text,     -- membership number with the redress scheme
  ADD COLUMN IF NOT EXISTS fees_url            text;     -- https only: the agent's tenant and landlord fees

-- 2. How often each listing page is viewed and its phone number tapped: one row per listing per day, counts
--    only. Nothing here says who viewed. The daily clean-up deletes rows older than 13 months.
CREATE TABLE IF NOT EXISTS listing_views (
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  day        date NOT NULL,
  views      int NOT NULL DEFAULT 0,
  calls      int NOT NULL DEFAULT 0,
  PRIMARY KEY (listing_id, day)
);
-- For the clean-up.
CREATE INDEX IF NOT EXISTS listing_views_day_idx ON listing_views (day);

-- Views recorded so far (from visitors who allowed analytics) carry over as each day's starting figure, so
-- results don't drop to nothing on the day counting changes.
INSERT INTO listing_views (listing_id, day, views)
SELECT listing_id, occurred_at::date, count(*)::int
  FROM engagement_events
 WHERE name = 'listing_view' AND occurred_at > now() - interval '13 months'
 GROUP BY listing_id, occurred_at::date
ON CONFLICT (listing_id, day) DO NOTHING;
