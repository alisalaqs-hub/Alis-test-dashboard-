-- Inbox fixes.
--
-- Which enquirer messages the spam/scam screen held back (never emailed to the lister). A
-- conversation can be held from its first message, or from a follow-up the screen caught later;
-- "Not spam" emails exactly the held messages, then clears the flag.
ALTER TABLE enquiry_messages ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false;
-- Conversations already held back: until now only their opening message was kept from the lister
-- (later messages were emailed anyway), so only that one is marked held and emailed on "Not spam".
UPDATE enquiry_messages m SET held = true
  FROM enquiries e
 WHERE e.id = m.enquiry_id AND e.filtered AND NOT m.held
   AND m.id = (SELECT f.id FROM enquiry_messages f WHERE f.enquiry_id = e.id AND f.author = 'enquirer' ORDER BY f.created_at, f.id LIMIT 1);

-- Stored triage from before the stricter checks (urgency, offers, questions and negated buying-position
-- flags are now checked against the enquirer's words) may show chips the enquirer never earned. It is
-- derived data: drop it, and each conversation is triaged again the next time its lister opens it.
DELETE FROM enquiry_ai;
