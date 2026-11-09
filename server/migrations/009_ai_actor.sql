-- Per-person AI token caps: who each AI call is charged to ('u:<user id>' or an anonymised visitor network).
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS actor text;
CREATE INDEX IF NOT EXISTS ai_usage_actor_at_idx ON ai_usage (actor, at) WHERE actor IS NOT NULL;

-- Dashboard queries: saves per listing, and listings per organisation.
CREATE INDEX IF NOT EXISTS saved_listings_key_idx ON saved_listings (listing_key);
CREATE INDEX IF NOT EXISTS listings_org_idx ON listings (organisation_id) WHERE organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS engagement_views_idx ON engagement_events (listing_id, occurred_at) WHERE name = 'listing_view';

-- Background jobs remember who their AI usage is charged to.
ALTER TABLE ai_jobs ADD COLUMN IF NOT EXISTS actor text;
