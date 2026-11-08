# Plinth — Go-to-Market & 90-Day MVP Plan

## 1. Phased launch

Team cost assumes a blended UK fully loaded cost of ~£110k/engineer/yr.

### Phase 1 — Estimator + investment underwriter (months 0–6)
* **Build:** refurb engine with QS-reviewed rate library, investment underwriter, intelligence report (OGL data), accounts, Stripe, BoQ export, manual quote upload & comparison.
* **Effort:** 4 engineers, 1 designer, 1 part-time QS, founder-PM ≈ 30 person-months.
* **Operating cost:** ~£55k/month (team) + £3k/month infra/data/AI.
* **Dependencies:** QS to validate rates against ≥300 real quotes (sourced from friendly contractors/investors); OGL ingestion; legal review of disclaimers.
* **Risks:** estimates perceived as inaccurate → credibility loss. Mitigate with ranges, confidence, "based on N quotes", and a "challenge this estimate" button feeding calibration.
* **Revenue:** Investor Pro, one-off reports. Target £15k MRR by month 6.
* **Success metrics:** 20k estimates run; 1,000 paying; estimate within ±15% of accepted quote on 70% of tracked projects; NPS > 45.

### Phase 2 — Discovery, alerts, contractor quotes (months 6–12)
* **Build:** NL search via LLM tool-calling over agent/auction feeds and user-submitted listings; saved searches/alerts; survey & legal-pack interpreter; contractor onboarding, verification and structured quoting; Land Registry/EPC/flood/planning layers.
* **Effort:** 7 engineers + data engineer + T&S lead ≈ 50 person-months.
* **Operating cost:** ~£95k/month + £10–15k/month data/infra.
* **Dependencies:** 2–3 auction houses and 30+ agent branches supplying feeds; contractor verification process.
* **Risks:** thin listing supply → search feels empty. Mitigate: position search as "deal finder across partners + paste any listing URL/details for analysis".
* **Revenue:** contractor subs + success fees; Portfolio tier. Target £80k MRR.
* **Metrics:** 300 active contractors in 3 launch regions; 25% of estimates convert to a quote request; ≥2,000 verified quote lines/month.

