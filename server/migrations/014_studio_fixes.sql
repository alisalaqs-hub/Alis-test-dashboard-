-- Design studio: the site-wide daily cap on AI room redesigns (AI_DAILY_IMAGES_SITE) counts the
-- designs started in the last 24 hours across all accounts, before each new one is queued.
CREATE INDEX IF NOT EXISTS ai_images_created_idx ON ai_images (created_at);
