# STREETKEY — Development Roadmap, Go-to-Market & Next Steps

Costs assume a blended UK fully loaded rate of ~£110k per engineer-year (~£9.2k/month), designers/PM similar, part-time specialists by day rate. "Indicative development cost" = people + infrastructure/data/AI for the phase.

## Phase 1 — Core MVP (months 0–6)
**AI property intelligence · refurbishment calculator · interior design studio · investment analysis**

| | |
|---|---|
| Priorities | Extract `@streetkey/engines`; QS-calibrated rate library v1 (≥300 real quotes); intelligence report for any address (OGL data: Land Registry, EPC, flood, conservation, planning); design studio with a real structure-preserving image model; investment analyser; accounts, saved work, Stripe |
| Resources | 4 full-stack engineers, 1 ML/AI engineer, 1 product designer, founder-PM, QS 2 days/week, legal/privacy counsel ad hoc |
| Dependencies | Image-model API terms (commercial use, no training on uploads); OS Data Hub; consented quote data from 10–20 contractors/investors |
| Technical risks | Estimate accuracy credibility; image models altering room structure; LLM grounding failures |
| Mitigations | Ranges + confidence + "based on N quotes"; structure-conditioning + human-visible "concept" labels; grounding check + eval suite (≥500 Qs) in CI |
| Commercial opportunities | Investor Pro, £19 reports, Design subscription |
| Success metrics | 25k estimates; 1,500 paying users; 70% of tracked jobs within ±15% of accepted quote; 0 ungrounded figures in eval; NPS > 45 |
| Indicative cost | **£520k–£620k** (people ~£470k; infra/data/AI ~£40k; legal/QS ~£50k) |

## Phase 2 — Property marketplace (months 6–12)
**Listings · AI search · property profiles · owner dashboards · engagement analytics**

| | |
|---|---|
| Priorities | Listing ingestion (owner-submitted + 2–3 CRM integrations + auction partners); LLM tool-calling search; consented event collector, stream aggregation, k-anonymity, owner dashboard & weekly reports; viewings & enquiries |
| Resources | +3 engineers (data/platform), data engineer, trust & safety/privacy lead |
| Dependencies | Agent CRM partnerships; DPIA & LIA sign-off; CMP (consent platform) |
| Technical risks | Thin listing supply; event volume/cost; misleading statistics |
| Mitigations | "Analyse any listing" mode (paste details/address); columnar store; statistical guardrails & minimum samples in code |
| Commercial | Owner reports, early Agent Pro, Staging |
| Metrics | 3,000 live listings in 3 launch regions; ≥60% analytics opt-in; owners opening weekly report ≥55%; listing → enquiry conversion lift on STREETKEY-intelligence listings vs control |
| Indicative cost | **£750k–£900k** |

## Phase 3 — Professional tools (months 12–20)
**Agent command centre · landlord management · contractor integrations**

| | |
|---|---|
| Priorities | Agent command centre GA with approvals & audit; Renters' Rights Act-ready lettings (England) then Wales/Scotland modules; contractor verification (Companies House, insurance OCR, Gas Safe/NICEIC), structured quoting, milestone payments via FCA-authorised partner |
| Resources | 12–15 engineers in 3 squads, 2 designers, sales & onboarding team (4) |
| Dependencies | Payments/escrow partner; deposit scheme & open-banking providers; regulatory counsel |
| Technical risks | CRM integration variance; regulatory change in lettings |
| Commercial | Agent Command (£349), landlord per-unit, contractor subs + success fees |
| Metrics | 300 branches; 25k units; 1,200 contractors; ≥2,000 verified quote lines/month; agent gross retention ≥ 90% |
| Indicative cost | **£1.6m–£1.9m** |

## Phase 4 — AI automation (months 18–28)
**Role agents · automated reporting · predictive intelligence · advanced workflows**

| | |
|---|---|
| Priorities | Temporal-based agent runtime, LLM planning within permission scopes, approval UX on mobile, hash-chained audit; predictive maintenance from verified records; price-reduction & time-to-sell models; demand models for developers (trained only once sufficient outcome data exists) |
| Resources | AI/ML squad (4), platform (3), evaluation & safety engineer |
| Dependencies | ≥12 months of outcome data; model governance policy |
| Technical risks | Agent over-reach; model drift; evaluation of predictions |
| Mitigations | Least-privilege scopes, consequential-action gating, offline back-tests with published calibration, kill switch |
| Commercial | Premium tiers; automation add-ons |
| Metrics | ≥40% of agent seller reports generated automatically and approved with minor edits; prediction calibration within ±10% on hold-out |
| Indicative cost | **£1.2m–£1.5m** |

