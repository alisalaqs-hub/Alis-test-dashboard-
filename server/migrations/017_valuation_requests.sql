-- Valuation requests: someone asks an estate or letting agent, from the agent's public page, to value
-- a home they want to sell or let.
--
-- A request goes only to the agent the person chose. It holds how to reach them, where the home is and
-- what they want to do with it, and nothing about their money: no funds, mortgage or income is asked
-- for or kept. user_id is set when the person was signed in, so the request is part of their data
-- export and goes when they delete their account. The daily clean-up deletes requests after 12 months.
CREATE TABLE IF NOT EXISTS valuation_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  email           citext NOT NULL,
  phone           text,
  postcode        text NOT NULL,
  address_line    text,
  intent          text NOT NULL CHECK (intent IN ('sell', 'let')),
  property_type   text,
  beds            int CHECK (beds BETWEEN 0 AND 30),
  message         text,
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS valuation_requests_org_idx ON valuation_requests (organisation_id, created_at DESC);
-- For a person's data export and account deletion.
CREATE INDEX IF NOT EXISTS valuation_requests_user_idx ON valuation_requests (user_id) WHERE user_id IS NOT NULL;
