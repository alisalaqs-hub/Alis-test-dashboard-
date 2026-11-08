# Plinth — Commercial Model

All figures are planning assumptions, not forecasts. They should be pressure-tested in customer interviews before fundraising.

## 1. Revenue streams & pricing

| Stream | Package | Price (ex VAT) | Notes |
|---|---|---|---|
| **Consumer – free** | Free | £0 | 3 saved estimates, basic report, search. Acquisition engine & data capture. |
| **Investor Pro** | Monthly | £29/mo or £290/yr | Unlimited estimates/underwriting, BoQ export, alerts, survey & legal-pack interpreter (fair use). |
| **Investor Portfolio** | Monthly | £79/mo | Up to 25 properties, portfolio analytics, refinance alerts, team seat. |
| **One-off report** | Per property | £19 | For homeowners/FTBs who won't subscribe. |
| **Landlord management** | Per unit | £3/unit/mo (min £15) | Compliance autopilot, maintenance, rent tracking. Letting agents: £1.50/unit at volume. |
| **Agent SaaS** | Per branch | £149/branch/mo (Pro), £299 (Plus incl. widget + lead scoring) | Intelligence on listings, pitch packs, lead intent. |
| **Contractor** | Subscription + success fee | £39–£79/mo + 2–3% of awarded contract value (capped) | Qualified, scoped leads; verified-pricing badge. Avoid pay-per-lead (misaligned incentives). |
| **API – usage** | Developer / Growth / Scale | £0 sandbox; £499/mo + metered; £2k+/mo commits | £0.02–£0.60 per call (see `/developers`). |
| **Enterprise licence** | Annual | £50k–£250k+/yr | Lenders, portals, build-to-rent operators, insurers: SLA, dedicated tenancy, bulk data. |
| **Partnerships** | Referral / rev share | Mortgage broker, conveyancing, insurance, retrofit installers | Regulated partners pay referral fees; disclose clearly. |

## 2. Unit economics assumptions (Year 2 steady state)

| Segment | ARPA / yr | Gross margin | CAC | Payback | Annual churn |
|---|---|---|---|---|---|
| Investor Pro | £300 | 85% | £60–£110 | 3–5 months | 35% |
| Landlord (8 units avg) | £290 | 88% | £120 | 6 months | 18% |
| Agent branch | £2,100 | 85% | £900–£1,500 (sales-led) | 6–10 months | 15% |
| Contractor | £1,600 (sub + fees) | 80% | £250 | 2–3 months | 30% |
| API Growth | £9,000 | 75% (LLM + data costs) | £3,000 | 4–5 months | 10% |
| Enterprise | £120,000 | 70% | £30,000 | 4 months | 5% |

**Gross margin drivers:** LLM inference (budget £0.01–£0.08 per conversational session with caching and small models for routing), map/data licences, cloud. Engines are cheap to run; AI is used sparingly.

## 3. Data licensing costs (budget, year 1–2)

| Data | Indicative annual cost | Needed by |
|---|---|---|
| OGL datasets (Land Registry, EPC, EA, HE, planning.data, Ofsted) | £0 licence; ~£15k engineering | Phase 1 |
| OS Data Hub / AddressBase | £0 under PSGA thresholds → £10k–£40k at commercial volume | Phase 2 |
| BGS GeoSure | £5k–£20k | Phase 2 |
| Rental data (commercial) | £10k–£40k | Phase 2 |
| Price-book benchmarking (e.g. BCIS) for calibration | £5k–£15k | Phase 1 (QS validation only) |
| Listing feeds via CRM partners | Partnership; may involve per-branch fees | Phase 3 |
| Map tiles (Mapbox) | £3k–£25k depending on traffic | Phase 2 |

Treat any figure above as a quote to obtain, not an assumption to rely on.

## 4. UK competitive landscape & defensibility

* **Portals** have network effects on listings; we don't attack that directly. We sell the portals' customers (agents) a better conversion layer, and potentially the portals themselves via API.
* **Investor data tools** (PropertyData, Searchland, Nimbus) are close competitors for Investor Pro; our wedge is refurb cost accuracy and contractor execution.
* **Trade marketplaces** compete on lead volume; our wedge is standardised scopes and benchmarked quotes, which better contractors prefer.

### Building the moat

1. **Proprietary refurbishment cost graph** — every structured quote, invoice and final account (with consent) improves regional rates. After ~10,000 verified projects this is not replicable without a marketplace.
2. **Verified outcome data** — actual post-works sale prices and rents linked to actual costs: the dataset lenders and valuers want (refurb-to-value).
3. **Integration lock-in** — CRM plugins, lender workflows, embedded widgets; switching means re-integrating.
4. **Trust brand** — explicit provenance labelling and refusal to overclaim.
5. **Engine versioning & audit trail** — lenders and enterprises need reproducibility; consumer-grade tools rarely offer it.

## 5. Five-year illustrative trajectory (base case)

| | Y1 | Y2 | Y3 | Y4 | Y5 |
|---|---|---|---|---|---|
| Paying investors | 1,500 | 7,000 | 18,000 | 30,000 | 42,000 |
| Landlord units managed | 2,000 | 25,000 | 90,000 | 200,000 | 350,000 |
| Agent branches | 20 | 250 | 900 | 2,000 | 3,200 |
| Active contractors | 150 | 1,200 | 4,000 | 8,000 | 12,000 |
| API/enterprise customers | 3 | 20 | 60 | 120 | 200 |
| **ARR** | **~£0.9m** | **~£5m** | **~£16m** | **~£35m** | **~£58m** |

The biggest swing factor is enterprise/API (Y3+). If B2B lags, Plinth is a solid £10–15m ARR prosumer business; if it lands, it becomes infrastructure.

## 6. Recommendations (stronger than the brief)

* **Lead with B2B2C, not consumer ads.** Consumer property CAC is brutal against portal brand spend. Distribute the estimator through agents, brokers and lenders who already have the customer.
* **Charge contractors on success, not leads.** Aligns incentives and creates the invoice data we need.
* **Make the free report shareable** (agents attaching it to listings) — this is the cheapest acquisition loop available.
* **Avoid becoming a lettings agent or broker.** Partner with regulated firms; take referral revenue.
