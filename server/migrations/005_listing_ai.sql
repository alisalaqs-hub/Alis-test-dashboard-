-- AI help for people listing a property: per-photo analysis stored alongside each listing photo.
-- Written by the 'listing.photos' background job (vision model, low detail) after photos are uploaded.
-- Only labels and checks are stored here; no prompts and no model output beyond these fields.
ALTER TABLE listing_photos ADD COLUMN IF NOT EXISTS ai_room text;             -- e.g. 'kitchen', 'front exterior'
ALTER TABLE listing_photos ADD COLUMN IF NOT EXISTS ai_alt text;              -- suggested alt text (<= 120 chars)
ALTER TABLE listing_photos ADD COLUMN IF NOT EXISTS ai_quality jsonb;         -- { score: 1-10, issues: ['dark', 'blurry', ...] }
ALTER TABLE listing_photos ADD COLUMN IF NOT EXISTS ai_features text[];       -- features visible in the photo
ALTER TABLE listing_photos ADD COLUMN IF NOT EXISTS ai_flags text[];          -- 'people', 'personal-info', 'number-plate', ...
ALTER TABLE listing_photos ADD COLUMN IF NOT EXISTS ai_checked_at timestamptz; -- NULL = not analysed yet
CREATE INDEX IF NOT EXISTS listing_photos_unchecked_idx ON listing_photos (listing_id) WHERE ai_checked_at IS NULL;
