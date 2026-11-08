# Plinth — Technical Architecture

## 1. Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Web app | **Next.js (App Router) + React + TypeScript** | SSR for SEO on intelligence reports; the prototype in this repo is Vite + React so the screens port directly |
| Mobile | Responsive web first; React Native/Expo later sharing the TS engine package | Avoid two codebases before PMF |
| Calculation engines | **TypeScript package `@plinth/engines`** (pure functions, versioned) | Runs identically in browser, API and widgets; unit-testable (see `src/engine/*.test.ts`) |
| API | Node (Fastify) for product/API gateway; **Python (FastAPI)** services for data ingestion, ML (hedonic models, cost calibration) | Right tool per job |
| Database | **PostgreSQL 16 + PostGIS** (managed: AWS RDS/Aurora, UK region) | Spatial joins (constraints, comps), JSONB for estimate snapshots |
| Search | Postgres + PostGIS for structured filters; **pgvector** for semantic recall of listing text | One less system until scale demands OpenSearch |
| Queue / jobs | SQS + workers (or Temporal for long workflows like conveyancing) | Ingestion, document parsing, notifications |
| Object storage | S3 (eu-west-2), per-tenant prefixes, KMS encryption | Photos, surveys, certificates |
| AI | **Claude (Anthropic API)** for orchestration, tool calling, document understanding; image model API for design concepts | Provider abstraction layer so models can be swapped |
| Maps | **OS Maps API / OS Data Hub** (GB), Mapbox GL for rendering | Licensed, UPRN-aligned |
| Auth | Auth0 / Clerk / AWS Cognito (OIDC), WebAuthn passkeys; API keys + OAuth2 client credentials for B2B | |
| Payments | Stripe Billing (subscriptions + metered usage) | |
| Infra | AWS UK (eu-west-2), Terraform, ECS Fargate → EKS when needed, CloudFront | UK data residency for GDPR comfort |
| Observability | OpenTelemetry → Grafana/Datadog; Sentry | |

## 2. System diagram

```
            ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
 Consumers ─▶ Next.js web  │   │ Partner sites│   │ Partner backends │
            └──────┬───────┘   │ (widgets)    │   │ (REST, webhooks) │
                   │           └──────┬───────┘   └────────┬─────────┘
                   ▼                  ▼                    ▼
            ┌────────────────────────────────────────────────────────┐
            │ API gateway (auth, tenant resolution, rate limit, meter)│
            └──┬───────────────┬────────────────┬──────────────┬─────┘
               ▼               ▼                ▼              ▼
        ┌────────────┐  ┌────────────┐   ┌────────────┐  ┌───────────────┐
        │ Engines    │  │ AI orchestr.│  │ Marketplace│  │ Lettings / PM │
        │ (TS, pure) │◀─┤ (tool-call) │  │ quotes/jobs│  │ compliance    │
        └─────┬──────┘  └─────┬──────┘   └─────┬──────┘  └──────┬────────┘
              ▼               ▼                ▼                ▼
        ┌─────────────────────────────────────────────────────────────┐
        │ PostgreSQL + PostGIS + pgvector  ·  S3  ·  Rate library store│
        └──────────────────────────▲──────────────────────────────────┘
                                   │
        ┌──────────────────────────┴──────────────────────────────────┐
        │ Ingestion (Python): Land Registry PPD, EPC, EA flood, HE    │
        │ listed, planning.data.gov.uk, ONS/UK HPI, OS, agent feeds   │
        └─────────────────────────────────────────────────────────────┘
```

## 3. Separating AI from deterministic calculation

```
User text ──▶ LLM (tool calling, JSON-schema output) ──▶ validated SearchQuery / RefurbInput
                                                          │
                                   deterministic engine ◀─┘  (versioned rate tables, tax tables)
                                                          │
           LLM explanation ◀── engine result + provenance ┘  (LLM may only cite numbers it is given)
```

