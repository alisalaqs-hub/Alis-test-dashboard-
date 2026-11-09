# 08 · The Streetkey back end (Netlify + AI)

Streetkey is one codebase that runs in three ways:

| Where | What you get |
|---|---|
| **Netlify (recommended, production)** | The website plus the full back end as Netlify Functions: accounts, real listings with photos, enquiries, alerts, agent feeds, admin, and every AI feature. |
| Any Node host (Render, Fly.io, a VPS) | The same back end as one long-running server (`render.yaml`, `Dockerfile`). |
| Static preview (GitHub Pages, shared previews) | The website only. AI and account features explain that they need the live site; everything else falls back to Streetkey's built-in rules. |

## How it fits together on Netlify

```
Browser ── static site (dist/, from Netlify's CDN)
   │
   ├── /api/*     → netlify/functions/api.mts        the whole API (Fastify app, ~30 s per request)
   ├── /media/*   → netlify/functions/media.mts      photos and AI images from Netlify Blobs
   │
   │   AI jobs (image redesigns, photo analysis, listing reviews…)
   ├──────────────→ netlify/functions/ai-worker-background.mts   up to 15 minutes, runs queued jobs
   └── hourly     → netlify/functions/scheduled.mts             search alerts, job recovery, clean-up
                       │
        PostgreSQL (Netlify Database / Neon) · Netlify Blobs · OpenAI · Resend (email)
```

