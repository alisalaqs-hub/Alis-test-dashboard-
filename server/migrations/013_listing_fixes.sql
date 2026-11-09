-- Agent feeds: remember which feed key last supplied each listing, so an agency can send each branch's
-- stock with its own key (keeping every upload under the hosting limit) without one branch's upload
-- withdrawing another branch's listings. Listings imported before this change have no key and are
-- treated as belonging to any of the agency's keys, as before.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS feed_key_id uuid REFERENCES feed_keys(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS listings_feed_key_idx ON listings (feed_key_id) WHERE feed_key_id IS NOT NULL;
