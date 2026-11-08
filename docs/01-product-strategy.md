# BRIXO — Product Strategy, Brand & Information Architecture

> **BRIXO** · The Intelligent Property Platform · *See Beyond the Property.*

## 1. The strongest unique selling proposition

**Portals show you the property. BRIXO shows you what it could become — and proves it with numbers.**

Every property on BRIXO carries a living intelligence profile that connects five things no UK portal joins up:

| Lens | Question it answers | Engine |
|---|---|---|
| Value | Is it fairly priced? What's it worth after works? | Comparable-based valuation scenarios (`engine/valuation.ts`) |
| Cost | What will the work really cost here? | Regional refurbishment cost engine (`engine/refurb.ts`) |
| Design | What could it look like — and what does *that* cost? | Design-to-cost studio (`engine/design.ts`) |
| Return | Is it a good investment under stress? | Investment underwriter (`engine/investment.ts`, `tax.ts`) |
| Market response | How are buyers actually reacting to it? | Engagement engine (`engine/engagement.ts`) |

The flywheel: consumers explore costs and designs → owners and agents see *aggregated* evidence of what buyers care about → they commission works and quotes through BRIXO → **verified quotes and outcomes recalibrate the cost engine** → estimates get better → more professionals embed BRIXO via API.

**Why this beats "more data":** collecting clicks is not defensible — every portal has clicks. What is defensible is *verified cost and outcome data* tied to properties (quote → invoice → resale/rent), plus integrations that make BRIXO part of agents' and lenders' daily workflow.

### Challenges to the brief (and how we answer them)

1. **"Compete with portals" is a year-3+ goal, not a launch tactic.** Rightmove's moat is agent listing supply. BRIXO wins first as the intelligence layer *on top of* any listing (paste a listing, enter an address, or embed in an agent's site), then attracts listings because BRIXO listings convert better.
2. **Engagement analytics are only valuable if trusted.** We separate *observed* counts from *inferred* interpretation and *recommendations*, show confidence intervals, and suppress small groups (k ≥ 10). We never treat a photo view as purchase intent.
3. **AI must not fabricate.** LLMs route, read and explain; deterministic engines produce every number. Answers carry evidence, assumptions and "verify before relying" items.
4. **Valuation, planning, mortgage and tenant decisions are regulated or high-stakes.** BRIXO screens and explains; RICS valuers, planners, FCA-regulated brokers and humans decide.
5. **Interior design images are marketing, not engineering.** Every concept is labelled; virtual staging is watermarked (consumer protection: misleading-images risk under the DMCC Act 2024 / CPRs).

## 2. Brand identity

| Element | Choice | Rationale |
|---|---|---|
| Name | **BRIXO** | Bricks + X (the unknown, the multiplier) + O (the lens). Short, global, pronounceable. *Check UKIPO/EUIPO classes 9, 35, 36, 37, 42 and domains before launch.* |
| Mark | Rounded obsidian block with brick courses and a **signal-orange lens** | "See beyond the property": the lens looks through the building. |
| Wordmark | `BRIX` + an orange ring for the **O** | The lens again; works at favicon size. |
| Colour | Obsidian `#0B0D12`, Paper `#F6F5F1`, **Signal orange** `#FF5A1F` (brand/action), **Insight violet** `#6B4EFF` (reserved for AI output), **Verified teal** `#0F7B6C` (verified/positive) | Colour carries meaning: violet always means "AI said this", teal means verified. |
| Type | **Sora** (display), **Inter** (UI), **JetBrains Mono** (every number) | Tech-company feel; monospaced figures signal *calculated, not marketed*. |
| Voice | Plain British English, specific, candid ("none of these meet your target — here's what would need to be true") | Trust is the product. |
| Provenance labels | `Demo data` · `Estimate` · `AI` · `Observed` · `Inferred` · `Recommendation` · `Verified` · `Needs live integration` | Every figure declares where it came from. |

Implementation: `src/components/Brand.tsx`, tokens in `src/styles.css` (light + dark themes).

## 3. Information architecture

```
BRIXO
├── Consumer (simple)
│   ├── Home ─ AI search, four lenses, connected journey
│   ├── Search ─ conversational query + filters + map + save/compare
│   ├── Property listing ─ gallery, floor plan, documents, viewing, contact, privacy
│   │   └── Intelligence profile ─ value · cost · development · market response · knowledge graph · AI Q&A
│   ├── Design Studio ─ style/budget brief → concept → schedule → quotes / investment
│   ├── Refurb Costs ─ regional estimator, BoQ, defect risks
│   ├── Invest ─ BTL · BRRR · flip · HMO · commercial; scenarios; break-evens
│   ├── Compare · Saved
│
├── Professionals (sophisticated)
│   ├── Owner dashboard ─ engagement, insights, owner AI, weekly report
│   ├── Agent command centre ─ portfolio analytics, approvals, AI reports & copy
│   ├── Landlord management ─ compliance, maintenance, applications, landlord AI
│   ├── Developer intelligence ─ unit-mix demand, residual appraisal, opportunities
│   ├── Contractor marketplace ─ standard scopes, benchmarked quotes, milestones
│   ├── AI agents ─ 8 role agents, permissions, approval queue, audit log
│   └── API & Enterprise ─ endpoints, widgets, plans, RBAC, keys, usage
│
└── Shared services
    ├── Engines (deterministic, versioned)  ├── Assistant skills (grounded AI)
    ├── Engagement tracking (consented)     ├── Knowledge graph (access-controlled)
    └── Approvals + audit log
```