## Phase 5 — Enterprise expansion (months 24–36)
**White-label · API licensing · partnerships**

| | |
|---|---|
| Priorities | Public API GA, SDKs, widgets, tenant theming, SSO/SAML, dedicated tenancy, ISO 27001 + SOC 2; lender and portal partnerships; Ireland market assessment |
| Resources | Platform squad (5), solutions engineers (3), enterprise sales (3), security/compliance lead |
| Dependencies | Security certifications; 1–2 design-partner enterprises |
| Risks | 6–12 month sales cycles; procurement |
| Commercial | Enterprise £50k–£250k+/yr; API usage; white-label |
| Metrics | 20 API customers, 3–5 enterprise; API gross retention ≥ 95%; 99.95% uptime |
| Indicative cost | **£1.5m–£2.0m** |

**Cumulative indicative investment to Phase 5: ~£5.5m–£7m**, consistent with a seed (£1.5–2m) → Series A (£6–10m) path.

## Go-to-market (UK)

1. **Launch regions:** North-East London (E10/E17/E4), Croydon, Watford/Herts, Greater Manchester, Leeds — investor density, refurb-heavy stock, contractor supply.
2. **Agents first for supply and distribution:** free 90-day Agent Pro for 100 branches in launch regions in return for listing feeds and weekly-report usage; the owner dashboard becomes their pitch tool.
3. **Investor community:** educators, podcasts, meetups — affiliate white-label calculators.
4. **SEO with live engines:** "cost to refurbish a Victorian terrace in Leeds", "loft conversion cost E17", "SDLT on £450k second home" — each page runs the real engine with assumptions shown.
5. **Contractor-led growth:** contractors invite their clients to receive scoped quotes via STREETKEY.
6. **Data PR:** quarterly STREETKEY Refurbishment Cost Index from verified quotes.

## Done (November 2026)

* **Back end:** accounts, listings with photos, enquiries, saved searches and alerts, agent BLM feeds, admin, trust & safety, UK GDPR export and erasure, on Netlify Functions + PostgreSQL (see [08](08-backend.md)).
* **AI across the site** on OpenAI, grounded in the engines: assistant with tools, conversational search, listing tools, inbox screening and triage, trust review, photo-real room redesign, estimates from photos, investment verdicts, dashboard briefings. Cost controls (site budget with a safety reserve, per-person caps, automatic pause when out of credit) and a fake OpenAI for testing.
* **Official data:** real sold prices and the House Price Index (HM Land Registry), flood risk and live warnings (Environment Agency) and energy certificates (EPC register) on the Sold prices page, real listing pages, the listing form and the assistant, cached in the database with the licences' attribution.
* **Quality pass:** an end-to-end and adversarial review found about 180 issues across security, cost, accessibility and correctness; all confirmed ones were fixed and re-checked.

## Next implementation steps (next 6 weeks)

1. **Go live:** deploy from GitHub to Netlify, add Netlify Database (London or Frankfurt, functions in the same region), set `OPENAI_API_KEY` with credit and a monthly limit, `ADMIN_EMAIL`, Resend and the domain. Remove the preview label only after the checklist in [07](07-going-live.md).
2. **Data foundations, next layer:** add the EPC token; match sold prices to EPC floor areas (price per m²) and feed real evidence into the valuation, rent and deal-score models for real listings; add Ofsted, journey times and planning data.
3. **Real listing supply:** sign the first agent feed agreements (per-branch keys are ready); invite private sellers in one launch area.
4. **Verified owner:** identity check (certified IDSP) and HM Land Registry title match before the "Verified owner" badge.
5. **Payments:** Stripe for listing upgrades, agency subscriptions and API plans.
6. **AI evaluation:** a fixed question set for the assistant and search (grounding, refusal, routing accuracy) run against the live models before each model change; review `ai_usage` costs weekly.
7. **QS calibration sprint:** collect ≥300 consented quote lines; publish `streetkey-rates-2027.01` with sign-off.
8. **Design-partner programme:** 5 agents, 20 investors, 10 contractors using the live site weekly; measure estimate accuracy and report usefulness.
