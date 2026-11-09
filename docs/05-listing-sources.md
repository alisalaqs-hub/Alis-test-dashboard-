# STREETKEY — Listing Supply: Other Websites & Owner Listings

## The request
1. Use other property websites to find properties.
2. Let people post their own properties.

## 1. Other property websites — what we can and can't do

**We will not scrape Rightmove, Zoopla, OnTheMarket or similar sites.**
* Their terms of use prohibit automated extraction and re-publication of listings.
* Their listing databases are protected by the UK database right (Copyright and Rights in Databases Regulations 1997); photos and descriptions are copyright works of agents/photographers.
* Portals actively detect and pursue scrapers; a scraping-based STREETKEY would be unfundable and could not sign the agent, lender and portal partnerships the business model depends on.

**What we do instead — four legitimate routes (all built in the prototype):**

| Route | How it works | Status in prototype |
|---|---|---|
| **Agent CRM feeds** | Agents own their listings and already push them from their CRM (Reapit, Alto/Vebra, Jupix, Street, etc.) to every portal. They add STREETKEY as one more destination. Formats: BLM bulk files or our JSON API. | **Working**: BLM v3 parser, validation, reject report, status handling, de-duplication (`/sources`, `src/engine/listings.ts`) |
| **Owner & landlord posts** | Private sellers and landlords list directly on STREETKEY. | **Working** 7-step wizard (`/list`) |
| **"Check any listing"** | A user pastes a listing they found elsewhere (link + text they copied). STREETKEY reads only what they paste, keeps it **private** to them, links back to the original and runs the full intelligence profile. | **Working** (`/import`); rules-based extraction, LLM in production |
| **"Search everywhere" links** | Each search offers deep links that open the same area on Rightmove, Zoopla and OnTheMarket in a new tab. Linking out is fine; copying in is not. | **Working** (Search sidebar) |

Additional supply to pursue: auction houses (lot feeds + legal packs), new-homes developers (direct feeds), build-to-rent operators, and housing associations.

### How agent feeds become a moat, not a dependency
* Offer agents something portals don't: listings arrive **pre-underwritten** (price check, works cost, design concepts) and agents get the engagement analytics + AI seller reports from the command centre. That is the reason they switch the feed on.
* Start with 2–3 CRM integrations covering most branches in launch regions; validate demand with 100 branches before building more.
* Feed agreements must cover: display rights, update frequency, media licensing, data protection (vendor details are never in feeds), and removal on withdrawal.

## 2. Owner listings — product and legal requirements

### Built
* Sale or let · owner or landlord · agents redirected to feeds
* Postcode lookup (postcodes.io, open OGL data; offline fallback), privacy-preserving address display
* Material information captured as structured fields (tenure, lease length, service charge, ground rent, council tax band, EPC) — never AI-generated
* Photo upload with in-browser compression, lead-photo choice, **virtual-staging disclosure**
* AI price check against local evidence; AI description drafted only from the owner's facts, editable
* **Compliance checks that block publishing**: missing price/postcode/tenure/council tax/EPC; lease details for leaseholds; EPC below E for lettings; discriminatory rental wording ("No DSS", "no children"); inviting rental bids
* Owner declarations; listing management (live / under offer / withdrawn); owner dashboard; enquiries via STREETKEY messaging (contact details private)
* Merging: if an agent later lists the same home, the records merge ("also listed by")
* Stored on the server with admin review: every submission gets an AI trust review (moderation, scam signals such as payment before viewing, price far below the area, contact details in the text, missing material information) and an admin approves it; edits to a live private listing are checked again and can send it back to review
* Agent feeds: BLM upload endpoint with one key per branch; each upload is that branch's full stock, so withdrawn homes disappear automatically
* Enquiries screened for spam and scams before they reach the lister

### Needed before launch (production)
| Area | Requirement |
|---|---|
| Verification | ID verification (certified IDSP) + HM Land Registry title check (owner name matches proprietor) before a "Verified owner" badge; landlord: proof of ownership or management agreement |
| Fraud & moderation | Duplicate/stolen-photo detection, price anomaly flags, rental-scam patterns (deposit before viewing), manual review queue, report-a-listing |
| Regulation (sales) | If STREETKEY introduces buyers to private sellers it is likely doing **estate agency work** (Estate Agents Act 1979): redress scheme membership (The Property Ombudsman or PRS), HMRC anti-money-laundering supervision and customer due diligence. **Take legal advice** on the precise model. |
| Regulation (lettings) | Letting agency work requires redress scheme membership; Tenant Fees Act (no prohibited fees); client money protection only if STREETKEY holds rent/deposits (avoid initially); Renters' Rights Act advertising rules (fixed rent, no blanket bans) |
| Consumer protection | DMCC Act 2024 / CPRs and NTSELAT material-information guidance — accurate, complete adverts; staged images labelled |
| Data protection | UK GDPR: exact address opt-in, messaging relay, retention for withdrawn listings |

### Strategic option worth considering
Private sellers cannot list directly on Rightmove (it only accepts estate agents). If STREETKEY registers as an online estate agent (fixed-fee model), it could **syndicate owner listings to the major portals** via a feed — giving owners full reach while STREETKEY keeps the intelligence layer. This needs the agency registrations above.

## 3. What is real vs demo
* Real code: BLM parsing, validation, de-duplication, extraction, compliance checks, the listing wizard, the feed endpoint, moderation and admin review, all covered by the website and server tests.
* Listings, photos and feeds are stored on the server (PostgreSQL and Netlify Blobs) once the back end is deployed; the static preview keeps them in the browser.
* The sample feed agency, demo listings and comparables are fictional.
* postcodes.io lookups use open (OGL) data, with an offline fallback.
