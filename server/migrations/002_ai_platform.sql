-- AI platform foundation: usage accounting, background jobs, distributed rate limits,
-- and a key/value table for small runtime settings (e.g. the AI worker secret).

-- Every OpenAI call: who/what it was for, model, tokens and latency (no prompts or outputs stored).
CREATE TABLE ai_usage (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  purpose       text NOT NULL,                      -- e.g. assistant.chat, listing.describe, studio.room_image
  model         text NOT NULL,
  input_tokens  int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  images        int NOT NULL DEFAULT 0,
  latency_ms    int NOT NULL DEFAULT 0,
  ok            boolean NOT NULL DEFAULT true,
  error_code    text,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ai_usage (at);
CREATE INDEX ON ai_usage (user_id, at);
CREATE INDEX ON ai_usage (purpose, at);

-- Long-running AI work (image editing, photo analysis, listing review) runs as jobs:
-- the request enqueues, a worker (background function or in-process) processes, the browser polls.
CREATE TABLE ai_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  subject       text,                               -- e.g. listing:sk-abc1234
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  input         jsonb NOT NULL DEFAULT '{}',
  output        jsonb,
  error         text,                               -- safe to show to the person
  attempts      int NOT NULL DEFAULT 0,
  progress      text,                               -- short human-readable progress note
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  lease_until   timestamptz                         -- a running job whose lease expired can be retried
);
CREATE INDEX ON ai_jobs (status, created_at);
CREATE INDEX ON ai_jobs (user_id, created_at);
CREATE INDEX ON ai_jobs (subject);

-- Fixed-window counters shared by every server instance (serverless-safe rate limiting).
CREATE TABLE rate_limits (
  key           text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         int NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX ON rate_limits (window_start);

CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (key, value) VALUES ('ai_worker_secret', encode(gen_random_bytes(32), 'hex')) ON CONFLICT DO NOTHING;

-- Short-lived cache for deterministic AI results (e.g. the same search phrase parsed twice).
CREATE TABLE ai_cache (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX ON ai_cache (expires_at);

-- Enquiries an automated screen judged to be spam or a scam are kept (for the record and appeals)
-- but not emailed to the lister and shown under "Filtered" in their inbox.
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS filtered boolean NOT NULL DEFAULT false;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS filter_reason text;
