-- Official open data kept locally so pages are fast and the public services aren't asked twice.
--   sold_prices         HM Land Registry Price Paid Data (Open Government Licence v3.0), fetched per postcode on demand
--   sold_price_fetches  which postcodes have been fetched, when, and how far back
--   data_cache          everything else that is looked up (postcode locations, flood risk, energy certificates, house price index)

CREATE TABLE IF NOT EXISTS sold_prices (
  tx_id         text PRIMARY KEY,                 -- Land Registry transaction id
  postcode      text NOT NULL,
  paon          text,                             -- house name or number
  saon          text,                             -- flat or unit
  street        text,
  locality      text,
  town          text,
  district      text,
  price         integer NOT NULL,
  sold_on       date NOT NULL,
  property_type text NOT NULL,                    -- detached | semi-detached | terraced | flat | other
  new_build     boolean NOT NULL DEFAULT false,
  tenure        text,                             -- freehold | leasehold
  standard      boolean NOT NULL DEFAULT true,    -- false: "additional" transactions (repossessions, buy-to-lets, transfers to companies)
  fetched_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sold_prices_postcode_idx ON sold_prices (postcode, sold_on DESC);

CREATE TABLE IF NOT EXISTS sold_price_fetches (
  postcode   text PRIMARY KEY,
  since      date NOT NULL,                       -- sales on or after this date are stored
  rows       integer NOT NULL DEFAULT 0,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_cache (
  key        text PRIMARY KEY,                    -- e.g. flood:51.5906,-0.0185  epc:pc:E17 4PP  hpi:E09000031
  value      jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS data_cache_expires_idx ON data_cache (expires_at);
