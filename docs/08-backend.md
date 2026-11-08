# 08 · The Streetkey back end

The website now has a real server behind it. One Node.js service serves **the website and the API from the same address**, backed by a PostgreSQL database. Without the server (GitHub Pages, the shareable preview) the site still works in demo mode: nothing breaks, account features simply explain that they need the live site.

## What it does

| Area | What people can do | Where |
|---|---|---|
| Accounts | Create an account, sign in/out, confirm email, reset a forgotten password, change password, sign out other devices | `server/src/routes/auth.ts` |
| Your data (UK GDPR) | Download everything held about you; delete your account (listings withdrawn, personal details removed) | `server/src/routes/me.ts` |
| Listing a property | Owners and landlords create a listing, upload photos (location data stripped), see compliance checks, submit for review; edit, mark under offer / sold / let, withdraw | `server/src/routes/listings.ts` |
| Review before publishing | Private listings wait in an admin queue; admins approve, request changes with a reason, mark ownership verified | `server/src/routes/admin.ts`, `/admin` page |
| Search | Live listings appear in the site's normal search alongside demo listings (labelled), with full-text search and filters on the API | `GET /api/listings` |
| Privacy for sellers | The public never sees a private seller's house number or full postcode; only the street, the district and an approximate location | `services/listings.ts` (`toDTO`) |
| Enquiries & viewings | Buyers request a viewing or ask a question (no account needed); the lister is emailed; both sides continue in the inbox; replies are emailed | `server/src/routes/enquiries.ts`, `/account/inbox` |
| Saved homes & alerts | Saved homes and searches sync to the account (merged from the device on sign-in); search alerts email new matches instantly, daily or weekly | `routes/me.ts`, `jobs/run.ts` |
| Agent feeds | Agencies create a feed key and push their full stock as a BLM v3 file; changes update, missing properties are withdrawn; listings go live once an admin verifies the agency | `server/src/routes/feeds.ts`, `/account/agency` |
| AI room redesign | Signed-in users upload a room photo; OpenAI restyles it while keeping walls, windows and layout; results are labelled AI-generated and kept in "AI designs"; daily limit per user | `server/src/routes/ai.ts`, `services/openai.ts` |
| Listing analytics | With the visitor's consent, anonymous views/saves/enquiries per listing (no IP, no account, random session id) feed the lister's stats | `routes/events.ts` |
| Audit trail | Sign-ins, listing changes, approvals, exports and deletions are logged for admins | `audit_log` table, `/admin` → Audit |

## How it's built

