-- Trust & safety fixes.
-- 1. Edits to a submitted or live private listing are re-reviewed ('edited'), so changes made after approval
--    can't skip the checks.
-- 2. A review remembers a fingerprint of the content it checked (text, price, address, material information and
--    photos), so "changed since it was checked" means the content changed, not just any update such as an approval.
ALTER TABLE listing_ai_reviews DROP CONSTRAINT IF EXISTS listing_ai_reviews_triggered_by_check;
ALTER TABLE listing_ai_reviews ADD CONSTRAINT listing_ai_reviews_triggered_by_check CHECK (triggered_by IN ('submitted', 'admin', 'edited'));
ALTER TABLE listing_ai_reviews ADD COLUMN IF NOT EXISTS content_hash text;
-- Recently edited live listings (the admin's "changed since approval" list).
CREATE INDEX IF NOT EXISTS listing_ai_reviews_edited ON listing_ai_reviews (created_at) WHERE triggered_by = 'edited';
