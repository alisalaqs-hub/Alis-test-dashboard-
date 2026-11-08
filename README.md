# plinth. — AI-first UK property intelligence (prototype)

> Don't search for a house. Search for the deal inside it.

Plinth is a property decision platform: it prices the refurbishment, underwrites the investment and surfaces planning and risk constraints for any UK property. It is also B2B infrastructure, so agents, lenders, landlords and contractors can embed the same engines.

**Status:** interactive prototype. The calculation engines are real and unit-tested. **All listings, people, comparables and market figures are fictional demonstration data** and are labelled as such in the UI.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # engine unit tests (tax, refurb, investment, search)
npm run build        # production build → dist/
npm run build:single # one self-contained HTML file → dist-single/index.html
```

## Screens (hash routes)

| Route | Screen |
|---|---|
| `/#/` | Homepage with AI property search |
| `/#/search` | Conversational search, ranked results & schematic UK map |
| `/#/property/wal-001` | Property intelligence dashboard (deal score, value-add plays, constraints, EPC pathway, cost of ownership, property copilot, offer prep) |
| `/#/estimate` | Refurbishment estimator (trade / room / BoQ views, 3 scenarios, survey upload, CSV export) |
| `/#/invest` | Investment underwriter (BTL, BRRR, flip, HMO; SDLT/LTT/LBTT; ICR stress test; scenarios; sensitivity grid) |
| `/#/studio` | AI renovation visualisation studio (before/after, styles, finishes, live budget) |
| `/#/landlord` | Landlord management (compliance, maintenance triage, applications with human decisions) |
| `/#/marketplace` | Contractor marketplace (benchmarked quote comparison, verification, milestones) |
| `/#/agents` | Estate agent portal (lead intent, sales progression, listing copy) |
| `/#/developers` | API & white-label console (live engine call, widget builder, pricing) |

## Code map

```
src/engine/tax.ts         SDLT (England/NI), LTT (Wales), LBTT + ADS (Scotland)
src/engine/refurb.ts      Refurb cost engine, region mapping, BoQ CSV, quote comparison
src/engine/investment.ts  BTL/BRRR/flip/HMO analysis, scenarios, sensitivity
src/engine/insights.ts    Deal score, loft scenario, EPC pathway, ownership forecast
src/engine/search.ts      Natural-language → structured query (LLM stand-in) + ranking
src/data/properties.ts    12 fictional demo properties
src/pages/*               The ten screens
db/schema.sql             PostgreSQL + PostGIS schema
docs/                     Strategy, architecture, commercial model, GTM & 90-day plan
```

## Documents

1. [Product strategy, brand, positioning, features & roadmap](docs/01-product-strategy.md)
2. [Technical architecture](docs/02-architecture.md) · [database schema](db/schema.sql)
3. [Commercial model](docs/03-commercial-model.md)
4. [Go-to-market & 90-day MVP plan](docs/04-go-to-market-and-90-day-plan.md)

## Important caveats

* Refurbishment unit rates are **Plinth demonstration rates**, not BCIS/Spon's and not yet calibrated against verified quotes.
* Tax tables reflect rates as configured in November 2026; verify against HMRC / Welsh Revenue Authority / Revenue Scotland before relying on them.
* Nothing here is financial, tax, legal, planning or surveying advice.