- **Database:** PostgreSQL. On Netlify use **Netlify Database** (it sets `NETLIFY_DB_URL` automatically) or any Postgres URL in `DATABASE_URL` (e.g. Neon). Migrations in `server/migrations/` run during the Netlify build and again (cheaply) on the first request of each new function instance.
- **Files:** listing photos and AI images live in **Netlify Blobs**, served from `/media/...` with year-long caching.
- **Slow AI work runs as jobs:** the request queues the job and answers immediately; a Netlify Background Function does the work; the page polls `GET /api/ai/jobs/:id`. Quick jobs can run inside a request if no worker picks them up.
- **Email:** Resend. Without a key, emails are written to the function log (useful for the first admin's confirmation link).

## Put it live on Netlify: step by step

> **Don't drag and drop the `dist` folder.** That uploads only the website. The back end needs Netlify to build from GitHub.

1. **Create the site.** netlify.com → *Add new site* → *Import an existing project* → GitHub → choose `alisalaqs-hub/Alis-test-dashboard-` and the branch `claude/ai-property-platform-uk-kwzcrf` (or `main` once merged). Netlify reads `netlify.toml`: build command `npm run build:netlify`, publish folder `dist`, functions in `netlify/functions`. Click **Deploy**.
2. **Add a database.** Site → *Extensions* (or *Database*) → **Netlify Database** → create. It sets `NETLIFY_DB_URL` for you. (Alternative: create a free Neon project and add its connection string as `DATABASE_URL`.) Pick a European region (London `eu-west-2` or Frankfurt `eu-central-1`) for your UK visitors.
   - **Keep the functions next to the database.** Site configuration → *Build & deploy* → *Functions* → *Functions region*: choose the same region as the database, if your plan offers it. Every page that talks to the server makes several database round trips, so a US function talking to a European database adds about 80 ms each time.
3. **Add environment variables** (Site configuration → Environment variables). Full list with explanations in `.env.example`:
   - `OPENAI_API_KEY`: from platform.openai.com → API keys. Add credit and set a monthly limit there.
   - `ADMIN_EMAIL`: your email address (see step 5).
   - `RESEND_API_KEY` and `EMAIL_FROM` (e.g. `Streetkey <hello@yourdomain.co.uk>`): from resend.com after verifying your domain. Optional at first.
   - Optional: `AI_DAILY_TOKEN_BUDGET`, `AI_DAILY_TOKENS_PER_USER`, `AI_DAILY_TOKENS_PER_IP`, `AI_DAILY_IMAGES_PER_USER`, `AI_DAILY_IMAGES_SITE`, `AI_DAILY_REQUESTS_PER_USER`, `AI_DAILY_REQUESTS_PER_IP`, `AI_AUTO_APPROVE_LOW_RISK`, `AI_DISABLED` (defaults and meanings in `.env.example`).
4. **Redeploy** (Deploys → *Trigger deploy*). The build applies the database migrations.
5. **Make yourself admin.** Open the site, *Sign in → Create account* with the same address as `ADMIN_EMAIL`, then click the confirmation link in the email (or, if email isn't set up yet, find the link in Netlify → *Logs → Functions → api*). Once confirmed you're the admin (this only works while no admin exists).
6. **Check it.** Visit `/api/health` (should say `"ok": true` and `"ai": true`), then *Admin → AI* to see which OpenAI models were selected and today's usage.
7. **Your domain.** Domain management → add your domain and follow the DNS steps. Then set `PUBLIC_URL` to `https://www.yourdomain.co.uk` and redeploy (used in emails).

**Plan note:** long AI work (room redesigns, photo checks) uses Netlify **Background Functions**. If your Netlify plan doesn't include them, those AI tasks show "background processing isn't running on this site"; everything else works.

## AI across the site

All OpenAI traffic goes through `server/src/ai/core.ts`. Figures shown to people always come from Streetkey's own engines or the database; the AI explains, prioritises and writes, and code checks its output (money figures it didn't get from the engines are removed). Every AI result is labelled, and every feature falls back to Streetkey's built-in rules when AI is off or a call fails.

| Where | What the AI does | Endpoints |
|---|---|---|
| **Ask Streetkey** (floating button on desktop, *Ask* tab on phones) and *Ask anything about this home* on property pages | A chat assistant that uses tools wired to the engines: search homes, property facts and intelligence, stamp duty, renovation estimates, investment checks, mortgage payments, comparisons. Links and property cards are validated; figures are checked against tool results. | `POST /api/ai/chat` |
| **Search** | Natural-language search turned into filters ("AI understood" chips you can remove), semantic re-ranking, and *Similar homes* on property pages. Never filters by protected characteristics. | `POST /api/ai/search/intent`, `POST /api/ai/search/rank`, `GET /api/ai/search/similar/:id` |
| **List a property** | Description writer with code-enforced wording rules (no unverifiable claims, fixed rent for lettings, no discriminatory wording), photo checks with consent (room labels, alt text, quality tips, privacy flags, best order), price-guide explanation (figures from the engine), and a pre-submission check. | `POST /api/ai/listing/describe`, `/price-guide`, `/precheck`, `/photos/preview`, `POST /api/ai/listing/:ref/photos/check`, `GET /api/ai/listing/:ref/photos`, `GET/PUT /api/ai/listing/photos/consent` |
| **Trust & safety** (admin) | Every submitted listing is reviewed automatically: OpenAI moderation of text and photos, scam signals (payment before viewing, price far below the area, contact details), material-information gaps, discrimination; a risk score with quoted evidence and a suggested message to the lister. Optional auto-approval of low-risk listings (`AI_AUTO_APPROVE_LOW_RISK`, off by default; AI never rejects). | `GET /api/ai/trust/pending`, `GET /api/ai/trust/listings/:ref`, `POST /api/ai/trust/listings/:ref/review`, `GET /api/ai/admin/overview` |
| **Inbox** | New enquiries are screened for spam and scams (filtered ones aren't emailed and can be released with *Not spam*), triaged (buyer position, questions, urgency), and listers can ask for an editable *Suggested reply* (never sent automatically). | `GET /api/ai/inbox`, `GET /api/ai/inbox/:id`, `POST /api/ai/inbox/:id/suggest-reply`, `POST /api/ai/inbox/:id/unfilter` |
| **My listings / Owner dashboard** | Performance insights per listing with prioritised actions. | `GET /api/ai/listings/:ref/insights` |
| **Check any listing** (import) | Extracts facts from pasted listing text (stated vs inferred, quoted evidence), red flags and questions to ask. Links are never visited. | `POST /api/ai/import/extract` |
| **Design studio** | Photo-real room redesign as a background job (consent, daily limit, labelled), brief reader with costs from the design engine, and *Analyse this room*. | `POST /api/ai/room-image`, `GET /api/ai/room-images`, `POST /api/ai/design/brief`, `POST /api/ai/design/describe-photo` |
| **Costs, investment, My Home** | Renovation estimate from photos (vision → engine scope → estimate; photos deleted after), *Explain this estimate*, investment verdict (never more optimistic than the rules), and a personal home-improvement plan. | `POST /api/ai/refurb/from-photos`, `/refurb/explain`, `/invest/explain`, `/my-home/plan` |
| **Agents, landlords, developers** | Dashboard briefings grounded in the page's figures (or, for agency members, their live listings), and AI proposals on the automation page that still need human approval. | `POST /api/ai/briefing`, `POST /api/ai/automation/run` |
| Shared | Job polling and AI status. | `GET /api/ai/jobs/:id`, `GET /api/ai/status` |

### Models

Leave the `OPENAI_*_MODEL` settings blank and Streetkey picks the best models your OpenAI account can use (checked every few hours): the newest plain `gpt-N` for writing and reasoning, the newest `gpt-N-mini` for fast tasks and photos, the newest `gpt-image-N` for room redesigns, `text-embedding-3-small` for search and `omni-moderation-latest` for moderation. If OpenAI rejects a parameter for a model, the server retries without it and remembers. *Admin → AI* shows what's in use.

### Keeping costs under control

- Site-wide daily token budget (`AI_DAILY_TOKEN_BUDGET`, rolling 24 hours). Ordinary features pause at 85% of it; the last 15% is kept for safety work (trust reviews of listings, enquiry screening), so a burst of chat can't switch off scam checks. While paused, `/api/health` and `/api/ai/status` say so and every page uses its built-in rules.
- Per-person token caps (`AI_DAILY_TOKENS_PER_USER`, `AI_DAILY_TOKENS_PER_IP`): every AI call, including background jobs, is charged to the signed-in person or to the visitor's network (IPv6 addresses are grouped by /64 so they can't be rotated). Safety checks aren't capped per person.
- Request limits per person, per visitor and per feature (per minute and hour), stored in the database so they hold across all serverless instances; a daily cap on new accounts per network; image limits per person (`AI_DAILY_IMAGES_PER_USER`) and for the whole site (`AI_DAILY_IMAGES_SITE`).
- Image generation and photo analysis need a confirmed email address (`POST /api/ai/room-image`, `/api/ai/design/describe-photo` and `/api/ai/refurb/from-photos` answer 403 `verify_email` until it is). Room redesigns answer 429 `quota` (per person) or `site_quota` (whole site) with `retryAfter` and a `Retry-After` header; both limits are re-checked under a database lock after the upload, so parallel requests can't overshoot them.
- The daily AI allowance is only charged once a request has passed validation, permission checks and the cache, so a mistyped form or a cached answer costs nothing.
- Out of credit: if OpenAI says the account has no credit left, Streetkey pauses AI for 10 minutes at a time (and retries), emails `ADMIN_EMAIL` once, shows the reason in *Admin → AI*, and tells visitors only that AI is temporarily unavailable.
- Fast models for parsing and classification, caching of repeatable results, jobs for slow work, consent before photos are analysed.
- Every call is recorded in `ai_usage` (tokens, latency, purpose, who it was charged to as an id; never prompts or outputs). Calls whose answer had to be thrown away (cut short, refused, invalid) are recorded as failures.
- Set a monthly spend limit in your OpenAI account too.

## Listings, photos, feeds and alerts

- **Photo uploads** go up in small batches (up to 12 files and about 4 MB per request, because Netlify functions accept about 6 MB per request). The page shows progress and a retry never creates a second listing. Each request can carry a `meta` JSON field (`[{token, alt}]`) so alt text from the AI photo check is saved with the photo; if a limit stops a batch part-way, the photos already stored are kept and the response says what happened.
- **Edits to live listings** are checked like a new submission: a change that fails a blocking compliance check is refused (422 `checks_failed`), and the AI trust review runs again on every content change (trigger `edited`). A private listing goes back to *pending* when an edit adds a new concern (the code rules act immediately, the AI review follows); verified agencies' feed listings are not held. Reviews fall back to the code rules alone when AI is off, paused or over the per-listing and per-lister caps. Reordering or deleting photos doesn't trigger a review.
- **Agent feeds (BLM):** each upload is the full stock for its feed key: listings that key last sent and that are missing from the file are withdrawn. On Netlify a feed file can be up to 4.5 MB (25 MB on a Node host); bigger files get 413 `feed_too_large`, so larger agencies send each branch's stock with its own key. When splitting an existing feed across branch keys, send the new branch keys' files first, then the original key's file, so the original key doesn't withdraw the other branches' listings in the meantime. Listings imported before migration 013 belong to the key that sent the agency's last file; listings sent by a revoked key are taken over by the agency's only working key (with several working keys they stay until a branch sends them again). Photo links that aren't public HTTPS are dropped at import.
- **Saved searches and alerts** store the search exactly as the person saw it (filters included, migration 010), and alerts run that stored search; older saved searches are re-read in the mode they were saved in.

## Security and privacy

- Passwords hashed with scrypt; sessions are random tokens in `HttpOnly`, `Secure`, `SameSite=Lax` cookies (only hashes stored); password reset signs out every device.
- Cross-site request protection (origin checks); database-backed rate limits; Netlify edge rate limit on the API.
- Uploads: real file type checked from the bytes, size limits, EXIF/XMP/GPS metadata removed.
- Agent-feed photos hosted elsewhere are only downloaded from public HTTPS host names: the address is checked at connection time (no private, loopback, link-local or cloud-metadata addresses), each redirect is re-checked (at most 3), only images are accepted, up to 10 MB.
- Background workers only start for requests carrying the worker secret; stuck or abandoned AI jobs are closed out automatically and never retried forever.
- Private sellers' house numbers and full postcodes are never shown publicly or given to the AI engines.
- AI: untrusted text is fenced off from instructions; outputs are validated in code; no prompts, outputs or API keys are logged; OpenAI API data isn't used for training by default.
- UK GDPR: data export (`/api/me/export`) includes automated assessments. Account deletion removes the person's details, sessions, saved homes and searches, design-studio photos and AI results (files included), AI jobs, enquiry AI summaries, and draft listings with their photos; published listings are withdrawn and kept without the owner's details. AI usage records are kept without the person's id.
- Listings: compliance checks block submission (EPC, council tax, tenure, leasehold details, EPC E+ for lettings, discriminatory wording, rental bidding), plus admin review.

## Run it on your computer

```bash
# PostgreSQL 16 running locally:
createuser -P streetkey            # password: streetkey
createdb -O streetkey streetkey
createdb -O streetkey streetkey_test

npm install
npm run build                      # website → dist/
npm run server:dev                 # website + API on http://localhost:8787

# Try every AI screen without an OpenAI key or cost:
node scripts/mock-openai.mjs &     # a local stand-in that answers with valid sample data
OPENAI_BASE_URL=http://127.0.0.1:8790/v1 OPENAI_API_KEY=mock npm run server:dev
```

Make yourself admin locally: `ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' npm run db:seed`.

For website work with hot reload, run `npm run dev` alongside the server and set `VITE_API_URL=http://localhost:8787` in `.env.local`.

**Migrations:** add a new numbered file in `server/migrations/` and run `npm run gen:migrations`. Never edit a migration that has already been applied anywhere: each applied migration's checksum is stored, and the server refuses to start in development (and logs an error in production) if one changes.

### Tests and checks

| Command | What it checks |
|---|---|
| `npm test` | Engine and website logic tests |
| `npm run server:test` | API and AI features against a real `streetkey_test` database, with a fake OpenAI |
| `npm run typecheck` / `npm run server:typecheck` | TypeScript, website and server |
| `npm run netlify:bundle-check -- --run` | Bundles the Netlify functions like Netlify does and runs the API bundle against PostgreSQL |
| `npm run a11y` | axe WCAG 2.2 AA audit (see the script header for options) |

GitHub Actions runs all of these on every push (`.github/workflows/ci.yml`).

## Other hosts

`render.yaml` (Render Blueprint: web service, PostgreSQL, hourly job) and the `Dockerfile` run the same back end as a single Node server; uploads go to a disk or any S3-compatible bucket (`STORAGE_DRIVER=s3`), and AI jobs run in-process.

## Not built yet

- Payments (Stripe) for listing upgrades, agency subscriptions and API plans.
- Real property data: HM Land Registry prices, the EPC register, Ofsted, TfL/National Rail journey times, flood risk (the intelligence profile still uses demonstration figures for these).
- Identity and HM Land Registry title checks for a "Verified owner" badge.
- Documents (EPC certificates, floor plans, leases) with AI extraction; map search with PostGIS.
- Lettings management tools (tenancies, deposits, compliance reminders).
