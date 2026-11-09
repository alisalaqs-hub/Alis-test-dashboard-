import { describe, expect, it } from 'vitest';
import { SAMPLE_BLM } from '../../src/data/sampleFeed';
import { untrusted } from '../src/ai/core';
import { q } from '../src/db';
import { migrate } from '../src/migrate';
import { getApp, jpegWithExif, LISTING, makeAdmin, multipart, signUp } from './helpers';

describe('core fixes', () => {
  it('keeps the title when a PATCH leaves it out', async () => {
    const s = await signUp({ accountType: 'owner' });
    const ref = (await s.c.post('/api/listings', LISTING)).json.listing.ref;
    const r = await s.c.patch(`/api/listings/${ref}`, { price: 510000 });
    expect(r.json.listing.title).toBe(LISTING.title);
    expect(r.json.listing.price).toBe(510000);
  });

  it('does not use generic camera file names as alt text', async () => {
    const s = await signUp({ accountType: 'owner' });
    const ref = (await s.c.post('/api/listings', LISTING)).json.listing.ref;
    const app = await getApp();
    const m = multipart([{ field: 'photos', name: 'IMG_1234.jpg', type: 'image/jpeg', data: jpegWithExif() }, { field: 'photos', name: 'rear-garden.jpg', type: 'image/jpeg', data: jpegWithExif() }]);
    const up = await app.inject({ method: 'POST', url: `/api/listings/${ref}/photos`, payload: m.payload, headers: { ...m.headers, cookie: s.c.cookie } });
    const alts = up.json().added.map((a: { alt: string | null }) => a.alt);
    expect(alts).toEqual([null, 'rear garden']);
  });

  it('records price changes that arrive through agent feeds', async () => {
    const agent = await signUp({ accountType: 'agent' });
    const admin = await signUp(); await makeAdmin(admin.email);
    const org = (await agent.c.post('/api/orgs', { name: 'Feed Agency', kind: 'agency' })).json;
    await admin.c.post(`/api/admin/orgs/${org.id}/verify`, { verified: true });
    const key = (await agent.c.post(`/api/orgs/${org.id}/feed-keys`, { label: 'CRM' })).json.key;
    const app = await getApp();
    const send = (body: string) => app.inject({ method: 'POST', url: '/api/feeds/blm', payload: body, headers: { authorization: `Bearer ${key}`, 'content-type': 'text/plain' } });
    await send(SAMPLE_BLM);
    const first = await q<{ ref: string; price: number; source_ref: string }>(`SELECT ref, price, source_ref FROM listings WHERE organisation_id = $1 ORDER BY source_ref LIMIT 1`, [org.id]);
    const oldPrice = String(Math.round(first[0].price));
    // change that listing's price in the feed
    const changed = SAMPLE_BLM.replace(new RegExp(`\\^${oldPrice}\\^`), `^${Math.round(first[0].price) - 10000}^`);
    expect(changed).not.toBe(SAMPLE_BLM);
    await send(changed);
    const audits = await q<{ detail: { via: string; priceFrom: number; priceTo: number } }>(`SELECT detail FROM audit_log WHERE action = 'listing.updated' AND detail->>'via' = 'feed'`);
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].detail.priceTo).toBeLessThan(audits[0].detail.priceFrom);
  });

  it('includes automated assessments in the data export', async () => {
    const s = await signUp();
    const exp = await s.c.get('/api/me/export');
    expect(exp.json.aiAssessments).toMatchObject({ listingReviews: [], enquiryTriage: [] });
  });

  it('wraps untrusted text so delimiters cannot be rebuilt', () => {
    const w = untrusted('note', 'a >><<<> b <<>>>< c >>>>>> d <<<<<<');
    const inner = w.slice(w.indexOf('\n') + 1, w.lastIndexOf('\n'));
    expect(inner).not.toMatch(/<<|>>/);
  });

  it('refuses to run when an applied migration has been edited', async () => {
    await q(`UPDATE schema_migrations SET checksum = 'tampered' WHERE name = '001_init.sql'`);
    await expect(migrate()).rejects.toThrow(/was changed after it was applied/);
    await q(`UPDATE schema_migrations SET checksum = NULL WHERE name = '001_init.sql'`);
    await expect(migrate()).resolves.toBeUndefined();
  });
});
