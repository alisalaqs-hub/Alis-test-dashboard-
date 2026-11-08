# Plinth — Product Strategy

> **plinth** /plɪnθ/ — the base course a building stands on.
> *The intelligence layer beneath every property decision.*

## 1. Brand identity

| Element | Choice | Rationale |
|---|---|---|
| Name | **Plinth** | A real construction term (the plinth course), short, ownable, and it says "foundation" — what we want to be for other property businesses. Check UKIPO class 9/36/37/42 and domain availability before committing. Alternatives shortlisted: *Groundwork*, *Keystone* (crowded), *Fabric*. |
| Line | "Don't search for a house. Search for the deal inside it." | Positions against listing portals without naming them. |
| B2B line | "The intelligence layer beneath every property decision." | Infrastructure framing for API/white-label. |
| Visual | Warm paper (#F4F1EA), ink (#12161B), brick accent (#B4462A), sage for positive values. Fraunces (display serif) + Inter Tight (UI) + JetBrains Mono (all numbers). | Feels like a financial terminal crossed with an architect's drawing set, not a portal. Monospaced numbers signal "calculated, not marketed". |
| Voice | Plain British English, candid. Says "none of these meet your target" when true. | Trust is the product. |
| Labelling system | `Demo data` · `Estimate` · `AI-generated` · `Verified` · `Needs live integration` | Every number on screen carries its provenance. |

## 2. The unique proposition

Portals (Rightmove, Zoopla, OnTheMarket) monetise **attention on listings**: agents pay to be seen. Nobody in the UK consumer market prices the **work** — what it will cost to make a property right, and whether the result is worth it. That decision happens in spreadsheets, builder guesswork and forum threads.

**Plinth sells underwritten property, not listed property.** Every property is accompanied by:

1. a costed refurbishment scope (room-by-room, trade-by-trade, regionalised, with range and assumptions),
2. an investment case (tax, finance, stress test, scenarios),
3. a constraint check (planning, flood, heritage, EPC),

— and the same engines are sold via API to the businesses that touch those decisions (agents, lenders, landlords, contractors, portals).

### Challenging the brief

* **"Compete with Rightmove" is the wrong first fight.** Rightmove has ~85%+ share of portal time and >£350m revenue at ~70% operating margins; its moat is agent supply of listings. Do not try to win listing supply in years 1–2. Win the **decision layer** that sits on top of any listing, then let agents bring listings because Plinth-underwritten listings convert better.
* **Listings data is not freely available.** Portal scraping breaches terms and database rights. Listing supply must come from agent CRM feeds (with agent consent), auction houses, and user-submitted listings. Budget for this to be slow.
* **The refurbishment cost engine is only as good as its calibration data.** Commercial price books (BCIS, Spon's) require licences and do not cover domestic refurb well. The real moat is *verified* quotes and invoices — which means the contractor marketplace is strategically essential, not a side feature.
* **AI is the interface, not the calculator.** LLMs must never produce prices, taxes or yields. They interpret, extract and explain; deterministic, versioned engines calculate. This is both a trust position and a regulatory one.
* **Avoid regulated activity by design in year 1.** Mortgage advice (FCA), client money/escrow (FCA payments), tenant referencing decisions (UK GDPR Art. 22), and RICS valuations are all regulated. Partner rather than build.

## 3. Competitive positioning

| Player | What they do well | Gap Plinth fills |
|---|---|---|
| Rightmove / Zoopla / OnTheMarket | Listing reach, agent relationships | No refurb costing, no underwriting, no contractor loop |
| PropertyData, Searchland, LandInsight/Nimbus | Investor & developer data, land sourcing | Strong data, weak on refurb cost and execution; spreadsheet-like UX |
| Hometrack, PriceHubble, Zoopla AVMs | Valuations for lenders | Value-today only; no cost-to-improve |
| Checkatrade, MyBuilder, Rated People | Trade lead marketplaces | Unstandardised scopes, no benchmark, race to the bottom |
| Goodlord, Arthur, Hammock, Landlord Studio | Lettings admin | No acquisition/refurb intelligence; separate data silos |
| Estimating tools (e.g. Buildxact, spreadsheets) | Contractor-side pricing | Not consumer/investor facing, not regionally benchmarked |

**Position:** *the only platform that connects "what is it worth" to "what will it cost" to "who will do it" — with verified outcomes flowing back.*

## 4. Five most valuable MVP features

Chosen by: (a) pain severity, (b) data we can legitimately obtain now, (c) willingness to pay, (d) contribution to the data moat.

| # | Feature | Why first | Prototype status |
|---|---|---|---|
| 1 | **Refurbishment cost engine** | Highest pain, no good UK consumer tool, feeds everything else | Working: `src/engine/refurb.ts`, `/estimate` |
| 2 | **Investment underwriter** (BTL/BRRR/flip/HMO, SDLT/LTT/LBTT, ICR) | Investors pay; deterministic so shippable with confidence | Working: `src/engine/investment.ts`, `tax.ts`, `/invest` |
| 3 | **Property intelligence report** | Shareable artefact; viral loop with agents and investors | Working: `/property/:id` |
| 4 | **Conversational deal search** | The "wow" moment; reframes search around outcomes | Working with rule-based interpreter: `src/engine/search.ts` |
| 5 | **Standard scope + quote comparison** | Creates the verified-cost moat and contractor revenue | Working: `/marketplace`, `compareQuotes()` |

## 5. Additional differentiated AI features (24)

Ranked by (genuine problem × data reliability). ✅ = data reliably available today; ◐ = partially; ○ = depends on partnerships.

| # | Feature | Problem solved | Data | |
|---|---|---|---|---|
| 1 | **Deal score with explanation** | Too many listings, little time | Engine outputs + comps | ✅ (prototyped) |
| 2 | **Survey interpreter** | RICS L2/L3 reports are opaque | User-uploaded PDF | ✅ (prototyped, keyword) |
| 3 | **Hidden refurb risk detection** | Damp, subsidence, asbestos, knotweed discovered too late | Survey + BGS + era + photos | ◐ |
| 4 | **EPC upgrade pathway** | MEES compliance & energy bills | EPC register (OGL) | ✅ (prototyped) |
| 5 | **Negotiation preparation** | Buyers anchor on asking price | Comps, DOM, price history | ✅ (prototyped) |
| 6 | **Total cost of ownership forecast** | Hidden running costs | Council tax bands, EPC, rates | ✅ (prototyped) |
| 7 | **Investment opportunity alerts** | Deals go in days | Saved underwriting criteria × new listings | ◐ |
| 8 | **Local market change detection** | Spotting regeneration early | Planning apps, HPI, price paid, new transport | ◐ |
| 9 | **Digital property passport** | Information lost at every sale | Owner uploads, certificates, works history | ✅ |
| 10 | **Conveyancing progress predictor** | 20+ week transactions, collapses | Conveyancer case APIs | ○ (UI prototyped) |
| 11 | **Predictive maintenance** | Reactive repairs cost 3× | Asset age, maintenance logs | ◐ |
| 12 | **Portfolio optimiser** | Which property to sell/refinance | Portfolio data, rates, yields | ✅ |
| 13 | **Lifestyle & financial matching** | Search by life, not filters | Commute, schools, budget, goals | ◐ |
| 14 | **Auction legal-pack analyser** | Buyers bid blind on legal packs | Legal pack PDFs | ✅ |
| 15 | **Planning precedent finder** | "Will they approve a dormer here?" | planning.data.gov.uk + LPA portals | ◐ |
| 16 | **Permitted development checker** | PD rules are complex | GPDO rules + constraints layers | ✅ (rules engine, not AI) |
| 17 | **Contractor quote anomaly detector** | Cowboy quotes, missing scope | Benchmark + quote lines | ✅ (prototyped) |
| 18 | **Variation fairness check** | Mid-job price creep | BoQ + variation details | ✅ |
| 19 | **Lease analyser** | Ground rent, service charge, onerous clauses | Lease PDF | ✅ |
| 20 | **Rent review evidence pack** | Section 13 increases need evidence | Let comps | ◐ (prototyped UI) |
| 21 | **Tenant maintenance triage** | Landlords overwhelmed by reports | Tenant text/photos | ✅ (prototyped) |
| 22 | **Compliance autopilot** | Missed gas/EICR/deposit deadlines = fines | Certificates | ✅ (prototyped) |
| 23 | **Retrofit grant matcher** | Grants are fragmented | BUS, ECO4, GBIS, local schemes | ✅ |
| 24 | **Refinance window alerts** | Fixed rates expiring, equity trapped | Portfolio + rates + AVM | ◐ |

## 6. Prioritised roadmap

| Horizon | Theme | Features |
|---|---|---|
| **Now (0–3 m)** | Prove the engines | Refurb estimator, investment underwriter, intelligence report, BoQ export, quote comparison (manual quote upload), accounts & saved projects |
| **Next (3–9 m)** | Discovery + supply | Conversational search on licensed/agent feeds, alerts, survey & legal-pack interpreter, contractor onboarding & verification, Land Registry/EPC/flood integrations |
| **Later (9–18 m)** | Operate | Agent portal + CRM sync, landlord management & compliance, design studio with image models, conveyancing tracker |
| **Scale (18 m+)** | Infrastructure | Public API GA, white-label widgets, lender/portal partnerships, Wales/Scotland/NI rule-sets, international assessment |

## 7. Principles we will not compromise

1. Never fabricate listings or imply data access we lack.
2. Every number has a source label, a date and editable assumptions.
3. AI never makes a tenant decision, a planning determination or a valuation.
4. Verified data and estimates are never blended without labelling.
5. Contractor and user data is used for model calibration only with explicit consent, aggregated and anonymised.
