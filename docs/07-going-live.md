# Streetkey — Going Live

## Stage 1 · The live site on Netlify (accounts, listings, AI)
Accounts, real listings with photos, enquiries, alerts, agent feeds, admin and every AI feature run as Netlify
Functions next to the website. Follow **[08 · The back end](08-backend.md) → Put it live on Netlify**:
import the repository from GitHub (**not** drag-and-drop, which uploads only the website), add Netlify Database
in a London or Frankfurt region, set `OPENAI_API_KEY` (with credit and a monthly limit in your OpenAI account) and
`ADMIN_EMAIL`, deploy, then confirm your admin account. Netlify redeploys automatically on every push to the branch.

The site keeps these safeguards until the checklist below is done: `noindex` (search engines won't list the
example listings), an “Example” label on every example listing and example figure, a footer line saying that
example listings are not homes for sale and estimates are not advice, self-hosted fonts (no third-party
requests), and draft Privacy / Terms / Accessibility pages. The “Public preview” banner across the top of every
page was removed in November 2026 at the owner's request, along with builder's notes on public pages; the
labels and the footer line carry the disclosure instead, so keep them wherever example data is shown.

## Optional · Static preview on GitHub Pages
`.github/workflows/deploy.yml` can publish the website alone (no accounts or AI; everything falls back to the
built-in rules) to `https://alisalaqs-hub.github.io/Alis-test-dashboard-/`. It runs only when started by hand:
**Actions → Deploy site → Run workflow** (one-time: **Settings → Pages → Source: GitHub Actions**).

## Stage 2 · Your own domain (e.g. streetkey.co.uk)
1. Check the name: UKIPO trade mark search (classes 9, 35, 36, 37, 42) and Companies House.
2. Buy the domain from any registrar (≈ £10–15/yr for .co.uk).
3. Netlify → **Domain management → Add a domain** → enter `www.yourdomain.co.uk` and follow the DNS steps it shows (Netlify DNS, or a `CNAME` for `www` at your registrar). Netlify issues the HTTPS certificate automatically.
4. Set `PUBLIC_URL` to `https://www.yourdomain.co.uk` in Netlify's environment variables and redeploy (it's used in emails).

## Before removing the example labels and `noindex`
| Item | Owner |
|---|---|
| Company formed; ICO registration (≈ £52/yr) | You |
| Complete [bracketed] details in Privacy/Terms/Accessibility; solicitor review | You + solicitor |
| Replace fictional listings with real ones (agent feeds / verified owner listings) | Dev |
| Connect official data | Sold prices, house price index, flood risk and postcodes: done. EPC register: add `EPC_API_TOKEN` (free, you). Still to do: schools, journey times, planning (dev) |
| QS review of refurbishment rate library | QS consultant |
| Backend: accounts, database, image storage, moderation, AI | Done: see 08-backend; deploy it and set the keys |
| OpenAI: add credit, set a monthly limit, use a fresh API key | You |
| If introducing buyers/tenants for owners: redress scheme + HMRC AML supervision | You + solicitor |
| Professional indemnity & cyber insurance; security test before taking personal data or payments | You |
| Remove `<meta name="robots" content="noindex">` from `index.html`; remove preview banner | Dev |
