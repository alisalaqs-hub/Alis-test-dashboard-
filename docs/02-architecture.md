# BRIXO — Technical Architecture

## 1. Stack

| Layer | Choice | Notes |
|---|---|---|
| Web | **Next.js (App Router) + React + TypeScript**; Tailwind CSS with BRIXO tokens | This prototype is Vite + React + plain CSS tokens; screens port directly. SSR for SEO on listing/intelligence pages. |
| Engines | `@brixo/engines` — pure TypeScript, versioned, unit-tested | Same code in browser, API, widgets, agents (see `src/engine/*`). |
| API | Node (Fastify) gateway + domain services; **Python (FastAPI)** for ingestion, ML (hedonic valuation, cost calibration, demand models) | |
| Data | **PostgreSQL 16 + PostGIS + pgvector**; ClickHouse (or BigQuery) for event analytics | Postgres for truth; columnar store for engagement aggregates. |
| Events | First-party collector → Kafka/Kinesis → stream aggregation (Flink or dbt incremental) → aggregates in Postgres | Raw events retained ≤ 13 months; dashboards read aggregates only. |
| Jobs / agents | **Temporal** workflows for agents, reports, ingestion | Durable, retryable, auditable. |
| AI | Claude via Anthropic API for tool-calling orchestration, document understanding and explanation; an image model API for design concepts (structure-preserving editing) | Provider-abstracted; zero-retention terms. |
| Search | Postgres filters + PostGIS + pgvector (semantic recall on descriptions) | OpenSearch only when scale demands. |
| Maps | OS Data Hub (UPRN, maps) + Mapbox GL rendering | Licensed. |
| Auth | OIDC (passkeys, magic link, Google/Apple); SAML SSO for enterprise; API keys + OAuth2 client credentials | |
| Billing | Stripe Billing (subscriptions + metered usage) | |
| Infra | AWS eu-west-2 (London), Terraform, ECS Fargate → EKS; CloudFront | UK data residency. |
| Observability | OpenTelemetry → Grafana/Datadog; Sentry; LLM tracing (prompt/tool/latency/cost) | |

## 2. Separation of concerns: AI vs deterministic vs verified

```
User question
   │
   ▼
LLM orchestrator ──selects──► Skills / tools (deterministic engines, data queries)
   │                                   │  each result carries: value, source, as_of, version
   │◄────────── structured results ────┘
   ▼
LLM writes explanation  ──►  Grounding check (every £/%/count must appear in tool output)
   │                              │ fail → regenerate or strip figures
   ▼                              ▼
Answer = { text, evidence[], assumptions[], verify[], confidence, tools[] }
```

* Prototype: `src/ai/assistant.ts` (`route`, `ungroundedFigures`), skills in `src/ai/skills.ts` and `src/ai/landlordSkills.ts`.
* Every stored estimate/analysis snapshots inputs + `engine_version` + `rate_library_version` + `tax_table_version`.
* Verified data (licensed feeds, contractor-confirmed invoices) is flagged at row level and never silently blended with estimates.

## 3. Engagement analytics architecture (Parts 3–5)

**Collection (PECR + UK GDPR):**
* Non-essential tracking only after opt-in consent (prototype: `src/engine/tracking.ts`; consent control on each listing page).
* Events: `listing_view, photo_enlarge, floorplan_open, save, compare_add, viewing_request, enquiry, ai_question(topic), refurb_sim, design_style, document_open` with random session id; no name/email/IP in the event stream.
* Lawful basis: consent for analytics cookies/storage; legitimate interests for aggregated reporting to the listing's owner/agent (with LIA and DPIA). Privacy notice explains owner-facing aggregates.

**Processing:**
* Stream aggregation to daily `listing_engagement_daily` and segment tables.
* **k-anonymity (k ≥ 10)** on any segment shown to owners/agents (e.g. style explored, question topic, budget band). Owners see their own listing totals; never individual visitors or question text.
* Statistics: Wilson intervals for rates; comparisons only claimed when intervals don't overlap; trend claims need minimum sample sizes (`src/engine/engagement.ts`).
* Insight typing: `observed` (counts), `inferred` (interpretation with caveat), `recommendation` (suggested action) — each with evidence and confidence.

**Benchmarks:** comparable-listing sets by area/type/price band, computed nightly.

## 4. Property knowledge graph (Part 13)

Implemented relationally (Postgres) with an edge table, not a separate graph DB, until query patterns demand one.

* **Nodes:** property (UPRN), listing, owner, agent/organisation, landlord, document, planning application, constraint layer, comparable sale/let, estimate, design, quote, contractor, maintenance job, tenancy, investment model, transaction milestone, engagement aggregate.
* **Edges:** typed (`has_listing`, `comparable_of`, `within_constraint`, `estimated_by`, `designed_for`, `quoted_against`, `maintained_by`, …) with `source`, `confidence`, `valid_from/to`, `visibility`.
* **Access control:** every node/edge carries a visibility class — `public`, `verified`, `owner/agent`, `aggregated`, `private` — enforced by Postgres row-level security keyed on `app.org_id` / `app.user_id`. The AI orchestrator queries through the same RLS-enforced views, so it can never retrieve data the user couldn't see.
* Visualised per property in the prototype (`src/components/KnowledgeGraph.tsx`).

