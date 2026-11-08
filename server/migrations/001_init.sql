-- Streetkey back end: first production schema (PostgreSQL 14+).
-- db/schema.sql is the long-range design (PostGIS, vectors, contractors, lettings);
-- this migration is what the running server uses today and grows by numbered migrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ───────────── People & organisations ─────────────
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext UNIQUE NOT NULL,
  password_hash     text NOT NULL,
  display_name      text NOT NULL,
  phone             text,
  role              text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  account_type      text NOT NULL DEFAULT 'buyer' CHECK (account_type IN ('buyer', 'owner', 'landlord', 'agent', 'developer', 'investor')),
  email_verified_at timestamptz,
  marketing_opt_in  boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE TABLE organisations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('agency', 'landlord', 'developer', 'contractor')),
  verified    boolean NOT NULL DEFAULT false,      -- e.g. redress scheme / Companies House checked by an admin
  redress_scheme text,                              -- The Property Ombudsman / Property Redress Scheme
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, user_id)
);

-- Session tokens are random; only their SHA-256 is stored.
CREATE TABLE sessions (
  token_hash  bytea PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  user_agent  text
);
CREATE INDEX ON sessions (user_id);
CREATE INDEX ON sessions (expires_at);

-- One-time links for email verification and password reset (hash only).
CREATE TABLE email_tokens (
  token_hash  bytea PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('terms', 'marketing', 'ai_image_processing', 'analytics')),
  version     text NOT NULL DEFAULT '1',
  granted_at  timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);
CREATE INDEX ON consents (user_id, purpose);

-- ───────────── Listings ─────────────
-- Full-text search document (declared immutable so it can back a generated column).
CREATE FUNCTION listing_tsv(title text, town text, district text, ptype text, descr text, features text[]) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT setweight(to_tsvector('english'::regconfig, coalesce(town, '') || ' ' || coalesce(district, '')), 'A')
      || setweight(to_tsvector('english'::regconfig, coalesce(title, '') || ' ' || coalesce(ptype, '')), 'B')
      || setweight(to_tsvector('english'::regconfig, coalesce(array_to_string(features, ' '), '') || ' ' || coalesce(descr, '')), 'C')
$$;

CREATE TABLE listings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref              text UNIQUE NOT NULL,             -- short public id used in URLs, e.g. sk-7g4k2m
  owner_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  organisation_id  uuid REFERENCES organisations(id) ON DELETE CASCADE,
  source_kind      text NOT NULL CHECK (source_kind IN ('owner', 'landlord', 'agent-feed', 'agent')),
  source_ref       text,                             -- agent's own reference (feeds)
  channel          text NOT NULL CHECK (channel IN ('sale', 'rent')),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'live', 'under_offer', 'sold', 'let', 'withdrawn', 'rejected')),
  title            text,
  address_line     text NOT NULL,                    -- never shown publicly in full for private sellers (street only)
  town             text NOT NULL,
  postcode         text NOT NULL,
  district         text NOT NULL,
  lat              double precision,
  lng              double precision,
  property_type    text NOT NULL,
  tenure           text NOT NULL CHECK (tenure IN ('freehold', 'leasehold', 'share-of-freehold')),
  lease_years      int,
  beds             int NOT NULL CHECK (beds BETWEEN 0 AND 30),
  baths            int NOT NULL CHECK (baths BETWEEN 0 AND 30),
  floor_area       numeric NOT NULL CHECK (floor_area > 0),
  era              text,
  condition        text,
  price            numeric NOT NULL CHECK (price > 0),
  price_qualifier  text,
  epc              text,
  council_tax      text,
  service_charge_annual numeric,
  ground_rent_annual    numeric,
  features         text[] NOT NULL DEFAULT '{}',
  description      text,
  material_info    jsonb NOT NULL DEFAULT '{}',      -- National Trading Standards material information (parts A–C)
  ownership_declared boolean NOT NULL DEFAULT false,  -- seller confirmed they own it / have authority
  ownership_verified boolean NOT NULL DEFAULT false,  -- checked by an admin (e.g. HM Land Registry title)
  rejection_reason text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  search           tsvector GENERATED ALWAYS AS (listing_tsv(title, town, district, property_type, description, features)) STORED
);
CREATE UNIQUE INDEX listings_feed_ref ON listings (organisation_id, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX ON listings (status, channel, price);
CREATE INDEX ON listings (district);
CREATE INDEX ON listings (owner_user_id);
CREATE INDEX listings_search ON listings USING gin (search);

CREATE TABLE listing_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  url         text NOT NULL,
  content_type text NOT NULL,
  bytes       int NOT NULL,
  position    int NOT NULL DEFAULT 0,
  alt         text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON listing_photos (listing_id, position);

-- ───────────── Buyers: saved homes, saved searches, enquiries ─────────────
CREATE TABLE saved_listings (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_key text NOT NULL,                         -- a Streetkey ref or a demo id
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, listing_key)
);

CREATE TABLE saved_searches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query           text NOT NULL,
  mode            text NOT NULL DEFAULT 'buy',
  alert_frequency text NOT NULL DEFAULT 'daily' CHECK (alert_frequency IN ('instant', 'daily', 'weekly', 'off')),
  last_alerted_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, query, mode)
);

CREATE TABLE enquiries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id    uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  from_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  name          text NOT NULL,
  email         citext NOT NULL,
  phone         text,
  kind          text NOT NULL CHECK (kind IN ('viewing', 'question', 'offer')),
  preferred_slot text,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'replied', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON enquiries (listing_id, created_at);
CREATE INDEX ON enquiries (from_user_id);

CREATE TABLE enquiry_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id  uuid NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  author      text NOT NULL CHECK (author IN ('enquirer', 'lister')),
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON enquiry_messages (enquiry_id, created_at);

-- ───────────── Agent feeds ─────────────
CREATE TABLE feed_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  label           text NOT NULL,
  prefix          text NOT NULL,                     -- first characters, shown in the UI
  key_hash        bytea UNIQUE NOT NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feed_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  feed_key_id     uuid REFERENCES feed_keys(id) ON DELETE SET NULL,
  format          text NOT NULL,
  accepted        int NOT NULL,
  withdrawn       int NOT NULL,
  rejected        jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ───────────── AI ─────────────
CREATE TABLE ai_images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  room          text NOT NULL,
  style         text NOT NULL,
  brief         text,
  prompt        text NOT NULL,
  source_key    text,
  result_key    text,
  result_url    text,
  model         text NOT NULL,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX ON ai_images (user_id, created_at);

-- ───────────── Engagement (consented, no personal data) ─────────────
CREATE TABLE engagement_events (
  id          bigserial PRIMARY KEY,
  listing_id  uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  session_id  text NOT NULL,                         -- random per browser session; not linked to a person
  name        text NOT NULL CHECK (name IN ('listing_view', 'photo_open', 'floorplan_open', 'save', 'share', 'viewing_request', 'enquiry', 'ai_question', 'refurb_sim', 'design_style')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON engagement_events (listing_id, occurred_at);

-- ───────────── Email log & audit ─────────────
CREATE TABLE emails (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_address  citext NOT NULL,
  template    text NOT NULL,
  subject     text NOT NULL,
  status      text NOT NULL CHECK (status IN ('sent', 'logged', 'failed')),
  provider_id text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_user_id uuid,
  action      text NOT NULL,
  subject     text,
  detail      jsonb,
  ip          text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (at);
CREATE INDEX ON audit_log (subject);