Design principle: **one property, one profile, many views.** The consumer sees the listing and its intelligence; the owner sees how the market responds to it; the agent sees it across a portfolio; partners call it by API.

## 4. Competitive positioning

| Player | Strength | BRIXO's angle |
|---|---|---|
| Rightmove, Zoopla, OnTheMarket | Listing supply & reach | We don't fight for supply first; we make any listing smarter, then convert better |
| PropertyData, Searchland, Nimbus | Investor/land data | We add cost, design and execution (quotes) |
| Hometrack, PriceHubble | Lender AVMs | We add cost-to-improve and post-works value |
| Checkatrade, MyBuilder | Trade leads | Standardised scopes + benchmarks instead of lead auctions |
| Virtual staging / AI design apps | Pretty images | Every design is costed, scheduled, quotable and investable |
| Lettings software (Goodlord, Arthur) | Admin | Portfolio intelligence + maintenance prediction + compliance |

## 5. Feature set & status in this prototype

| Part | Feature | Prototype status |
|---|---|---|
| 1 | Marketplace: search buy/rent/commercial/development, filters, map, compare, save, viewings, contact, documents | **Working** on 15 fictional listings |
| 1 | Conversational AI search incl. all three example queries | **Working** (rule-based interpreter → same structured query an LLM would emit) |
| 2 | Per-property AI intelligence with Q&A (overpriced? rent? costs? kitchen? extend? risks? compare? invest?) | **Working**, grounded skills with evidence/assumptions/verify |
| 3 | Engagement engine: 20 signals, observed vs inferred, CIs, k-anonymity | **Working** on simulated, seeded data; consent-gated client tracking demonstrated |
| 4 | Owner dashboard + owner AI + weekly report | **Working** (Markdown report download) |
| 5 | Agent command centre, alerts, quality scores, AI copy, seller reports, approval queue | **Working** (approval records decisions; nothing is sent) |
| 6 | Design studio: 9 styles, kitchen/bath finishes, staging watermark, layout planner, materials, budget designer, before/after, save/share, design-to-cost, design engagement | **Working**; images are illustrations / colour-grade previews (image model not connected) |
| 7 | Regional refurb engine incl. commercial fit-out, office-to-resi, groundworks, BoQ, labour/materials, defect risks | **Working**, demo rate library |
| 8 | Investment analyser incl. commercial, break-evens, scenarios, sensitivity, linked to design & refurb | **Working** |
| 9 | Development potential (loft, rear/side, subdivision, Class MA, energy) | **Working** rules-based screening |
| 10 | Landlord management + landlord AI + predictive maintenance | **Working** on demo portfolio |
| 11 | Demand prediction / unit mix for developers | **Working** scenario tool on labelled demo inputs (no trained model) |
| 12 | Multi-agent system with permissions, approvals, audit | **Working** deterministic agents (no scheduler/LLM) |
| 13 | Knowledge graph | Visualised per property; schema designed (`db/schema.sql`) |
| 14 | API, widgets, plans, RBAC | Console + live estimate demo; API server not built |

## 6. Twenty-plus further AI features (prioritised by problem × data reliability)

1. Survey interpreter → proposed scope (✅ data: user upload)
2. Auction legal-pack analyser (✅)
3. Lease analyser — service charge, ground rent, onerous clauses (✅)
4. Lead-photo A/B testing with significance (✅ first-party)
5. Listing description generator with verified material-information fields (✅)
6. Price-reduction impact predictor (◐ needs outcome history)
7. Buyer-objection miner from viewing feedback (✅ agent input)
8. EPC upgrade pathway + grant matcher (✅ OGL EPC)
9. Hidden-defect risk register (✅ rules + survey)
10. Contractor quote anomaly detector (✅ prototyped)
11. Variation fairness checker (✅)
12. Digital property passport (✅ owner uploads)
13. Conveyancing milestone predictor (○ conveyancer APIs)
14. Predictive maintenance (◐ prototyped from component ages)
15. Rent review evidence pack for s13 notices (◐)
16. Refinance-window alerts (◐)
17. Local market change detection — planning, transport, price paid (◐)
18. Planning precedent finder (◐ planning.data.gov.uk)
19. Permitted-development checker (✅ rules)
20. Unit-mix optimiser (◐ prototyped)
21. Lifestyle matching — commute, schools, amenities (◐ open data)
22. Investment opportunity alerts on saved underwriting criteria (✅)
23. Portfolio optimiser — sell/hold/refinance (✅ owner data)
24. Design-preference intelligence for developers' specification (✅ first-party aggregate)