## 5. Multi-agent system (Part 12)

* Agents: buyer, seller, estate agent, landlord, investor, developer, contractor, property manager (`src/ai/agents.ts`).
* Each agent = role + **explicit permission scopes** + schedule + tools. Least privilege: no agent reads individual visitor or tenant personal data.
* Actions are classed: *non-consequential* (generate a report, run an estimate) may complete automatically; *consequential* (publish listing changes, message a person, book, spend, alter tenancy records) go to an **approval queue** and need a named human approver.
* **Audit log** (append-only, hash-chained in production) records every tool call, proposal and decision; supports replay. Kill switch and per-agent rate limits.
* Production runtime: Temporal workflow per agent run; LLM plans tool calls within scope; outputs pass the grounding check.

## 6. Design studio pipeline (Part 6)

1. Upload photo → EXIF stripped, faces/plates blurred, stored per user.
2. Segmentation + depth/edge maps → image model generates concept **conditioned on structure** (keeps walls, windows, proportions).
3. Concept spec (style, tier, finishes) → `designCost()` → material & labour schedule → optional quote request / investment hand-off.
4. Outputs watermarked: "AI concept" and, for staged marketing images, "Virtually staged" (non-removable in exported marketing assets).

## 7. Data ingestion (legitimate sources only)

| Source | Licence | Use |
|---|---|---|
| HM Land Registry Price Paid, UK HPI | OGL | Comparables, trends |
| EPC registers (E&W, Scotland) | OGL / terms | Floor area, fabric, energy |
| EA / NRW / SEPA flood | OGL | Risk |
| Historic England / Cadw / HES; conservation areas; Article 4 | OGL / LPA | Constraints |
| planning.data.gov.uk + LPA portals | OGL / LPA terms | Planning history & pipeline |
| BGS GeoSure | Licensed | Subsidence |
| OS AddressBase / Maps | Licensed (PSGA thresholds) | UPRN, mapping |
| Ofsted / Estyn / Education Scotland; TfL, NaPTAN, BODS; police.uk | Open | Schools, transport, crime |
| ONS private rents / PIPR | OGL | Rental context |
| Agent CRMs (Reapit, Alto, Street, Jupix), auction houses | Partner agreements + agent consent | Listings |
| Contractor quotes, invoices | User consent | Cost calibration |

**No portal scraping.** Every row stores `source`, `retrieved_at`, `licence`.

## 8. Security & compliance

* UK GDPR / DPA 2018: ICO registration; DPIAs for engagement analytics, document AI, tenant workflows; RoPA; DSAR & deletion tooling; retention schedules.
* PECR: consent for non-essential storage/tracking; marketing consent separate.
* Art. 22: no solely automated decisions with legal/similarly significant effect (tenant eligibility, credit). Human decision log (`decisions` table).
* Consumer protection (DMCC Act 2024 / CPRs, NTSELAT material information): virtual staging labelled; material information from verified fields only.
* Security: TLS 1.2+, KMS encryption, field-level encryption for ID/tenant data, least-privilege IAM, WAF, secrets in AWS Secrets Manager; Cyber Essentials Plus → ISO 27001 → SOC 2 Type II for enterprise.
* Regulated activities via partners (FCA payments/escrow, mortgage brokers, RICS valuers, referencing agencies).

## 9. API & multi-tenancy

* REST `/v1`, OpenAPI 3.1, SDKs; idempotency keys; cursor pagination; signed webhooks.
* Tenants = organisations; RLS on every tenant-owned table; enterprise option for dedicated database.
* Keys: secret (server), publishable (widgets, origin-restricted), OAuth2 client credentials; scopes per endpoint.
* Metering: `usage_events` → hourly aggregation → Stripe metered billing.
* Widgets: JS loader rendering into shadow DOM/iframe with tenant theme (colours, fonts, logo), server-side calculation.

## 10. Deployment & reliability

* Environments: preview (per PR), staging (anonymised data), production (multi-AZ).
* CI: typecheck, unit tests (engines incl. HMRC worked examples), contract tests (OpenAPI), Playwright smoke tests, LLM eval suite (grounding, refusal, routing accuracy).
* Versioned releases of rate libraries and tax tables with QS / tax-specialist sign-off.
* Targets: 99.9% (99.95% enterprise); p95 < 300 ms for engine endpoints; LLM answers < 4 s p95.

## 11. What is real in this prototype

| Area | Status |
|---|---|
| Refurb, design-to-cost, tax (resi + non-resi), investment, valuation scenarios, development screening, residual appraisal, engagement statistics, reports | Deterministic code, **41 unit tests** |
| AI assistants | Pattern-routed skills over engines (no LLM call) |
| AI agents | Deterministic runs; approval queue & audit log in browser storage |
| Engagement data | **Simulated** (seeded) — no real users; client-side consent-gated tracking demo only |
| Listings, comparables, market inputs, portfolio | **Fictional demonstration data** |
| Images, maps | Illustrations / schematic SVG; no image model or tile provider connected |
| Backend, auth, API server, billing | Designed, not implemented |