### Phase 3 — Agents, lettings, portfolios (months 12–24)
* **Build:** agent portal with CRM sync (start with one CRM partner), listing intelligence widget, lead intent; landlord management & compliance (England first, Renters' Rights Act), maintenance triage, conveyancing tracker.
* **Effort:** 12–15 engineers across 3 squads.
* **Operating cost:** ~£200k/month.
* **Dependencies:** CRM partnership, deposit scheme & open-banking providers, regulatory counsel.
* **Risks:** crowded lettings software market; long agent sales cycles. Mitigate: lead with the free listing intelligence widget, upsell.
* **Revenue:** agent SaaS, landlord per-unit. Target £400k MRR by month 24.
* **Metrics:** 250 branches; 25k units; agent listings with reports get ≥30% more qualified enquiries.

### Phase 4 — White-label API & enterprise (months 18–30, overlapping)
* **Build:** public API GA, widgets, developer console, SLAs, SOC2/ISO 27001, dedicated tenancy options.
* **Effort:** platform squad of 5 + solutions engineers.
* **Dependencies:** security certification; first lender/portal design partner.
* **Risks:** enterprise sales cycles of 6–12 months; procurement demands. Mitigate with paid pilots.
* **Revenue:** usage + enterprise licences. Target 20 API customers, 3 enterprise.
* **Metrics:** API gross retention > 95%; p95 latency < 300ms; 99.9% uptime.

### Phase 5 — National coverage & international (months 30+)
* **Build:** Wales/Scotland/NI rule-sets complete (tax, tenancy law, building standards), regional calibration everywhere; assess Ireland (similar housing stock, separate tax/regs), then Australia/Canada (English-speaking, investor culture, refurb-heavy markets).
* **Risks:** re-calibration cost per market; data licensing differs. Enter only with a local partner and ≥1 anchor enterprise customer.
* **Metrics:** each region estimate accuracy within ±15% on 70% of projects before marketing spend.

## 2. Customer acquisition strategy (UK)

1. **Investor community first** — property-investor podcasts, YouTube educators, meetups (property networking events), and forums. Offer educators white-labelled calculators and affiliate revenue. Expected CAC £40–£90.
2. **SEO on intent pages** — programmatic, genuinely useful pages: "Cost to refurbish a Victorian terrace in Leeds", "Loft conversion cost in E17", "SDLT on a £450k second home". Each page runs the engine live with stated assumptions.
3. **Shareable reports** — every report has a "shared by" link; agents attach to listings.
4. **Agent channel** — free listing-intelligence widget for 3 months for the first 100 branches in launch regions (London E/NE, Greater Manchester, West Yorkshire).
5. **Contractor-led growth** — contractors invite their own clients to receive quotes through Plinth (they get a verified badge and professional BoQ).
6. **Partnerships** — mortgage brokers (BTL specialists), bridging lenders, auction houses (legal-pack analysis), retrofit installers.
7. **PR with data** — quarterly "UK Refurbishment Cost Index" from verified data; journalists love regional cost stories.

Launch regions are chosen for investor density + refurb-heavy stock + contractor supply: **North-East London, Greater Manchester, Leeds/Bradford**, then Bristol, Birmingham, Liverpool.

## 3. 90-day MVP development plan

Team: founder/PM, 3 full-stack engineers, 1 data engineer (from week 3), 1 product designer, part-time QS (2 days/week), legal counsel (as needed).

### Days 1–30 — Foundations & engine credibility
| Week | Deliverables |
|---|---|
| 1 | Repo, CI, Next.js app shell from this prototype; `@plinth/engines` package extracted with current tests; design system tokens. |
| 2 | QS workshop: agree trade codes, units, quantity rules; collect 150+ real quotes/invoices from 10 friendly contractors & investors (with written consent). |
| 3 | Rate library v0.2 calibrated; region/era/condition factors reviewed; golden test cases (20 real projects). Auth (passkeys + magic link), organisations, saved estimates in Postgres. |
| 4 | Estimator UX polish, PDF/CSV BoQ export, Stripe checkout for Investor Pro. Private alpha with 30 investors. |

**Exit criteria:** median absolute error ≤ 18% vs 20 held-out real projects; 30 alpha users ran ≥3 estimates each.

### Days 31–60 — Investment + intelligence report
| Week | Deliverables |
|---|---|
| 5 | Investment underwriter in production; tax tables as versioned config with HMRC/WRA/RS worked examples in tests. |
| 6 | Ingest Land Registry Price Paid, EPC, EA flood, conservation areas, listed buildings, Article 4 (where published) for 3 launch regions; UPRN matching. |
| 7 | Intelligence report v1 (enter any address/postcode + basic details → report); shareable links; SEO cost pages (first 200). |
| 8 | LLM layer v1: survey/legal-pack extraction to *proposed* scope with human confirmation; grounded explanations with numeric-grounding check. |

**Exit criteria:** 300 beta users, 50 paying; report generated in < 5s; zero ungrounded numbers in a 500-message eval set.

### Days 61–90 — Quotes, launch, learn
| Week | Deliverables |
|---|---|
| 9 | Contractor onboarding (Companies House check, insurance upload with expiry), structured quote submission against BoQ codes. |
| 10 | Quote comparison + anomaly flags; consent-gated capture into `cost_observations`; QS review queue. |
| 11 | Conversational search over user-pasted listings + 1 auction partner feed; alerts on saved underwriting criteria. |
| 12 | Public launch in 3 regions; analytics dashboards (activation, estimate→quote conversion, accuracy tracking); investor update & seed narrative. |

**Day-90 targets:** 5,000 registered users · 400 paying (≈£10k MRR) · 60 verified contractors · 1,500 verified quote lines · estimate accuracy ±15% on 65% of tracked jobs · 2 agent/broker design partners signed.

### Key risks to watch in the first 90 days
* **Calibration data scarcity** → pay contractors/QS for historical quotes; offer free BoQs to contractors in return for consented data.
* **Over-promising AI** → keep the AI surface small and grounded; publish the methodology.
* **Regulatory creep** → legal review of every feature that touches advice, tenant decisions or money movement.
