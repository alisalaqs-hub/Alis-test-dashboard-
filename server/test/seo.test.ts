/** What search engines are given: robots.txt, and a sitemap of real pages only. */
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { outbox } from '../src/services/email';
import { q } from '../src/db';
import { client, LISTING, signUp } from './helpers';

describe('robots.txt and the sitemap', () => {
  it('robots.txt keeps private areas out and points at the sitemap', async () => {
    const r = await client().get('/robots.txt');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/plain/);
    expect(r.body).toContain('Disallow: /api/');
    expect(r.body).toContain('Disallow: /account');
    expect(r.body).toContain(`Sitemap: ${config.publicUrl}/sitemap.xml`);
  });

  it('lists fixed pages, sold-price places and live listings, and nothing that is not public', async () => {
    const seller = await signUp();
    const live = (await seller.c.post('/api/listings', { ...LISTING, town: 'St Albans' })).json.listing.ref as string;
    const draft = (await seller.c.post('/api/listings', { ...LISTING, title: 'Unfinished draft of a listing', addressLine: '9 Oak Road' })).json.listing.ref as string;
    const rental = (await seller.c.post('/api/listings', { ...LISTING, channel: 'rent', price: 1650, title: 'Two-bed flat to rent near the park', addressLine: '3 Park View', town: 'Leeds', postcode: 'LS6 2AB' })).json.listing.ref as string;
    await q(`UPDATE listings SET status = 'live', published_at = now() WHERE ref = ANY($1)`, [[live, rental]]);

    const r = await client().get('/sitemap.xml');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/xml/);
    const locs = [...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(config.publicUrl, ''));
    expect(locs).toEqual(expect.arrayContaining(['/', '/prices', '/list', '/sold-prices/london', '/sold-prices/newcastle-upon-tyne']));
    expect(locs).toEqual(expect.arrayContaining([`/property/${live}`, `/property/${rental}`, '/for-sale/st-albans', '/to-rent/leeds', '/sold-prices/st-albans']));
    expect(locs).not.toContain(`/property/${draft}`);
    expect(locs).not.toContain('/for-sale/leeds');   // only a rental there
    expect(locs.some((l) => /account|admin|api\//.test(l))).toBe(false);
    expect(new Set(locs).size).toBe(locs.length);     // no page twice
    expect(r.body).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  });

  it('emails link to clean page addresses', async () => {
    const before = outbox.length;
    const person = await signUp();
    const mail = outbox.slice(before).find((m) => m.to === person.email && m.template === 'verify');
    expect(mail?.text).toContain(`${config.publicUrl}/account/verify?token=`);
    expect(mail?.text).not.toContain('/#/');
  });
});
