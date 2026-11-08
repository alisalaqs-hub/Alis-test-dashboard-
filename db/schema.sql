-- Plinth — initial PostgreSQL 16 + PostGIS schema (v0.1)
-- Multi-tenant: tenant-owned tables carry organisation_id and are protected by RLS.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS citext;

-- ───────────── Identity, tenancy, billing ─────────────
CREATE TABLE organisations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('consumer','agency','landlord','contractor','developer','lender','enterprise','internal')),
  plan          text NOT NULL DEFAULT 'free',
  stripe_customer_id text,
  data_region   text NOT NULL DEFAULT 'uk',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  display_name  text,
  auth_subject  text UNIQUE NOT NULL,         -- OIDC sub
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organisation_id uuid REFERENCES organisations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL,              -- consumer, investor, landlord, agent_admin, ..., platform_admin
  PRIMARY KEY (organisation_id, user_id)
);

CREATE TABLE api_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('secret','publishable')),
  prefix          text NOT NULL,              -- shown in UI, e.g. sk_live_51ab
  key_hash        bytea NOT NULL,             -- argon2/sha256 of full key
  scopes          text[] NOT NULL DEFAULT '{}',
  allowed_origins text[] NOT NULL DEFAULT '{}',
  rate_limit_rps  int NOT NULL DEFAULT 10,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_events (
  id              bigserial PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  api_key_id      uuid REFERENCES api_keys(id),
  endpoint        text NOT NULL,
  units           numeric NOT NULL DEFAULT 1,
  status_code     int,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON usage_events (organisation_id, occurred_at);

-- ───────────── Property graph ─────────────
CREATE TABLE properties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uprn            bigint UNIQUE,              -- OS Unique Property Reference Number
  address         jsonb NOT NULL,
  postcode        text NOT NULL,
  nation          text NOT NULL CHECK (nation IN ('england','wales','scotland','northern-ireland')),
  location        geography(Point, 4326) NOT NULL,
  property_type   text,
  tenure          text,
  floor_area_m2   numeric,
  construction_era text,
  bedrooms        int,
  bathrooms       int,
  lad_code        text,                       -- local authority district
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON properties USING gist (location);
CREATE INDEX ON properties (postcode);

CREATE TABLE listings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL REFERENCES properties(id),
  organisation_id uuid REFERENCES organisations(id),   -- listing agent / owner
  source          text NOT NULL,              -- 'agent_feed:reapit', 'user_submitted', 'auction:partnerX'
  source_ref      text,
  licence_terms   text NOT NULL,              -- how we may display/use it
  channel         text NOT NULL CHECK (channel IN ('sale','rent','auction')),
  price           numeric NOT NULL,
  price_qualifier text,                       -- guide, offers over, pcm
  description     text,
  description_embedding vector(1024),
  material_info   jsonb,                      -- NTSELAT parts A/B/C
  status          text NOT NULL DEFAULT 'active',
  listed_at       timestamptz NOT NULL,
  withdrawn_at    timestamptz
);
CREATE INDEX ON listings (channel, status, price);

CREATE TABLE price_events (
  id          bigserial PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES properties(id),
  event       text NOT NULL,                  -- sold, listed, reduced, let
  price       numeric NOT NULL,
  event_date  date NOT NULL,
  source      text NOT NULL,                  -- 'hmlr_ppd', 'listing', ...
  source_ref  text
);
CREATE INDEX ON price_events (property_id, event_date);

CREATE TABLE epc_certificates (
  lmk_key       text PRIMARY KEY,
  property_id   uuid REFERENCES properties(id),
  uprn          bigint,
  current_band  char(1), current_score int,
  potential_band char(1), potential_score int,
  floor_area_m2 numeric,
  construction_age_band text,
  walls_description text, roof_description text, heating_description text,
  lodged_on     date, expires_on date,
  raw           jsonb
);

