-- AI trust & safety: an automated check of each submitted listing (content moderation of text
-- and photos, code-computed scam/material-information signals, then an AI review) that helps
-- admins prioritise the review queue. Reviews advise; people decide (AI never rejects).
CREATE TABLE listing_ai_reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id         uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  risk               text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  score              int NOT NULL CHECK (score BETWEEN 0 AND 100),     -- 0 = no concerns, 100 = almost certainly a problem
  flags              jsonb NOT NULL DEFAULT '[]',                         -- [{type, severity, detail, evidence, source: rules|ai}]
  signals            jsonb NOT NULL DEFAULT '{}',                         -- what the code checked (moderation, price vs area, duplicates…)
  summary            text NOT NULL DEFAULT '',
  suggested_reason   text,                                                -- polite, actionable wording for the lister if changes are needed
  auto_approved      boolean NOT NULL DEFAULT false,
  model              text,
  triggered_by       text NOT NULL DEFAULT 'submitted' CHECK (triggered_by IN ('submitted', 'admin')),
  listing_updated_at timestamptz,                                         -- the listing version reviewed (edits after this make it stale)
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listing_ai_reviews_latest ON listing_ai_reviews (listing_id, created_at DESC);
CREATE INDEX listing_ai_reviews_auto ON listing_ai_reviews (created_at) WHERE auto_approved;
