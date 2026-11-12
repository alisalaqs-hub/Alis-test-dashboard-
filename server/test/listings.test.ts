import { describe, expect, it } from 'vitest';
import { runAlerts } from '../src/jobs/run';
import { client, jpegWithExif, lastMail, LISTING, makeAdmin, multipart, signUp, tokenIn } from './helpers';
import { getApp } from './helpers';
import fs from 'node:fs';
import path from 'node:path';

async function upload(c: ReturnType<typeof client>, ref: string, data = jpegWithExif()) {
  const app = await getApp();
  const m = multipart([{ field: 'photos', name: 'front-elevation.jpg', type: 'image/jpeg', data }]);
  const r = await app.inject({ method: 'POST', url: `/api/listings/${ref}/photos`, payload: m.payload, headers: { ...m.headers, cookie: c.cookie } });
  return { status: r.statusCode, json: r.json() };
}

describe('listings', () => {
  it('runs the full journey: draft → photos → review → live → enquiry → sold', async () => {
    const seller = await signUp({ accountType: 'owner' });
    const admin = await signUp(); await makeAdmin(admin.email);

    const invalid = await seller.c.post('/api/listings', { ...LISTING, postcode: 'nope', price: -1 });
    expect(invalid.status).toBe(400);
    expect(invalid.json.error.fields.postcode).toBeTruthy();

    const created = await seller.c.post('/api/listings', { ...LISTING, title: null });
    expect(created.status).toBe(201);
    const ref = created.json.listing.ref;
    expect(ref).toMatch(/^sk-[a-z0-9]{7}$/);
    expect(created.json.listing.status).toBe('draft');
    expect(created.json.listing.postcode).toBe('E17 4QH');

    // can't go live without a photo
    const early = await seller.c.post(`/api/listings/${ref}/submit`);
    expect(early.status).toBe(422);
    expect(early.json.error.fields['photo-min']).toBeTruthy();

    // photo upload strips location metadata; non-images are refused
    const up = await upload(seller.c, ref);
    expect(up.status).toBe(201);
    const stored = fs.readFileSync(path.resolve('server/.test-uploads', up.json.added[0].url.replace('/media/', '')));
    expect(stored.includes(Buffer.from('secret-location'))).toBe(false);
    expect(stored[0]).toBe(0xff);
    const bad = await upload(seller.c, ref, Buffer.from('<?php echo 1; ?>'));
    expect(bad.status).toBe(400);

    // other people can't edit it
    const stranger = await signUp();
    expect((await stranger.c.patch(`/api/listings/${ref}`, { price: 1 })).status).toBe(403);

    const submitted = await seller.c.post(`/api/listings/${ref}/submit`);
    expect(submitted.json.status).toBe('pending');
    expect((await client().get(`/api/listings/${ref}`)).status).toBe(404);
    expect((await client().get('/api/listings?q=E17')).json.total).toBe(0);

    // admin review
    const queue = await admin.c.get('/api/admin/listings?status=pending');
    expect(queue.json.items.map((i: { ref: string }) => i.ref)).toContain(ref);
    expect((await seller.c.post(`/api/admin/listings/${ref}/approve`)).status).toBe(403);
    expect((await admin.c.post(`/api/admin/listings/${ref}/approve`)).json.status).toBe('live');
    expect(lastMail(seller.email)!.template).toBe('listing_live');

    // public view hides the house number and full postcode for private sellers
    const pub = await client().get(`/api/listings/${ref}`);
    expect(pub.status).toBe(200);
    expect(pub.json.listing.addressLine).toBe('Elm Road');
    expect(pub.json.listing.postcode).toBe('E17');
    expect(pub.json.listing.source.name).toBe('Private seller');
    expect(pub.json.checks).toBeUndefined();
    const own = await seller.c.get(`/api/listings/${ref}`);
    expect(own.json.listing.addressLine).toBe('14 Elm Road');
    expect(own.json.listing.mine).toBe(true);

    // search
    expect((await client().get('/api/listings?q=E17')).json.total).toBe(1);
    expect((await client().get('/api/listings?q=walthamstow family')).json.total).toBe(1);
    expect((await client().get('/api/listings?maxPrice=400000')).json.total).toBe(0);
    expect((await client().get('/api/listings?channel=rent')).json.total).toBe(0);

    // a buyer enquires; the seller is emailed and replies from the inbox
    const buyer = await signUp();
    const honeypot = await client().post(`/api/listings/${ref}/enquiries`, { name: 'Bot', email: 'bot@example.com', kind: 'question', message: 'spam', website: 'x' });
    expect(honeypot.status).toBe(400);
    const enq = await buyer.c.post(`/api/listings/${ref}/enquiries`, { name: 'Sam Buyer', email: buyer.email, phone: '07700 900123', kind: 'viewing', message: 'Could I view on Saturday?', preferredSlot: 'Sat 10:00' });
    expect(enq.status).toBe(201);
    expect(lastMail(seller.email)!.template).toBe('enquiry_received');
    const inbox = await seller.c.get('/api/me/inbox');
    expect(inbox.json.unread).toBe(1);
    expect(inbox.json.items[0]).toMatchObject({ role: 'lister', name: 'Sam Buyer', phone: '07700 900123', kind: 'viewing' });
    const id = inbox.json.items[0].id;
    expect((await stranger.c.get(`/api/enquiries/${id}`)).status).toBe(403);
    expect((await seller.c.post(`/api/enquiries/${id}/messages`, { body: 'Yes, 10am works.' })).status).toBe(201);
    expect(lastMail(buyer.email)!.template).toBe('enquiry_reply');
    const thread = await buyer.c.get(`/api/enquiries/${id}`);
    expect(thread.json.messages.map((m: { author: string }) => m.author)).toEqual(['enquirer', 'lister']);
    expect(thread.json.contact.email).toBeUndefined();
    expect(thread.json.listing.title).not.toMatch(/14 Elm/); // the buyer never sees the house number
    expect(lastMail(buyer.email)!.subject).not.toMatch(/14 Elm/);

    // lister dashboard
    const mine = await seller.c.get('/api/me/listings');
    expect(mine.json.items[0].stats.enquiries).toBe(1);

    // status changes follow the rules
    expect((await seller.c.post(`/api/listings/${ref}/status`, { status: 'let' })).status).toBe(409);
    expect((await seller.c.post(`/api/listings/${ref}/status`, { status: 'under_offer' })).json.status).toBe('under_offer');
    expect((await seller.c.post(`/api/listings/${ref}/status`, { status: 'sold' })).json.status).toBe('sold');
    expect((await client().get('/api/listings?q=E17')).json.total).toBe(0);
  });

  it('rejects with a reason, and the edited listing goes back to draft', async () => {
    const seller = await signUp({ accountType: 'landlord' });
    const admin = await signUp(); await makeAdmin(admin.email);
    const r = await seller.c.post('/api/listings', { ...LISTING, channel: 'rent', price: 2100, epc: 'F' });
    const ref = r.json.listing.ref;
    await upload(seller.c, ref);
    const blocked = await seller.c.post(`/api/listings/${ref}/submit`);
    expect(blocked.status).toBe(422);
    expect(blocked.json.error.fields['epc-let']).toMatch(/EPC E or better/);
    await seller.c.patch(`/api/listings/${ref}`, { epc: 'C', description: 'No DSS' });
    expect((await seller.c.post(`/api/listings/${ref}/submit`)).json.error.fields.discrim).toBeTruthy();
    await seller.c.patch(`/api/listings/${ref}`, { description: 'Bright flat near the station.' });
    expect((await seller.c.post(`/api/listings/${ref}/submit`)).json.status).toBe('pending');
    expect((await admin.c.post(`/api/admin/listings/${ref}/reject`, { reason: 'Please add photos of every room.' })).json.status).toBe('rejected');
    expect(lastMail(seller.email)!.template).toBe('listing_rejected');
    const own = await seller.c.get(`/api/listings/${ref}`);
    expect(own.json.listing.rejectionReason).toMatch(/every room/);
    await seller.c.patch(`/api/listings/${ref}`, { price: 2050 });
    expect((await seller.c.get(`/api/listings/${ref}`)).json.listing.status).toBe('draft');
  });

  it('saves homes, merges device saves and emails search alerts', async () => {
    const buyer = await signUp();
    await buyer.c.post('/api/auth/verify', { token: tokenIn(lastMail(buyer.email)!.text) });
    await buyer.c.put('/api/me/saved/wal-001');
    const merged = await buyer.c.post('/api/me/saved/merge', { keys: ['cro-002', 'wal-001'] });
    expect(merged.json.keys.sort()).toEqual(['cro-002', 'wal-001']);
    const s = await buyer.c.post('/api/me/searches', { query: 'house in E17', mode: 'buy', alertFrequency: 'instant' });
    expect(s.status).toBe(201);

    // a new matching listing goes live after the search was saved
    const seller = await signUp({ accountType: 'owner' });
    const admin = await signUp(); await makeAdmin(admin.email);
    const ref = (await seller.c.post('/api/listings', { ...LISTING, addressLine: '3 Oak Road' })).json.listing.ref;
    await upload(seller.c, ref);
    await seller.c.post(`/api/listings/${ref}/submit`);
    await admin.c.post(`/api/admin/listings/${ref}/approve`);
    // "As soon as they're listed": the alert goes out with the approval (see alerts.test.ts for the hourly job's side)
    const mail = lastMail(buyer.email)!;
    expect(mail.template).toBe('search_alert');
    expect(mail.text).toContain(ref);
    const later = new Date(Date.now() + 2 * 3600_000);
    expect((await runAlerts(later)).emails).toBe(0); // not sent twice
  });
});
