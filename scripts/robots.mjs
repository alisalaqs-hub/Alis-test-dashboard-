// robots.txt, written into the built site as a plain file so search engines always get it, even if the
// back end is down (a robots.txt that fails makes Google stop crawling the whole site).
// The same text is served by the Node server (server/src/routes/seo.ts); a test keeps the two in step.
import fs from 'node:fs';

export function robotsTxt(site) {
  const base = String(site ?? '').replace(/\/$/, '');
  return ['User-agent: *', 'Disallow: /api/', 'Disallow: /account', 'Disallow: /admin', 'Disallow: /saved', 'Disallow: /compare', '', ...(base ? [`Sitemap: ${base}/sitemap.xml`, ''] : [])].join('\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  // On Netlify, URL is the site's main address.
  const site = process.env.PUBLIC_URL || process.env.URL || '';
  fs.writeFileSync('dist/robots.txt', robotsTxt(site));
  console.log(`wrote dist/robots.txt${site ? ` (sitemap at ${site}/sitemap.xml)` : ' (no site address known, so no sitemap line)'}`);
}
