-- AI for listers' inboxes: a triage of each enquiry (what they want, their buying position as
-- stated in their own words, the questions they asked, how soon) so listers can prioritise.
-- Written by the background job 'inbox.triage'; read only by the listing's lister.
CREATE TABLE enquiry_ai (
  enquiry_id      uuid PRIMARY KEY REFERENCES enquiries(id) ON DELETE CASCADE,
  intent          text NOT NULL,                         -- book_viewing, ask_question, make_offer, ...
  buyer_position  jsonb NOT NULL DEFAULT '{}',           -- only what the message states: chainFree, mortgageInPrinciple, cash, ...
  questions       text[] NOT NULL DEFAULT '{}',          -- the enquirer's own questions, briefly
  urgency         text NOT NULL DEFAULT 'unknown',       -- this_week, this_month, flexible, unknown
  summary         text NOT NULL DEFAULT '',
  sentiment       text NOT NULL DEFAULT 'neutral',       -- positive, neutral, negative
  model           text,
  messages_seen   int NOT NULL DEFAULT 0,                -- enquirer messages covered by this triage
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The spam screen looks for the same text sent from one email address to many listings.
CREATE INDEX IF NOT EXISTS enquiries_email_created_idx ON enquiries (email, created_at);
