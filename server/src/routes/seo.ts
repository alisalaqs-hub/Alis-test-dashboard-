/**
 * For search engines: /robots.txt and /sitemap.xml.
 *
 * The sitemap lists what may be found on Google: the fixed pages, every live listing, a for-sale or
 * to-rent page for each town that has live listings, and sold-price pages for the larger towns and
 * cities of England and Wales plus every town with a listing. Example listings are never in it.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { robotsTxt } from '../../../scripts/robots.mjs';
import { slugPlace } from '../../../src/engine/places';
import { config } from '../config';
import { q } from '../db';

const PAGES = ['/', '/prices', '/list', '/floor-plan', '/import', '/my-home', '/estimate', '/studio', '/invest', '/sources', '/data-sources', '/privacy', '/terms', '/accessibility'];
/** Sold prices come from HM Land Registry, which covers England and Wales. */
const PLACES = ['London', 'Birmingham', 'Manchester', 'Leeds', 'Liverpool', 'Sheffield', 'Bristol', 'Newcastle upon Tyne', 'Nottingham', 'Leicester', 'Coventry', 'Bradford', 'Cardiff',
  'Stoke-on-Trent', 'Wolverhampton', 'Plymouth', 'Derby', 'Southampton', 'Swansea', 'Portsmouth', 'Brighton', 'Reading', 'Hull', 'Milton Keynes', 'Northampton', 'Luton', 'Norwich', 'Oxford',
  'Cambridge', 'York', 'Bath', 'Exeter', 'Cheltenham', 'Gloucester', 'Ipswich', 'Peterborough', 'Swindon', 'Bournemouth', 'Poole', 'Blackpool', 'Preston', 'Bolton', 'Stockport', 'Sunderland',
  'Middlesbrough', 'Huddersfield', 'Doncaster', 'Wakefield', 'Warrington', 'Chester', 'Lincoln', 'Worcester', 'Colchester', 'Chelmsford', 'Southend-on-Sea', 'Watford', 'Slough', 'Guildford',
  'Maidstone', 'Canterbury', 'Newport', 'Wrexham', 'Croydon', 'Walthamstow'];
const MAX_URLS = 45_000; // a sitemap file may hold 50,000

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function seoRoutes(app: FastifyInstance) {
  // On Netlify robots.txt is a plain file in the built site (scripts/robots.mjs), so it never depends on the
  // back end. A Node host serves it from here unless the built site already has the file.
  if (!fs.existsSync(path.join(config.siteDir, 'robots.txt'))) {
    app.get('/robots.txt', async (_req, reply) => reply.header('Cache-Control', 'public, max-age=3600').type('text/plain; charset=utf-8').send(robotsTxt(config.publicUrl)));
  }

  app.get('/sitemap.xml', async (_req, reply) => {
    const listings = await q<{ ref: string; channel: 'sale' | 'rent'; town: string; updated_at: Date }>(
      `SELECT ref, channel, town, updated_at FROM listings WHERE status IN ('live', 'under_offer') ORDER BY updated_at DESC LIMIT $1`, [MAX_URLS]);
    const urls: { loc: string; lastmod?: string }[] = PAGES.map((loc) => ({ loc }));
    const towns = { sale: new Map<string, Date>(), rent: new Map<string, Date>() };
    for (const l of listings) {
      const town = slugPlace(l.town.split(',')[0]);
      if (town && !towns[l.channel].has(town)) towns[l.channel].set(town, l.updated_at); // newest first, so this is the latest change
    }
    for (const [town, at] of towns.sale) urls.push({ loc: `/for-sale/${town}`, lastmod: at.toISOString().slice(0, 10) });
    for (const [town, at] of towns.rent) urls.push({ loc: `/to-rent/${town}`, lastmod: at.toISOString().slice(0, 10) });
    for (const place of new Set([...PLACES.map(slugPlace), ...towns.sale.keys(), ...towns.rent.keys()])) urls.push({ loc: `/sold-prices/${place}` });
    for (const l of listings) urls.push({ loc: `/property/${encodeURIComponent(l.ref)}`, lastmod: l.updated_at.toISOString().slice(0, 10) });
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.slice(0, MAX_URLS).map((u) =>
      `  <url><loc>${xml(config.publicUrl + u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`;
    return reply.header('Cache-Control', 'public, max-age=3600').type('application/xml; charset=utf-8').send(body);
  });
}
