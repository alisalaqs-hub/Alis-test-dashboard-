-- Inbox fixes.
--
-- Which enquirer messages the spam/scam screen held back (never emailed to the lister). A
-- conversation can be held from its first message, or from a follow-up the screen caught later;
-- "Not spam" emails exactly the held messages, then clears the flag.
ALTER TABLE enquiry_messages ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false;
-- Conversations already held back: none of their enquirer messages were emailed.
UPDATE enquiry_messages m SET held = true
  FROM enquiries e
 WHERE e.id = m.enquiry_id AND e.filtered AND m.author = 'enquirer' AND NOT m.held;

-- Stored triage from before the stricter checks (urgency, offers, questions and negated buying-position
-- flags are now checked against the enquirer's words) may show chips the enquirer never earned. It is
-- derived data: drop it, and each conversation is triaged again the next time its lister opens it.
DELETE FROM enquiry_ai;
