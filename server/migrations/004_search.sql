-- AI search: one embedding per live listing for semantic matching ("similar homes", AI relevance).
-- Built from public listing facts and description only (never the private address).
-- text_hash lets the embedding job skip listings whose text hasn't changed.
CREATE TABLE listing_embeddings (
  listing_id  uuid PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  model       text NOT NULL,
  text_hash   text NOT NULL,
  embedding   real[] NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