Rules enforced in code:

* LLM tools are `search_properties`, `estimate_refurbishment`, `analyse_investment`, `get_constraints`, `get_comparables` — each returns structured data with `source`, `as_of`, `version`.
* The response renderer checks that every currency figure in the assistant's text appears in the tool results for that turn (numeric grounding check); otherwise the message is regenerated or numbers are stripped.
* Every stored estimate snapshots `engine_version`, `rate_library_version`, `tax_table_version` and inputs → reproducible forever.
* Document extraction (surveys, leases, legal packs) produces **proposed** fields with confidence and page references; the user confirms before they change an estimate.

## 4. Pricing data loop (the moat)

1. Plinth issues a standard scope/BoQ (codes like `KITCHEN`, `REWIRE`).
2. Contractors quote line-by-line against those codes (structured, not PDF).
3. On completion, invoices and variations are attached; owner confirms.
4. With consent, line items are normalised (region, spec, date via BCIS-style indices or our own index) and stored in `cost_observations`.
5. A Bayesian hierarchical model (trade × region × spec × era) updates rates; a QS reviews any rate change > ±7% before publishing a new `rate_library_version`.
6. Estimates show which library version and how many verified observations back each rate ("based on 46 verified quotes in Outer London, last 12 months").

## 5. Database schema

Full DDL: [`db/schema.sql`](../db/schema.sql). Core entities:

* **Tenancy & identity**: `organisations` (tenant), `users`, `memberships(role)`, `api_keys`, `usage_events`.
* **Property graph**: `properties` (UPRN-keyed, PostGIS point), `listings` (source, licence, status), `price_events`, `epc_certificates`, `constraints` (spatial layers cached per UPRN), `planning_applications`.
* **Estimating**: `rate_libraries`, `rate_items`, `estimates` (inputs + snapshot JSONB), `estimate_lines`, `cost_observations`.
* **Investment**: `investment_analyses` (inputs/outputs JSONB + versions).
* **Marketplace**: `contractors`, `contractor_credentials`, `projects`, `scopes`, `quotes`, `quote_lines`, `milestones`, `variations`, `disputes`.
* **Lettings**: `tenancies`, `tenants`, `compliance_items`, `maintenance_requests`, `rent_ledger`, `applications`, `decisions` (human decision log).
* **Documents**: `documents`, `document_extractions`.
* **Governance**: `consents`, `audit_log`.

Multi-tenancy: shared schema with `organisation_id` on every tenant-owned row and **Postgres Row-Level Security** policies keyed on `current_setting('app.org_id')`. Enterprise tenants can be moved to a dedicated database (same schema) if contracts require it.

## 6. API architecture

* REST, resource-oriented, `/v1/...`, OpenAPI 3.1 as source of truth, generated TS/Python SDKs.
* Idempotency keys on POST; cursor pagination; ETags on reports.
* Webhooks (signed, retried with backoff): `estimate.completed`, `quote.received`, `compliance.due`, `listing.matched`.
* Widgets: a small JS loader that renders in a shadow DOM / iframe, using a **publishable key** restricted by allowed origins; all calculation server-side for metering.
* Metering: every billable call writes a `usage_event` (org, endpoint, units) → aggregated hourly to Stripe metered billing.
* Rate limits per key (token bucket in Redis); per-plan quotas.

Example endpoints are listed (and live-demoed with the real engine) on `/developers` in the prototype.

## 7. Authentication & roles

| Actor | Auth | Notes |
|---|---|---|
| Consumers | OIDC (email magic link, Google/Apple, passkeys) | |
| Org staff (agents, landlords, contractors) | OIDC + org membership; SSO (SAML) for enterprise | MFA mandatory for admin roles |
| Machine (partners) | Secret API keys (server), publishable keys (widgets), OAuth2 client credentials for enterprise | Keys hashed at rest, scoped, rotatable |