CREATE TABLE constraint_layers (
  id        bigserial PRIMARY KEY,
  layer     text NOT NULL,                    -- flood_zone_3, conservation_area, article4, listed_building, ...
  attributes jsonb,
  geom      geography(MultiPolygon, 4326) NOT NULL,
  source    text NOT NULL, licence text NOT NULL, as_of date NOT NULL
);
CREATE INDEX ON constraint_layers USING gist (geom);

CREATE TABLE planning_applications (
  id            bigserial PRIMARY KEY,
  lpa_code      text NOT NULL,
  reference     text NOT NULL,
  description   text,
  decision      text, decision_date date,
  location      geography(Point, 4326),
  source        text NOT NULL,
  UNIQUE (lpa_code, reference)
);
CREATE INDEX ON planning_applications USING gist (location);

-- ───────────── Estimating ─────────────
CREATE TABLE rate_libraries (
  version       text PRIMARY KEY,             -- e.g. 'plinth-2027.01'
  basis_date    date NOT NULL,
  status        text NOT NULL CHECK (status IN ('draft','approved','retired')),
  approved_by   uuid REFERENCES users(id),    -- QS reviewer
  notes         text
);

CREATE TABLE rate_items (
  library_version text REFERENCES rate_libraries(version),
  code          text NOT NULL,                -- KITCHEN, REWIRE, ...
  region        text NOT NULL,                -- 'uk' baseline or region key
  spec          text NOT NULL,
  unit          text NOT NULL,
  rate          numeric NOT NULL,
  p10 numeric, p90 numeric,
  observations  int NOT NULL DEFAULT 0,       -- verified observations backing the rate
  PRIMARY KEY (library_version, code, region, spec)
);

CREATE TABLE estimates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  created_by      uuid REFERENCES users(id),
  property_id     uuid REFERENCES properties(id),
  engine_version  text NOT NULL,
  library_version text NOT NULL REFERENCES rate_libraries(version),
  inputs          jsonb NOT NULL,
  result          jsonb NOT NULL,             -- full snapshot for reproducibility
  total_inc_vat   numeric NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cost_observations (
  id              bigserial PRIMARY KEY,
  source_kind     text NOT NULL CHECK (source_kind IN ('quote','invoice','final_account')),
  quote_line_id   uuid,
  code            text NOT NULL,
  region          text NOT NULL,
  spec            text,
  quantity        numeric, unit text,
  amount_ex_vat   numeric NOT NULL,
  observed_on     date NOT NULL,
  verified_by     uuid REFERENCES users(id),
  consent_id      uuid NOT NULL,              -- must reference an explicit data-use consent
  excluded_reason text
);

-- ───────────── Investment ─────────────
CREATE TABLE investment_analyses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  property_id     uuid REFERENCES properties(id),
  strategy        text NOT NULL CHECK (strategy IN ('btl','brrr','flip','hmo','commercial_to_resi','development')),
  engine_version  text NOT NULL,
  tax_table_version text NOT NULL,
  inputs          jsonb NOT NULL,
  result          jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Marketplace ─────────────
CREATE TABLE contractors (
  organisation_id uuid PRIMARY KEY REFERENCES organisations(id),
  companies_house_no text,
  trades          text[] NOT NULL,
  service_area    geography(Polygon, 4326),
  verification_status text NOT NULL DEFAULT 'pending',
  rating          numeric, completed_jobs int DEFAULT 0
);

CREATE TABLE contractor_credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id   uuid NOT NULL REFERENCES contractors(organisation_id),
  kind            text NOT NULL,              -- public_liability, employers_liability, gas_safe, niceic, trustmark, mcs, fensa
  reference       text,
  cover_amount    numeric,
  expires_on      date,
  document_id     uuid,
  verified_at     timestamptz, verified_by uuid REFERENCES users(id)
);

CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),  -- owner
  property_id     uuid REFERENCES properties(id),
  estimate_id     uuid REFERENCES estimates(id),
  status          text NOT NULL DEFAULT 'scoping',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id),
  contractor_id   uuid NOT NULL REFERENCES contractors(organisation_id),
  programme_weeks int,
  total_ex_vat    numeric NOT NULL,
  vat_rate        numeric NOT NULL,
  status          text NOT NULL DEFAULT 'submitted',
  submitted_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quote_lines (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id  uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  code      text NOT NULL,                    -- standard scope code
  description text, quantity numeric, unit text,
  amount_ex_vat numeric NOT NULL
);

