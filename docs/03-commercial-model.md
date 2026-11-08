# BRIXO — Commercial Model

All figures are planning assumptions to be tested in customer discovery, not forecasts.

## 1. Revenue streams

| # | Stream | Package & price (ex VAT) | Buyer |
|---|---|---|---|
| 1 | Premium property intelligence reports | £19 per property (valuation scenarios, refurb, development screening, risks) | Buyers, homeowners |
| 2 | Investor subscriptions | **Pro** £29/mo · **Portfolio** £79/mo (alerts, unlimited underwriting, BoQs, document AI) | Investors, small developers |
| 3 | Estate agent SaaS | **Agent Pro** £149/branch/mo · **Command** £349/branch/mo (engagement analytics, AI seller reports, AI copy, widgets) | Agencies |
| 4 | Landlord management | £3/unit/mo (min £15); agents £1.50/unit at volume | Landlords, letting agents |
| 5 | AI interior design | **Design** £9/mo consumer · **Staging** £5 per staged image or £99/branch/mo | Homeowners, agents, landlords |
| 6 | Contractor quotation services | £39–£79/mo + 2–3% success fee on awarded work (capped) | Contractors |
| 7 | Enterprise property intelligence | £50k–£250k+/yr (lenders, BTR operators, insurers, developers) | Enterprise |
| 8 | White-label licensing | £499/mo Growth → enterprise licence; agent-branded BRIXO | Agencies, portals |
| 9 | API usage | £0.02–£0.60 per call (see `/enterprise`), volume commits | Proptechs, lenders |
| 10 | Compliant partnerships | Referral fees from FCA-authorised brokers, conveyancers, insurers, retrofit installers (disclosed) | Partners |

## 2. Unit economics (steady state, year 2)

| Segment | ARPA/yr | Gross margin | CAC | Payback | Churn/yr |
|---|---|---|---|---|---|
| Investor Pro | £300 | 85% | £60–£110 | 3–5 mo | 35% |
| Agent (per branch) | £2,500 | 82% | £1,000–£1,600 | 6–9 mo | 12% |
| Landlord (8 units) | £290 | 88% | £120 | 6 mo | 18% |
| Contractor | £1,600 | 80% | £250 | 2–3 mo | 30% |
| API Growth | £9,000 | 72% | £3,000 | 4–5 mo | 10% |
| Enterprise | £120,000 | 70% | £30,000 | 4 mo | 5% |

Gross-margin drivers: LLM inference (target ≤ £0.05 per assistant session via routing to small models + caching), image generation (≈£0.02–£0.10 per concept), data licences, cloud. Deterministic engines are near-free to run, which is why we keep calculation out of the LLM.

## 3. Recurring revenue logic

* Agents pay monthly because the **owner dashboard and weekly reports** become part of how they win and keep instructions ("we show you exactly how buyers respond").
* Landlords pay because compliance is continuous and failure is costly.
* Investors pay for alerts and unlimited underwriting.
* Contractors pay because scoped, benchmarked leads convert better than lead auctions.
* API customers pay per use and embed deeply (switching cost).

## 4. Defensibility — what actually compounds

1. **Verified refurbishment cost graph**: structured quote lines + invoices + final accounts by trade, region, spec and date. Requires the marketplace; cannot be scraped.
2. **Cost-to-outcome data**: linking works done to subsequent sale price/rent — what lenders, valuers and developers want.
3. **Workflow integrations**: CRM plugins, lender origination, widgets on agent sites — switching costs.
4. **Trust & explainability brand**: labelled provenance, grounded AI, published methodology.
5. **Engine versioning & audit**: reproducibility enterprises require.

*Not* a moat by itself: raw engagement data. It is valuable to the listing's owner/agent, but every portal has clicks; it compounds only when connected to outcomes (did the lead-photo change lift viewings? did the reduction sell the house?).

## 5. Data licensing budget (years 1–2, to be quoted)

| Data | Indicative annual cost |
|---|---|
| OGL datasets (Land Registry, EPC, EA, HE, planning.data, Ofsted, ONS) | £0 licence; ~£20k engineering |
| OS Data Hub / AddressBase | £0 under PSGA thresholds → £10k–£40k |
| BGS GeoSure | £5k–£20k |
| Commercial rental data | £10k–£40k |
| Price-book access for QS calibration | £5k–£15k |
| Map tiles | £3k–£25k |
| Image generation API | usage-based (£0.02–£0.10/concept) |

## 6. Illustrative trajectory (base case)

| | Y1 | Y2 | Y3 | Y4 | Y5 |
|---|---|---|---|---|---|
| Paying investors/consumers | 2,000 | 9,000 | 22,000 | 36,000 | 50,000 |
| Agent branches | 25 | 300 | 1,000 | 2,200 | 3,500 |
| Landlord units | 2,000 | 25,000 | 90,000 | 200,000 | 350,000 |
| Active contractors | 150 | 1,200 | 4,000 | 8,000 | 12,000 |
| API/enterprise customers | 3 | 20 | 60 | 120 | 200 |
| **ARR** | **~£1.0m** | **~£6m** | **~£19m** | **~£40m** | **~£65m** |

Swing factor: agent command-centre adoption (Y2) and enterprise/API (Y3+).
