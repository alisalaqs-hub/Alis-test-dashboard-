import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pool, q } from '../src/db';
import { historyFor, recordHistory } from '../src/services/history';
import { client, getApp, jpegWithExif, lastMail, LISTING, makeAdmin, multipart, PASSWORD, signUp, tokenIn } from './helpers';
import { mockOpenAI, reply } from './openai-mock';

type Client = ReturnType<typeof client>;

async function upload(c: Client, ref: string) {
  const app = await getApp();
  const m = multipart([{ field: 'photos', name: 'front-elevation.jpg', type: 'image/jpeg', data: jpegWithExif() }]);
  const r = await app.inject({ method: 'POST', url: `/api/listings/${ref}/photos`, payload: m.payload, headers: { ...m.headers, cookie: c.cookie } });
  expect(r.statusCode).toBe(201);
}
let seq = 0;
/** A private seller's listing as a draft with one photo (each with its own description, so none looks like a copy of another). */
async function draft(seller: { c: Client }, overrides: Record<string, unknown> = {}) {
  const r = await seller.c.post('/api/listings', { ...LISTING, description: `A bright family home close to Walthamstow Central (history ${++seq}).`, ...overrides });
  expect(r.status).toBe(201);
  const ref: string = r.json.listing.ref;
  await upload(seller.c, ref);
  return ref;
}
async function admin() { const a = await signUp(); await makeAdmin(a.email); return a; }
/** Draft → submitted → approved by an admin. */
async function live(seller: { c: Client }, adm: { c: Client }, overrides: Record<string, unknown> = {}) {
  const ref = await draft(seller, overrides);
  expect((await seller.c.post(`/api/listings/${ref}/submit`)).json.status).toBe('pending');
  expect((await adm.c.post(`/api/admin/listings/${ref}/approve`)).json.status).toBe('live');
  return ref;
}
const idOf = async (ref: string) => (await q<{ id: string }>('SELECT id FROM listings WHERE ref = $1', [ref]))[0].id;
const eventsOf = async (ref: string) => q<{ kind: string; price: number; old_price: number | null; at: Date }>(
  `SELECT e.kind, e.price, e.old_price, e.at FROM listing_events e JOIN listings l ON l.id = e.listing_id WHERE l.ref = $1 ORDER BY e.at, e.id`, [ref]);
const kindsOf = async (ref: string) => (await eventsOf(ref)).map((e) => e.kind);
const publicHistory = async (ref: string) => (await client().get(`/api/listings/${ref}`)).json.listing.history;

/** A minimal BLM v3 file: one row per [ref, price, status ('0' available, '1' under offer)]. */
function blm(rows: [ref: string, price: number, status?: string][]) {
  const fields = ['AGENT_REF', 'ADDRESS_1', 'ADDRESS_2', 'TOWN', 'POSTCODE1', 'POSTCODE2', 'SUMMARY', 'DESCRIPTION', 'BEDROOMS', 'BATHROOMS', 'PRICE', 'PROP_SUB_ID', 'TENURE_TYPE_ID', 'TRANS_TYPE_ID', 'STATUS_ID'];
  const data = rows.map(([ref, price, status = '0']) => [ref, `${ref.length} Feed Street`, '', 'London', 'E17', '4QH', `Two-bedroom flat ${ref}`, 'A bright flat with a balcony. EPC rating C. Council tax band B.', '2', '1', String(price), '8', '2', '1', status].join('^') + '^');
  return `#HEADER#\nVersion : 3\nEOF : '^'\nEOR : '~'\n#DEFINITION#\n${fields.join('^')}^~\n#DATA#\n${data.join('~\n')}~\n#END#`;
}
async function agency(verified: boolean) {
  const agent = await signUp({ accountType: 'agent' });
  const adm = await admin();
  const org = (await agent.c.post('/api/orgs', { name: `History Agency ${Date.now()}-${++seq}`, kind: 'agency' })).json;
  if (verified) await adm.c.post(`/api/admin/orgs/${org.id}/verify`, { verified: true });
  const key = (await agent.c.post(`/api/orgs/${org.id}/feed-keys`, { label: 'CRM' })).json.key;
  const app = await getApp();
  const send = async (body: string) => { const r = await app.inject({ method: 'POST', url: '/api/feeds/blm', payload: body, headers: { authorization: `Bearer ${key}`, 'content-type': 'text/plain' } }); expect(r.statusCode).toBe(200); return r.json(); };
  const refOf = async (sourceRef: string) => (await q<{ ref: string }>('SELECT ref FROM listings WHERE organisation_id = $1 AND source_ref = $2', [org.id, sourceRef]))[0].ref;
  return { org, adm, send, refOf };
}