CREATE TABLE milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL, share numeric NOT NULL, status text NOT NULL,
  evidence_document_ids uuid[] DEFAULT '{}', released_at timestamptz
);

CREATE TABLE variations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  description text NOT NULL, amount_ex_vat numeric NOT NULL,
  status text NOT NULL DEFAULT 'proposed', decided_by uuid REFERENCES users(id), decided_at timestamptz
);

CREATE TABLE disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  raised_by uuid REFERENCES users(id), stage text NOT NULL DEFAULT 'evidence', -- evidence → mediation → adjudication
  summary text, outcome text, created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Lettings & property management ─────────────
CREATE TABLE tenancies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  property_id     uuid NOT NULL REFERENCES properties(id),
  regime          text NOT NULL,              -- 'eng_assured_periodic', 'wales_occupation_contract', 'scot_prt'
  rent_pcm        numeric NOT NULL,
  start_date      date NOT NULL, end_date date,
  deposit_amount  numeric, deposit_scheme text, deposit_protected_on date,
  last_rent_increase date
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_id uuid REFERENCES tenancies(id),
  name_encrypted bytea NOT NULL, contact_encrypted bytea,
  right_to_rent_checked_on date, right_to_rent_followup_due date
);

CREATE TABLE compliance_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  property_id uuid NOT NULL REFERENCES properties(id),
  kind text NOT NULL,                         -- gas_safety, eicr, epc, alarms, hmo_licence, selective_licence, legionella
  due_on date NOT NULL, completed_on date, document_id uuid
);
CREATE INDEX ON compliance_items (organisation_id, due_on);

CREATE TABLE maintenance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  property_id uuid NOT NULL REFERENCES properties(id),
  reported_by uuid, description text NOT NULL, photos uuid[] DEFAULT '{}',
  ai_triage jsonb,                            -- suggested trade/urgency/confidence (advisory only)
  confirmed_urgency text, confirmed_by uuid REFERENCES users(id),
  assigned_contractor uuid REFERENCES contractors(organisation_id),
  stage text NOT NULL DEFAULT 'reported', created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rent_ledger (
  id bigserial PRIMARY KEY,
  tenancy_id uuid NOT NULL REFERENCES tenancies(id),
  due_on date NOT NULL, amount_due numeric NOT NULL, amount_paid numeric DEFAULT 0, paid_on date, source text
);

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  listing_id uuid REFERENCES listings(id),
  facts jsonb NOT NULL,                       -- affordability ratio, references, RTR status (no protected characteristics)
  status text NOT NULL DEFAULT 'received'
);

CREATE TABLE decisions (                      -- human-in-the-loop decision log (UK GDPR Art. 22)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL, subject_id uuid NOT NULL,
  decision text NOT NULL, reason text NOT NULL,
  decided_by uuid NOT NULL REFERENCES users(id), decided_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Documents & governance ─────────────
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  kind text NOT NULL,                         -- photo, floor_plan, survey, lease, legal_pack, certificate, invoice
  s3_key text NOT NULL, sha256 bytea NOT NULL, uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  model text NOT NULL, fields jsonb NOT NULL,  -- each field: value, confidence, page_ref
  status text NOT NULL DEFAULT 'proposed',     -- proposed → confirmed / rejected by a human
  reviewed_by uuid REFERENCES users(id)
);

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id), organisation_id uuid REFERENCES organisations(id),
  purpose text NOT NULL,                      -- cost_model_training, agent_activity_sharing, marketing
  granted_at timestamptz NOT NULL, withdrawn_at timestamptz
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  organisation_id uuid, actor uuid, action text NOT NULL, subject text, detail jsonb,
  at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Row-level security (example) ─────────────
ALTER TABLE estimates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON estimates
  USING (organisation_id = current_setting('app.org_id')::uuid);
-- Repeat for every organisation-scoped table.
