// Accessibility audit: run `npm run build && npx vite preview --port 4173` first, then `npm run a11y`.
// Injects axe-core on every route (desktop/mobile; the site has one daylight theme) and reports WCAG 2.2 A/AA violations.
// Against the live server (signed-in pages too):
//   A11Y_BASE=http://localhost:8787 A11Y_EMAIL=admin@example.com A11Y_PASSWORD='…' npm run a11y
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const path = require('path');
const AXE = path.resolve('node_modules/axe-core/axe.min.js');
const BASE = (process.env.A11Y_BASE || 'http://localhost:4173').replace(/\/$/, '');
const SIGNED_IN = ['account', 'account/listings', 'account/inbox', 'account/searches', 'account/designs', 'account/privacy', 'account/agency', 'admin'];
const routes = [...(process.env.A11Y_EMAIL ? SIGNED_IN : ['account', 'admin']), '', 'search?q=Croydon', 'property/wal-001', 'property/wal-001/intelligence', 'my-home', 'prices?q=Croydon', 'list', 'import', 'sources', 'studio', 'estimate', 'invest', 'owner', 'agents', 'landlord', 'developer', 'marketplace', 'automation', 'enterprise', 'compare', 'saved', 'privacy', 'terms', 'accessibility', 'list', 'import', 'sources'];
(async () => {
  const b = await chromium.launch();
  const summary = {};
  for (const scheme of ['light']) for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const ctx = await b.newContext({ viewport: vp, colorScheme: scheme, reducedMotion: 'reduce', bypassCSP: true }); // the live server's CSP blocks injected scripts (as it should)
    if (process.env.A11Y_EMAIL) { const r = await ctx.request.post(BASE + '/api/auth/login', { data: { email: process.env.A11Y_EMAIL, password: process.env.A11Y_PASSWORD } }); if (!r.ok()) throw new Error('A11Y login failed'); }
    const p = await ctx.newPage();
    for (const r of routes) {
      await p.goto(BASE + '/#/' + r); await p.waitForTimeout(r.startsWith('account') || r === 'admin' ? 900 : 450);
      await p.addScriptTag({ path: AXE });
      const res = await p.evaluate(async () => // WCAG 1.4.3 exempts logotypes ("text that is part of a logo or brand name has no contrast requirement"),
      // so the orange "key" in the streetkey wordmark is excluded. All other text is checked.
      await window.axe.run({ include: [document], exclude: [['.wordmark .k']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
      for (const v of res.violations) {
        const k = `${v.id} [${v.impact}]`;
        summary[k] = summary[k] || { help: v.help, where: new Set(), samples: [] };
        summary[k].where.add(`${scheme}/${vp.width}/${r || 'home'}`);
        if (summary[k].samples.length < 4) summary[k].samples.push(v.nodes[0].target.join(' ') + ' :: ' + (v.nodes[0].failureSummary || '').split('\n').slice(1, 2).join(' ').slice(0, 160));
      }
    }
    await ctx.close();
  }
  for (const [k, v] of Object.entries(summary)) { console.log(`\n${k} — ${v.help} (${v.where.size} page-views)`); console.log('  e.g. ' + [...v.where].slice(0, 4).join(', ')); v.samples.forEach((s) => console.log('   · ' + s)); }
  if (!Object.keys(summary).length) console.log('NO VIOLATIONS');
  await b.close();
})();