Roles: `consumer`, `investor`, `landlord`, `agent_admin`, `agent_negotiator`, `property_manager`, `contractor_admin`, `contractor_estimator`, `developer` (API), `qs_reviewer` (internal), `trust_safety` (internal), `platform_admin`. Permissions are capability-based (`estimate:create`, `tenancy:decide`, …) mapped from roles.

## 8. Data ingestion (legitimate sources only)

| Source | Licence | Use |
|---|---|---|
| HM Land Registry Price Paid, UK HPI | OGL | Sold comps, area trends |
| EPC register (England & Wales), Scottish EPC | OGL/terms | Floor area, EPC, construction age |
| Environment Agency flood maps, NRW, SEPA | OGL | Flood risk |
| Historic England / Cadw / HES listed buildings; conservation areas | OGL | Constraints |
| planning.data.gov.uk; LPA portals | OGL / per-LPA terms | Planning history, Article 4 |
| BGS GeoSure | **Licensed** | Subsidence — paid |
| OS AddressBase / OS Maps | **Licensed** (PSGA free tier for some) | UPRN, mapping |
| Ofsted / Estyn / Education Scotland | OGL | Schools |
| TfL Unified API, NaPTAN, BODS | Open | Commute |
| police.uk | OGL | Crime |
| Agent CRM feeds (Reapit, Alto, Street, Jupix) | Per-agent consent + partner agreements | Listings |
| Auction houses | Partnership | Auction lots & legal packs |
| Rental data (e.g. ONS PIPR, partner agents) | OGL / commercial | Rent estimates |

Pipeline: Python jobs (Prefect/Airflow) → raw S3 → validated staging → Postgres, with lineage (`source`, `retrieved_at`, `licence`) on every row. **No portal scraping.**

## 9. Security, GDPR & compliance

* UK GDPR / DPA 2018: ICO registration, DPIA for tenant screening and document AI, records of processing, DSAR tooling, retention schedules per data class.
* Special-category and protected-characteristic data is not collected for screening; Art. 22 safeguards — no solely automated decisions with legal effect.
* Encryption in transit (TLS 1.2+) and at rest (KMS); field-level encryption for ID documents; least-privilege IAM.
* AI processing: zero-retention API terms with model providers; PII redaction before prompts where feasible; prompts and outputs logged for audit (with retention limits).
* Cyber Essentials Plus in year 1; ISO 27001 before enterprise/lender deals.
* Regulated activities via partners: FCA-authorised payments/escrow, mortgage brokers, RICS valuers, referencing agencies.

## 10. Deployment strategy

* Environments: `dev` (per-PR previews), `staging` (anonymised data), `prod` (eu-west-2, multi-AZ).
* CI: typecheck, unit tests (engine golden tests incl. HMRC worked examples), contract tests against OpenAPI, Playwright smoke tests.
* Engine/rate/tax tables released as versioned artefacts with change notes and QS sign-off; old versions remain callable for reproducibility.
* Blue/green deploys, feature flags (per tenant), database migrations via expand/contract.
* Targets: 99.9% API availability (99.95% enterprise), p95 < 300ms for estimates.

## 11. What is real in this prototype

| Area | Status |
|---|---|
| Refurb engine, BoQ export, scenarios, quote comparison | Real deterministic code, unit tested, **demo rate library** |
| SDLT / LTT / LBTT + ADS | Real, unit tested against worked examples; rates as configured Nov 2026 — verify before reliance |
| Investment maths (BTL/BRRR/flip/HMO, ICR, sensitivity) | Real, unit tested |
| NL search | Rule-based interpreter emitting the same structured query an LLM would; real ranking |
| Listings, comparables, constraints, landlord/agent/contractor data | **Fictional demo data** |
| Survey extraction | In-browser keyword extraction (stand-in for document AI) |
| Design studio | Illustrative SVG + colour-grade preview (image model not connected) |
| Maps | Schematic SVG (no tile provider) |
