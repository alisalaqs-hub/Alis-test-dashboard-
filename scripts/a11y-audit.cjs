// Accessibility audit: run `npm run build && npx vite preview --port 4173` first, then `npm run a11y`.
// Injects axe-core on every route (light/dark, desktop/mobile) and reports WCAG 2.2 A/AA violations.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const path = require('path');
const AXE = path.resolve('node_modules/axe-core/axe.min.js');
const routes = ['', 'search?q=Croydon', 'property/wal-001', 'property/wal-001/intelligence', 'my-home', 'prices?q=Croydon', 'list', 'import', 'sources', 'studio', 'estimate', 'invest', 'owner', 'agents', 'landlord', 'developer', 'marketplace', 'automation', 'enterprise', 'compare', 'saved'];
(async () => {
  const b = await chromium.launch();
  const summary = {};
  for (const scheme of ['light', 'dark']) for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const ctx = await b.newContext({ viewport: vp, colorScheme: scheme, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    for (const r of routes) {
      await p.goto('http://localhost:4173/#/' + r); await p.waitForTimeout(450);
      await p.addScriptTag({ path: AXE });
      const res = await p.evaluate(async () => await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
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
