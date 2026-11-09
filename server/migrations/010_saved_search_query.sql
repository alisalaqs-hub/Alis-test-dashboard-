-- Saved searches keep the filters the person saw (the validated reading, after removing chips and
-- setting page filters), so alerts run exactly that search instead of re-reading the words with the
-- built-in rules. NULL for searches saved before this change (alerts read their words as before).
ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS filters jsonb;