describe('listing history', () => {
  it('records first listed, each asking price change and status changes, and shows the public prices and dates only', async () => {
    const seller = await signUp({ accountType: 'owner', name: 'Priya Private-Seller' });
    const adm = await admin();
    const ref = await draft(seller);

    // Changing the price of a draft is not a price change anyone saw.
    expect((await seller.c.patch(`/api/listings/${ref}`, { price: 520_000 })).status).toBe(200);
    expect((await seller.c.post(`/api/listings/${ref}/submit`)).json.status).toBe('pending');
    expect(await kindsOf(ref)).toEqual([]);
    expect((await seller.c.get(`/api/listings/${ref}`)).json.listing.history).toBeNull(); // not on the market yet

    expect((await adm.c.post(`/api/admin/listings/${ref}/approve`)).json.status).toBe('live');
    const first = await publicHistory(ref);
    const row = (await q<{ published_at: Date }>('SELECT published_at FROM listings WHERE ref = $1', [ref]))[0];
    expect(first).toEqual({ firstListedAt: row.published_at.toISOString(), firstListedPrice: 520_000, daysOnMarket: 0, priceChanges: [] });

    // A reduction, the same price saved again (nothing), then an increase.
    const reduced = await seller.c.patch(`/api/listings/${ref}`, { price: 510_000 });
    expect(reduced.status).toBe(200);
    expect(reduced.json.listing.status).toBe('live');
    expect(reduced.json.listing.history.priceChanges).toMatchObject([{ from: 520_000, to: 510_000 }]);
    await seller.c.patch(`/api/listings/${ref}`, { price: 510_000, title: 'Three-bed Victorian terrace with a garden' });
    await seller.c.patch(`/api/listings/${ref}`, { price: 515_000 });

    const h = await publicHistory(ref);
    expect(h.firstListedPrice).toBe(520_000);
    expect(h.priceChanges.map((c: { from: number; to: number }) => [c.from, c.to])).toEqual([[520_000, 510_000], [510_000, 515_000]]);
    // Prices and dates only: no names, addresses, contact details or who made the change.
    expect(Object.keys(h).sort()).toEqual(['daysOnMarket', 'firstListedAt', 'firstListedPrice', 'priceChanges']);
    for (const c of h.priceChanges) {
      expect(Object.keys(c).sort()).toEqual(['at', 'from', 'to']);
      expect(Number.isNaN(Date.parse(c.at))).toBe(false);
    }
    const text = JSON.stringify(h);
    for (const secret of ['14 Elm Road', 'E17 4QH', 'Priya', seller.email, seller.user.id]) expect(text).not.toContain(secret);
    // The same history for the owner, in search results and on the owner's dashboard.
    expect((await seller.c.get(`/api/listings/${ref}`)).json.listing.history).toEqual(h);
    const inSearch = (await client().get('/api/listings?pageSize=200')).json.items.find((i: { ref: string }) => i.ref === ref);
    expect(inSearch.history).toEqual(h);
    expect((await seller.c.get('/api/me/listings')).json.items.find((i: { ref: string }) => i.ref === ref).history).toEqual(h);
    expect((await adm.c.get('/api/admin/listings?status=live')).json.items.find((i: { ref: string }) => i.ref === ref).history).toEqual(h);

    // Under offer, back on the market, under offer again, sold.
    for (const status of ['under_offer', 'live', 'under_offer', 'sold']) expect((await seller.c.post(`/api/listings/${ref}/status`, { status })).json.status).toBe(status);
    const events = await eventsOf(ref);
    expect(events.map((e) => e.kind)).toEqual(['listed', 'price_change', 'price_change', 'under_offer', 'available', 'under_offer', 'sold']);
    expect(events.map((e) => [Number(e.price), e.old_price == null ? null : Number(e.old_price)])).toEqual(
      [[520_000, null], [510_000, 520_000], [515_000, 510_000], [515_000, null], [515_000, null], [515_000, null], [515_000, null]]);
    // A sold listing can still be opened, with its history; status changes themselves aren't part of the public summary.
    const sold = await client().get(`/api/listings/${ref}`);
    expect(sold.status).toBe(200);
    expect(sold.json.listing.history.priceChanges).toHaveLength(2);
    expect(JSON.stringify(sold.json.listing.history)).not.toMatch(/sold|under_offer|available/);
    // Taking a sold listing off the site adds nothing: it left the market when it was sold.
    expect((await seller.c.post(`/api/listings/${ref}/status`, { status: 'withdrawn' })).json.status).toBe('withdrawn');
    expect(await kindsOf(ref)).toHaveLength(7);
  });

  it('counts days on the market without the time a listing was withdrawn, and shows a relisting price change on the day it came back', async () => {
    const seller = await signUp({ accountType: 'owner' });
    const adm = await admin();
    const ref = await live(seller, adm, { addressLine: '21 Relist Road', price: 500_000 });
    const id = await idOf(ref);

    expect((await seller.c.del(`/api/listings/${ref}`)).json.withdrawn).toBe(true);
    expect(await kindsOf(ref)).toEqual(['listed', 'withdrawn']);
    // Relist: back to draft, a lower price while it is off the market, submitted and approved again.
    expect((await seller.c.post(`/api/listings/${ref}/status`, { status: 'draft' })).json.status).toBe('draft');
    expect((await seller.c.patch(`/api/listings/${ref}`, { price: 480_000 })).status).toBe(200);
    expect(await kindsOf(ref)).toEqual(['listed', 'withdrawn']); // nobody saw the new price yet
    expect((await seller.c.post(`/api/listings/${ref}/submit`)).json.status).toBe('pending');
    expect(await kindsOf(ref)).toEqual(['listed', 'withdrawn']);
    expect((await adm.c.post(`/api/admin/listings/${ref}/approve`)).json.status).toBe('live');
    const events = await eventsOf(ref);
    expect(events.map((e) => e.kind)).toEqual(['listed', 'withdrawn', 'relisted', 'price_change']);
    expect(events[3]).toMatchObject({ price: 480_000, old_price: 500_000 });

    // Listed 30 days ago, withdrawn after 10 days, relisted 5 days ago: 15 days on the market.
    await q(`UPDATE listing_events SET at = now() - (CASE kind WHEN 'listed' THEN 30 WHEN 'withdrawn' THEN 20 ELSE 5 END) * interval '1 day' WHERE listing_id = $1`, [id]);
    const h = await publicHistory(ref);
    expect(h.daysOnMarket).toBe(15);
    expect(h.firstListedPrice).toBe(500_000);
    expect(Date.now() - Date.parse(h.firstListedAt)).toBeGreaterThan(29 * 86_400_000); // the first listing date, not the relisting
    expect(h.priceChanges).toMatchObject([{ from: 500_000, to: 480_000 }]);
    expect(JSON.stringify(h)).not.toMatch(/withdrawn|relisted/);

    // Recording again changes nothing.
    await recordHistory([id]);
    await recordHistory([id, id]);
    expect(await kindsOf(ref)).toHaveLength(4);
  });

  it('leaves the history alone while an edited listing is held for review, and records a rejection of a listed home as withdrawn', async () => {
    const seller = await signUp({ accountType: 'owner' });
    const adm = await admin();
    const ref = await live(seller, adm, { addressLine: '8 Held Road', price: 450_000 });

    // An edit that needs a person's check takes the listing off the site; the price change made with it is recorded once.
    const held = await seller.c.patch(`/api/listings/${ref}`, { price: 445_000, description: 'Lovely home. Call me on 07700 900123 to arrange a viewing before it goes.' });
    expect(held.json.held).toBe(true);
    expect(await kindsOf(ref)).toEqual(['listed', 'price_change']);
    // Another price while it is hidden, then approved: the change appears when the listing is back.
    await seller.c.patch(`/api/listings/${ref}`, { price: 440_000, description: 'A lovely home near the park, ready to move into.' });
    expect(await kindsOf(ref)).toEqual(['listed', 'price_change']);
    expect((await adm.c.post(`/api/admin/listings/${ref}/approve`)).json.status).toBe('live');
    const events = await eventsOf(ref);
    expect(events.map((e) => e.kind)).toEqual(['listed', 'price_change', 'price_change']); // no "withdrawn" or "relisted" for a review
    expect(events[2]).toMatchObject({ price: 440_000, old_price: 445_000 });

    // Rejected while live: off the market. Edited, resubmitted and approved: back on it.
    expect((await adm.c.post(`/api/admin/listings/${ref}/reject`, { reason: 'Please add photos of every room.' })).json.status).toBe('rejected');
    expect(await kindsOf(ref)).toEqual(['listed', 'price_change', 'price_change', 'withdrawn']);
    expect((await client().get(`/api/listings/${ref}`)).status).toBe(404);
    await seller.c.patch(`/api/listings/${ref}`, { title: 'Three-bed home with every room photographed' });
    await seller.c.post(`/api/listings/${ref}/submit`);
    await adm.c.post(`/api/admin/listings/${ref}/approve`);
    expect(await kindsOf(ref)).toEqual(['listed', 'price_change', 'price_change', 'withdrawn', 'relisted']);

    // A listing rejected before it was ever public has no history.
    const never = await draft(seller, { addressLine: '9 Never Road' });
    await seller.c.post(`/api/listings/${never}/submit`);
    await adm.c.post(`/api/admin/listings/${never}/reject`, { reason: 'Please add photos of every room.' });
    expect(await kindsOf(never)).toEqual([]);
  });

  it('records agency feed imports: first listed, price changes, under offer, withdrawn and relisted', async () => {
    const a = await agency(true);
    await a.send(blm([['H1', 300_000], ['H2', 410_000, '1']]));
    const h1 = await a.refOf('H1'), h2 = await a.refOf('H2');
    expect(await kindsOf(h1)).toEqual(['listed']);
    expect(await kindsOf(h2)).toEqual(['listed', 'under_offer']); // arrived already under offer

    // H1 reduced; H2 unchanged.
    await a.send(blm([['H1', 290_000], ['H2', 410_000, '1']]));
    expect((await eventsOf(h1)).map((e) => [e.kind, Number(e.price), e.old_price == null ? null : Number(e.old_price)])).toEqual([['listed', 300_000, null], ['price_change', 290_000, 300_000]]);
    expect(await kindsOf(h2)).toEqual(['listed', 'under_offer']);
    // The same file again adds nothing.
    await a.send(blm([['H1', 290_000], ['H2', 410_000, '1']]));
    expect(await kindsOf(h1)).toHaveLength(2);

    // H2 leaves the feed (withdrawn), then comes back cheaper and available.
    await a.send(blm([['H1', 290_000]]));
    expect(await kindsOf(h2)).toEqual(['listed', 'under_offer', 'withdrawn']);
    await a.send(blm([['H1', 290_000], ['H2', 399_000]]));
    expect((await eventsOf(h2)).map((e) => [e.kind, Number(e.price)])).toEqual([['listed', 410_000], ['under_offer', 410_000], ['withdrawn', 410_000], ['relisted', 399_000], ['price_change', 399_000]]);

    // The public sees the same summary for an agency listing: prices and dates.
    const h = await publicHistory(h1);
    expect(h).toMatchObject({ firstListedPrice: 300_000, daysOnMarket: 0, priceChanges: [{ from: 300_000, to: 290_000 }] });
    expect(Object.keys(h).sort()).toEqual(['daysOnMarket', 'firstListedAt', 'firstListedPrice', 'priceChanges']);
  });

  it('starts an unverified agency’s history when its listings are released, and ends a deleted account’s', async () => {
    const a = await agency(false);
    await a.send(blm([['P1', 250_000]]));
    const p1 = await a.refOf('P1');
    expect(await kindsOf(p1)).toEqual([]); // pending: not public yet
    await a.send(blm([['P1', 245_000]]));
    expect(await kindsOf(p1)).toEqual([]);
    expect((await a.adm.c.post(`/api/admin/orgs/${a.org.id}/verify`, { verified: true })).json.released).toBe(1);
    expect((await eventsOf(p1)).map((e) => [e.kind, Number(e.price)])).toEqual([['listed', 245_000]]);

    const seller = await signUp({ accountType: 'owner' });
    const ref = await live(seller, a.adm, { addressLine: '5 Leaving Road' });
    expect((await seller.c.del('/api/me', { password: PASSWORD })).status).toBe(200);
    expect(await kindsOf(ref)).toEqual(['listed', 'withdrawn']);
  });

  it('starts the history when the trust review approves a listing automatically', async () => {
    const isReview = (body: any) => body?.response_format?.json_schema?.name === 'listing_trust_review'; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ai = mockOpenAI({ chat: (body) => (isReview(body) ? reply.json({ risk: 'low', score: 6, flags: [], summary: 'An ordinary family home listing with nothing of concern.', suggestedReason: null }) : { status: 400, error: { message: 'not part of this test' } }) });
    const before = process.env.AI_AUTO_APPROVE_LOW_RISK;
    process.env.AI_AUTO_APPROVE_LOW_RISK = 'true';
    try {
      const seller = await signUp({ accountType: 'owner' });
      await seller.c.post('/api/auth/verify', { token: tokenIn(lastMail(seller.email)!.text) });
      const ref = await draft(seller, { addressLine: '4 Automatic Road', price: 530_000 });
      expect((await seller.c.post(`/api/listings/${ref}/submit`)).json.status).toBe('live');
      expect((await eventsOf(ref)).map((e) => [e.kind, Number(e.price)])).toEqual([['listed', 530_000]]);
      expect(await publicHistory(ref)).toMatchObject({ firstListedPrice: 530_000, priceChanges: [] });
    } finally {
      if (before === undefined) delete process.env.AI_AUTO_APPROVE_LOW_RISK; else process.env.AI_AUTO_APPROVE_LOW_RISK = before;
      ai.restore();
    }
  });

  it('backfills listings that were on the market before history was recorded (migration 016)', async () => {
    const org = (await q<{ id: string }>(`INSERT INTO organisations (name, kind, verified) VALUES ('Backfill Agency', 'agency', true) RETURNING id`))[0].id;
    const add = async (sourceRef: string, status: string, price: number, publishedDaysAgo: number | null, updatedDaysAgo = 0) => (await q<{ id: string; ref: string }>(
      `INSERT INTO listings (ref, organisation_id, source_kind, source_ref, channel, status, address_line, town, postcode, district, property_type, tenure, beds, baths, floor_area, price, published_at, updated_at)
       VALUES ($1, $2, 'agent-feed', $3, 'sale', $4, '1 Old Road', 'London', 'E17 4QH', 'E17', 'flat', 'leasehold', 2, 1, 60, $5,
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() - $6::int * interval '1 day' END, now() - $7::int * interval '1 day') RETURNING id, ref`,
      [`sk-bf${sourceRef.toLowerCase().padEnd(5, '0')}`.slice(0, 10), org, sourceRef, status, price, publishedDaysAgo, updatedDaysAgo]))[0];
    const change = (ref: string, detail: unknown, daysAgo: number) => q(`INSERT INTO audit_log (action, subject, detail, at) VALUES ('listing.updated', $1, $2, now() - $3::int * interval '1 day')`, [`listing:${ref}`, JSON.stringify(detail), daysAgo]);

    const plain = await add('PLAIN', 'live', 300_000, 12);
    const reduced = await add('RDCD', 'live', 280_000, 40);
    await change(reduced.ref, { fields: ['price'], priceFrom: 305_000, priceTo: 300_000 }, 60); // before it was published: not a public change
    await change(reduced.ref, { fields: ['price'], priceFrom: 300_000, priceTo: 290_000, via: 'feed' }, 20);
    await change(reduced.ref, { fields: ['price', 'title'], priceFrom: 290_000, priceTo: 280_000 }, 5);
    await change(reduced.ref, { fields: ['title'] }, 4); // not a price change
    await change(reduced.ref, { fields: ['price'], priceFrom: 'lots', priceTo: '-5' }, 3); // nonsense is ignored, never an error
    await change(reduced.ref, { fields: ['price'], priceFrom: 280_000, priceTo: 280_000 }, 2); // no change
    const sold = await add('SOLD', 'sold', 400_000, 50, 10);
    const offer = await add('OFFER', 'under_offer', 350_000, 9, 2);
    const gone = await add('GONE', 'withdrawn', 320_000, 30, 25);
    const held = await add('HELD', 'pending', 330_000, 7, 1); // back in the review queue after an edit
    const fresh = await add('FRESH', 'pending', 310_000, null); // never published
    const ids = [plain, reduced, sold, offer, gone, held, fresh].map((l) => l.id);

    // Run the backfill part of the migration again on these listings alone.
    const sql = fs.readFileSync(path.resolve('server/migrations/016_listing_history.sql'), 'utf8');
    const backfill = sql.slice(sql.indexOf('-- Listings that have already been on the market'), sql.indexOf('-- ───────────── Alerts'));
    expect(backfill.match(/INSERT INTO listing_events/g)).toHaveLength(3);
    await q('DELETE FROM listing_events');
    await pool.query(backfill);

    const of = async (l: { ref: string }) => (await eventsOf(l.ref)).map((e) => [e.kind, Number(e.price), e.old_price == null ? null : Number(e.old_price)]);
    expect(await of(plain)).toEqual([['listed', 300_000, null]]);
    expect(await of(reduced)).toEqual([['listed', 300_000, null], ['price_change', 290_000, 300_000], ['price_change', 280_000, 290_000]]);
    expect(await of(sold)).toEqual([['listed', 400_000, null], ['sold', 400_000, null]]);
    expect(await of(offer)).toEqual([['listed', 350_000, null], ['under_offer', 350_000, null]]);
    expect(await of(gone)).toEqual([['listed', 320_000, null], ['withdrawn', 320_000, null]]);
    expect(await of(held)).toEqual([['listed', 330_000, null]]);
    expect(await of(fresh)).toEqual([]);

    const h = await historyFor(ids);
    expect(h.get(plain.id)).toMatchObject({ firstListedPrice: 300_000, daysOnMarket: 12, priceChanges: [] });
    expect(h.get(reduced.id)).toMatchObject({ firstListedPrice: 300_000, daysOnMarket: 40, priceChanges: [{ from: 300_000, to: 290_000 }, { from: 290_000, to: 280_000 }] });
    expect(h.get(sold.id)).toMatchObject({ daysOnMarket: 40 }); // listed 50 days ago, sold 10 days ago
    expect(h.get(gone.id)).toMatchObject({ daysOnMarket: 5 });
    expect(h.has(fresh.id)).toBe(false);

    // The backfilled history is where each listing stands now: recording again adds nothing.
    const count = async () => (await q<{ n: number }>('SELECT count(*)::int n FROM listing_events WHERE listing_id = ANY($1)', [ids]))[0].n;
    const n = await count();
    await recordHistory(ids);
    expect(await count()).toBe(n);
  });
});
