# Streetkey — The Intelligent Property Platform

> **See Beyond the Property.**

STREETKEY connects property discovery, valuation, refurbishment costing, interior design, investment analysis, market-response analytics and management in one AI-first platform — and exposes the same intelligence to agents, landlords, developers and partners via API.

**Status:** a working platform, ready to deploy on Netlify. The website, the calculation engines and a full back end (accounts, listings with photos, enquiries, saved searches and alerts, agent feeds, admin and trust & safety) are built and tested: 69 website tests and 342 server tests against a real PostgreSQL database. AI features run on OpenAI once a key with credit is set, and every one falls back to Streetkey's built-in rules when AI is off. **The demo listings, comparables, engagement data and market inputs are still simulated demonstration data**, labelled throughout the UI; official data (HM Land Registry, EPC register, flood risk) isn't connected yet. See [what is real](docs/02-architecture.md#11-what-is-real-today).

## Run

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # website and engine tests
npm run build        # production build → dist/
npm run build:single # single self-contained HTML → dist-single/index.html

# The back end (accounts, listings, enquiries, AI) runs on Netlify Functions; locally it needs PostgreSQL.
# Full guide, including Netlify deployment: docs/08-backend.md
npm run server:dev   # website + API on http://localhost:8787
npm run server:test  # API and AI tests against a real database (fake OpenAI)
```

## The 14 screens (+ compare & saved)

| # | Screen | Route |
|---|---|---|
| 1 | Homepage — AI search, four lenses, connected journey | `/#/` |
| 2–3 | AI property search + listings, filters & map | `/#/search` |
| 4 | Property details — gallery, floor plan, documents, viewing, contact, privacy | `/#/property/wal-001` |
| 5 | Property intelligence dashboard — valuation, cost, development, market response, knowledge graph, AI Q&A | `/#/property/wal-001/intelligence` |
| 6 | Property owner dashboard — engagement analytics, owner AI, weekly report | `/#/owner` |
| 7 | Estate agent command centre — portfolio analytics, approvals, AI reports & copy | `/#/agents` |
| 8 | AI interior design studio — styles, finishes, staging, layout, budget, design-to-cost | `/#/studio` |
| 9 | Regional refurbishment calculator — incl. commercial fit-out & office-to-resi | `/#/estimate` |
| 10 | AI investment analyser — BTL, BRRR, flip, HMO, commercial; break-evens | `/#/invest` |
| 11 | Landlord management — compliance, maintenance, landlord AI | `/#/landlord` |
| 12 | Developer intelligence — unit-mix demand, residual appraisal | `/#/developer` |
| 13 | Contractor marketplace — benchmarked quotes | `/#/marketplace` |
| 14 | API & enterprise portal — endpoints, widgets, plans, RBAC | `/#/enterprise` |
| + | AI agents — 8 role agents, approvals, audit | `/#/automation` |
| + | My Home — value range, ideas, renovation & energy plan for your own home | `/#/my-home` |
| + | Sold prices | `/#/prices` |
| + | **List your property** — owner/landlord wizard with price check, AI description, photos & compliance checks | `/#/list` |
| + | **Check any listing** — paste a listing from another website for private analysis | `/#/import` |
| + | **Listing sources & feeds** — connect an agent CRM feed (BLM), import report, de-duplication | `/#/sources` |
| + | Compare · Saved (homes, searches, designs) | `/#/compare`, `/#/saved` |

## Navigation (v0.3, mobile-first)

* **One smart search box** on the home screen accepts a place, a postcode district or a sentence — no “Classic vs AI” switch. Live suggestions show places, listings and an “ask AI” option; recent searches appear on focus.
* **Intent tabs:** Buy · Rent · Sold prices · Commercial · Invest. **Quick chips** add common criteria in one tap.
* **Task grid:** every main job (buy, rent, value my home, sold prices, cost a renovation, redesign a room, check an investment, sell or let) is one tap from the home screen.
* **Bottom tab bar on phones:** Search · Saved · **Ask** (AI sheet) · My Home · More (everything else, grouped).
* **Personalised:** “pick up where you left off” with save-search hearts; “For you” carousel with deal grade, works cost and value-add on every card.

## Try these AI workflows

1. **Search:** “Find me properties in Croydon that could potentially be converted into multiple flats.”
2. **Property AI:** on Ashcombe Grove, ask “Is this property overpriced?” → evidence, assumptions, what to verify.
3. **Owner:** `/owner` → “Why is my house not selling?” → conversion vs comparables, price evidence, lead-photo test.
4. **Design → money:** `/studio` → “Give this kitchen a luxury appearance for £8,000” → schedule → *Use in investment analysis*.
5. **Agent:** `/agents` → *Seller report* → review the draft in the approval queue → approve → audit log.
6. **Developer:** `/developer` → *Suggest demand-led mix* for 25 units → residual land value vs asking.

## Code map

```
src/engine/   refurb · tax · investment · valuation · development · design · engagement · insights · search · reports · tracking
src/ai/       assistant (grounded answer framework) · skills · landlordSkills · agents (multi-agent runtime)
src/components/ Brand · Layout · Assistant · KnowledgeGraph · ui
src/pages/    the screens
src/store.tsx saved/compare/designs/approvals/audit (browser storage; saved homes and searches sync to the account when signed in)
db/schema.sql PostgreSQL + PostGIS + pgvector schema incl. engagement, designs, agents, knowledge graph
docs/         strategy & brand · architecture · commercial model · roadmap & next steps
```

## Documents

1. [Product strategy, USP, brand identity & information architecture](docs/01-product-strategy.md)
2. [Technical architecture](docs/02-architecture.md) · [database schema](db/schema.sql)
3. [Commercial model](docs/03-commercial-model.md)
4. [Roadmap, go-to-market & next implementation steps](docs/04-roadmap-and-next-steps.md)
5. [Listing supply: other websites, agent feeds & owner listings (incl. legal position)](docs/05-listing-sources.md)
6. [Brand system & accessibility (WCAG 2.2 AA, axe-audited)](docs/06-brand-and-accessibility.md)
7. [Going live: hosting, domain & launch checklist](docs/07-going-live.md)
8. [The back end on Netlify, every AI feature, cost controls and security](docs/08-backend.md)

## Caveats

* Refurbishment and design rates are STREETKEY demonstration rates — not BCIS/Spon's and not yet calibrated with verified quotes.
* Tax tables (SDLT/LTT/LBTT, residential and non-residential) are as configured Nov 2026 — verify before reliance.
* Valuation scenarios are not RICS valuations; development screening is not planning advice.
* Nothing here is financial, tax, legal, planning, valuation or surveying advice.
