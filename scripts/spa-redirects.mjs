// Writes dist/_redirects so Netlify serves the site for every page address (/property/…, /sold-prices/leeds).
// The list is read from the routes in src/App.tsx, so a new page can't be forgotten. Only the site's own
// pages are listed, never a catch-all, so /api/*, /media/*, /sitemap.xml and /robots.txt always reach
// their functions.
import fs from 'node:fs';

export function spaRedirects(appSource = fs.readFileSync('src/App.tsx', 'utf8')) {
  const first = new Set();
  for (const m of appSource.matchAll(/<Route\s+path="([^"]+)"/g)) {
    const seg = m[1].split('/')[0];
    if (seg && seg !== '*' && !seg.startsWith(':')) first.add(seg);
  }
  return [...first].sort().flatMap((seg) => [`/${seg} /index.html 200`, `/${seg}/* /index.html 200`]).join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  fs.writeFileSync('dist/_redirects', spaRedirects());
  console.log(`wrote dist/_redirects (${spaRedirects().trim().split('\n').length} rules)`);
}
