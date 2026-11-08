# Streetkey — Going Live

## Stage 1 · Public preview (now)
The site publishes automatically to **GitHub Pages** whenever this repository's default branch changes
(`.github/workflows/deploy.yml`: install → 49 tests → type-check & build → publish; a failing test blocks the release).

**One-time step (repository owner):** GitHub → this repository → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Then open **Actions → Deploy site → Run workflow** (or push any change).

Preview address: `https://alisalaqs-hub.github.io/Alis-test-dashboard-/`

What the preview includes: “Public preview” banner, `noindex` (search engines won't list the demo data), self-hosted fonts (no third-party requests), draft Privacy / Terms / Accessibility pages.

## Stage 1b · The live site with accounts (server)
Accounts, real listings with photos, enquiries, alerts, agent feeds and the AI room designer need the Streetkey server.
It hosts the website and the API at one address. Follow **[08 · The back end](08-backend.md) → Put it live on Render**
(`render.yaml` sets up the web service, database and hourly job). GitHub Pages can stay as a free static demo.

## Stage 2 · Your own domain (e.g. streetkey.co.uk)
1. Check the name: UKIPO trade mark search (classes 9, 35, 36, 37, 42) and Companies House.
2. Buy the domain from any registrar (≈ £10–15/yr for .co.uk).
3. GitHub → Settings → Pages → **Custom domain** → enter `www.yourdomain.co.uk` → Save.
4. At your registrar add DNS records:
   - `CNAME` `www` → `alisalaqs-hub.github.io`
   - `A` records for the bare domain → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
5. When the certificate is issued, tick **Enforce HTTPS**.
(Netlify or Vercel work too: connect the repo; `netlify.toml` is included.)

## Before removing the “Public preview” label
| Item | Owner |
|---|---|
| Company formed; ICO registration (≈ £52/yr) | You |
| Complete [bracketed] details in Privacy/Terms/Accessibility; solicitor review | You + solicitor |
| Replace fictional listings with real ones (agent feeds / verified owner listings) | Dev |
| Connect official data: HM Land Registry Price Paid, EPC register, EA flood, postcodes | Dev |
| QS review of refurbishment rate library | QS consultant |
| Backend: accounts, database, image storage, moderation | Done: see 08-backend; deploy it and set the keys |
| If introducing buyers/tenants for owners: redress scheme + HMRC AML supervision | You + solicitor |
| Professional indemnity & cyber insurance; security test before taking personal data or payments | You |
| Remove `<meta name="robots" content="noindex">` from `index.html`; remove preview banner | Dev |