- **Server:** Node 22, TypeScript, [Fastify](https://fastify.dev), `pg`, `zod`. Built to a single bundle with esbuild (`npm run server:build`).
- **Database:** PostgreSQL 14+ (16 recommended). Numbered SQL migrations in `server/migrations/` run automatically when the server starts (`npm run db:migrate` runs them by hand). `db/schema.sql` remains the long-range design (PostGIS, lettings, contractors); new tables move into migrations as features ship.
- **Shared code:** the server reuses the website's own engines, so the compliance checks, the BLM parser and the search that powers alerts behave exactly like the site. API shapes live in `src/lib/apiTypes.ts`.
- **Website integration:** `src/lib/api.ts` (client), `src/lib/server.tsx` (detects the server, signed-in user, saved sync), `src/lib/listingAdapter.ts` (server listing → the site's `Property`), pages in `src/pages/Account.tsx` and `src/pages/Admin.tsx`.
- **Storage:** photos and AI images on local disk (a persistent disk on the host) or any S3-compatible bucket such as Cloudflare R2 (`STORAGE_DRIVER=s3`).
- **Email:** [Resend](https://resend.com). Without a key, emails are written to the server log so every flow still works in development.
- **AI images:** OpenAI image editing (`gpt-image-1` by default, configurable). The key stays on the server.

## Security and privacy

- Passwords: scrypt (memory-hard), 10+ characters, common passwords refused; login errors never reveal whether an email is registered.
- Sessions: random tokens in `HttpOnly`, `SameSite=Lax`, `Secure` cookies; only a SHA-256 of each token is stored. Resetting a password signs out every device.
- Cross-site request protection: state-changing requests must come from the site itself (Origin check) as well as SameSite cookies.
- Rate limits on sign-in, registration, password reset, enquiries, uploads and AI.
- Uploads: file type detected from the bytes (JPEG, PNG, WebP only), size limit, EXIF/XMP metadata (including GPS) removed before storing.
- Security headers: Content-Security-Policy, HSTS, nosniff, referrer policy, permissions policy.
- Listings: compliance checks (EPC, council tax, tenure, leasehold details, minimum EPC E for lettings, discriminatory wording such as "No DSS", rental bidding) block submission; private listings are reviewed before publishing.
- Enquiries: honeypot field and per-email limits against spam; the lister's contact details are never shown to enquirers; buyers' details go only to the lister.
- AI: explicit consent before a photo is sent to OpenAI (recorded in `consents`); outputs labelled; per-user daily limit; rejected API keys are never logged or stored.
- Analytics: only with consent; no personal data; raw events deleted after 13 months.

## Run it on your computer

```bash
# 1. PostgreSQL 16 running locally, then:
createuser -P streetkey        # password: streetkey
createdb -O streetkey streetkey
createdb -O streetkey streetkey_test

# 2. Install and start
npm install
npm run build                   # builds the website into dist/
npm run server:dev              # API + website on http://localhost:8787 (auto-restarts)

# 3. Make yourself an admin
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' npm run db:seed
```

For website work with hot reload, run `npm run dev` (Vite) alongside `npm run server:dev` and set `VITE_API_URL=http://localhost:8787` in `.env.local`.

Tests: `npm test` (engines) and `npm run server:test` (API against a real `streetkey_test` database). GitHub Actions runs both on every push (`.github/workflows/ci.yml`).

## Put it live on Render (recommended)

`render.yaml` describes everything: the web service (website + API), a PostgreSQL database and an hourly job for search alerts and clean-up. Frankfurt is the closest Render region to the UK.

1. Create an account at [render.com](https://render.com) and connect your GitHub account.
2. **New → Blueprint**, choose `alisalaqs-hub/Alis-test-dashboard-`. Render reads `render.yaml`.
3. Fill in the values it asks for:
   - `PUBLIC_URL`: the address of the site, e.g. `https://streetkey.onrender.com` (later your own domain).
   - `OPENAI_API_KEY`: from platform.openai.com → API keys (starts with `sk-`). Set a monthly spending limit there.
   - `RESEND_API_KEY` and `EMAIL_FROM`: from resend.com after verifying your domain (e.g. `Streetkey <hello@streetkey.co.uk>`).
   - `ADMIN_EMAIL`: your email.
4. Deploy. When it's live, open the service's **Shell** and run once:
   `ADMIN_PASSWORD='a long passphrase' npm run db:seed:prod`
5. Sign in at `/#/admin` to review listings and verify agencies.
6. Custom domain: Render → Settings → Custom domains; add the DNS records it shows at your registrar; then update `PUBLIC_URL`.

Rough running costs at launch: web service and disk, database and the hourly job together typically come to tens of pounds a month on Render's paid starter plans. OpenAI charges per image (pennies each at medium quality) and Resend has a free tier for low volumes. Check each provider's current pricing.

**Other hosts:** the `Dockerfile` runs the same service anywhere (Fly.io, Railway, a VPS). Point `DATABASE_URL` at any PostgreSQL 14+ and set the same variables as `.env.example`.

**GitHub Pages** keeps working as a free static demo of the site; the account features there say they need the live site.

## Settings

Every setting is listed with an explanation in `.env.example`. The essentials in production are `DATABASE_URL`, `PUBLIC_URL`, `RESEND_API_KEY`, `EMAIL_FROM` and `OPENAI_API_KEY`.

## API summary

All endpoints are JSON under `/api`. Errors look like `{ "error": { "code", "message", "fields" } }` with messages written for people.

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/health` | anyone | Server and feature status |
| `POST /api/auth/register` · `login` · `logout` · `verify` · `forgot` · `reset` · `change-password` · `resend-verification`; `GET /api/auth/me` | — | Accounts |
| `PATCH /api/me` · `GET /api/me/export` · `DELETE /api/me` | signed in | Profile, data export, erasure |
| `GET/PUT/DELETE /api/me/saved[/:key]` · `POST /api/me/saved/merge` | signed in | Saved homes |
| `GET/POST /api/me/searches` · `PATCH/DELETE /api/me/searches/:id` | signed in | Saved searches & alerts |
| `GET /api/listings` · `GET /api/listings/:ref` | anyone | Search and view live listings |
| `POST /api/listings` · `PATCH /api/listings/:ref` · `POST …/submit` · `POST …/status` · `DELETE …` | lister | Manage a listing |
| `POST /api/listings/:ref/photos` · `PATCH/DELETE …/photos/:id` · `PUT …/photos/order` | lister | Photos |
| `GET /api/me/listings` · `GET /api/me/listings/:ref/stats` | lister | Dashboard and stats |
| `POST /api/listings/:ref/enquiries` | anyone | Viewing request or question |
| `GET /api/me/inbox` · `GET /api/enquiries/:id` · `POST …/messages` · `PATCH …` | participants | Conversations |
| `POST /api/orgs` · `GET /api/me/orgs` · `GET/POST/DELETE /api/orgs/:id/feed-keys` · `GET /api/orgs/:id/feed-runs` | agency | Agency set-up and feed keys |
| `POST /api/feeds/blm` | feed key | Upload full stock (BLM v3) |
| `GET /api/ai/status` · `POST /api/ai/room-image` · `GET /api/ai/room-images` | signed in | AI room redesign |
| `POST /api/events` | consented visitors | Anonymous listing analytics |
| `GET /api/admin/summary` · `GET /api/admin/listings` · `POST …/approve` · `…/reject` · `…/verify-ownership` · `GET /api/admin/orgs` · `POST /api/admin/orgs/:id/verify` · `GET /api/admin/users` · `POST /api/admin/users/:id/role` · `GET /api/admin/audit` | admin | Operations |

## Not built yet (next steps)

- **Payments** (Stripe) for paid listing upgrades, agency subscriptions and API plans.
- **AI assistant on the server** (Claude) answering questions about a listing from its verified data, replacing the on-device rule-based assistant.
- **Real property data**: HM Land Registry price paid, EPC register, Ofsted schools, TfL/National Rail journey times and flood risk, replacing the demo figures in the intelligence profile.
- **Identity and title checks** for "Verified owner" (an ID-verification provider plus HM Land Registry title lookup).
- **Documents** (EPC certificates, floor plans, leases) with AI extraction, and a map/geo search using PostGIS.
- **Lettings tools** (tenancies, deposits, compliance reminders) from the long-range schema.
