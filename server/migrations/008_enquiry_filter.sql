-- Enquiry spam/scam screening columns. These first shipped inside 002, after some databases had
-- already applied 002, so they're (re)added here idempotently: every database ends up the same.
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS filtered boolean NOT NULL DEFAULT false;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS filter_reason text;
