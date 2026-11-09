/**
 * Listing rules beyond the basic journey: edits to submitted listings (checks, holding scam edits for review),
 * public text fields, photo uploads in batches, alt text, the last photo, dashboard counts, the edit rate limit,
 * AI photo-preview results carried to the upload, and reading stored photo checks while AI is off.
 */
import { describe, expect, it } from 'vitest';
import { q } from '../src/db';
import { on } from '../src/ai/hooks';
import { readPreview, signPreview, bytesHash } from '../src/ai/listing/previewToken';
import type { PhotoAnalysis } from '../src/ai/listing/photos';
import { limits } from '../src/services/ratelimit';
import { client, jpegWithExif, lastMail, LISTING, makeAdmin, multipart, signUp } from './helpers';
import { mockOpenAI, reply } from './openai-mock';

type C = ReturnType<typeof client>;
async function uploadFiles(c: C, ref: string, files: { name: string; data?: Buffer }[], fields: Record<string, string> = {}) {
  const m = multipart(files.map((f) => ({ field: 'photos', name: f.name, type: 'image/jpeg', data: f.data ?? jpegWithExif() })), fields);
  return c.raw('POST', `/api/listings/${ref}/photos`, m.payload, m.headers);
}
/** A distinct tiny JPEG (the bytes differ, so content hashes differ). */
const jpeg = (n: number) => Buffer.concat([jpegWithExif().subarray(0, -2), Buffer.from(`photo-${n}`), Buffer.from([0xff, 0xd9])]);

/** An owner's listing, submitted and approved by an admin (live). */
async function liveListing(over: Record<string, unknown> = {}) {
  const seller = await signUp({ accountType: 'owner' });
  const admin = await signUp(); await makeAdmin(admin.email);
  const ref = (await seller.c.post('/api/listings', { ...LISTING, ...over })).json.listing.ref as string;
  expect((await uploadFiles(seller.c, ref, [{ name: 'front.jpg' }])).status).toBe(201);
  expect((await seller.c.post(`/api/listings/${ref}/submit`)).json.status).toBe('pending');
  expect((await admin.c.post(`/api/admin/listings/${ref}/approve`)).json.status).toBe('live');
  return { ...seller, ref, admin };
}
const statusOf = async (ref: string) => (await q<{ status: string }>('SELECT status FROM listings WHERE ref = $1', [ref]))[0].status;

describe('editing a submitted listing', () => {
  it('refuses an edit that fails a blocking check, whatever the status, and keeps the live text', async () => {
    const { c, ref } = await liveListing();
    const bad = await c.patch(`/api/listings/${ref}`, { description: 'Lovely home. Professionals only, no DSS.' });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe('checks_failed');
    expect(bad.json.error.fields.discrim).toMatch(/discriminatory/);
    const pub = await client().get(`/api/listings/${ref}`);
    expect(pub.json.listing.description).toBe(LISTING.description);
    expect(pub.json.listing.status).toBe('live');
    // a pending listing is held to the same rules
    const other = await signUp({ accountType: 'owner' });
    const ref2 = (await other.c.post('/api/listings', LISTING)).json.listing.ref;
    await uploadFiles(other.c, ref2, [{ name: 'a.jpg' }]);
    await other.c.post(`/api/listings/${ref2}/submit`);
    expect((await other.c.patch(`/api/listings/${ref2}`, { epc: null })).status).toBe(422);
    // drafts can be saved part-done (they're checked when submitted)
    const ref3 = (await other.c.post('/api/listings', LISTING)).json.listing.ref;
    expect((await other.c.patch(`/api/listings/${ref3}`, { description: 'No DSS' })).status).toBe(200);
  });

  it('holds a live listing for review when an edit adds contact details, payment requests or scam wording', async () => {
    const { c, ref, admin } = await liveListing();
    const updates: { ref: string; fields: string[] }[] = [];
    on('listingUpdated', (p) => { if (p.ref === ref) updates.push({ ref: p.ref, fields: p.fields }); });

    // re-saving the whole form unchanged is not an edit
    const own = (await c.get(`/api/listings/${ref}`)).json.listing;
    const same = await c.patch(`/api/listings/${ref}`, { ...LISTING, title: own.title, postcode: own.postcode });
    expect(same.status).toBe(200);
    expect(updates).toHaveLength(0);
    // an ordinary edit stays live, and only the changed column is announced
    const cheaper = await c.patch(`/api/listings/${ref}`, { ...LISTING, price: 515000 });
    expect(cheaper.json.listing.status).toBe('live');
    expect(cheaper.json.held).toBeUndefined();
    expect(updates.at(-1)!.fields).toEqual(['price']);

    const scam = await c.patch(`/api/listings/${ref}`, { description: 'Owner abroad. Pay a £500 holding deposit by bank transfer before viewing. WhatsApp 07700 900777. Keys sent by post.' });
    expect(scam.status).toBe(200);
    expect(scam.json.held).toBe(true);
    expect(scam.json.note).toMatch(/hidden from search until then/);
    expect(scam.json.listing.status).toBe('pending');
    expect(scam.json.listing.features).toEqual(LISTING.features); // fields left out of an edit are kept
    expect(await statusOf(ref)).toBe('pending');
    expect((await client().get(`/api/listings/${ref}`)).status).toBe(404);
    expect((await client().get('/api/listings?q=WhatsApp')).json.total).toBe(0);
    expect(updates.at(-1)!.fields).toEqual(['description']); // announced, so the trust review re-checks it
    const queue = await admin.c.get('/api/admin/listings?status=pending');
    expect(queue.json.items.map((i: { ref: string }) => i.ref)).toContain(ref);
  });

  it('keeps contact details and payment wording out of the public town and street', async () => {
    const s = await signUp({ accountType: 'owner' });
    const town = await s.c.post('/api/listings', { ...LISTING, town: 'Leeds WhatsApp 07700 900123' });
    expect(town.status).toBe(400);
    expect(town.json.error.fields.town).toMatch(/town or area/);
    const street = await s.c.post('/api/listings', { ...LISTING, addressLine: 'Hoe Street pay holding deposit by bank transfer first' });
    expect(street.status).toBe(400);
    expect(street.json.error.fields.addressLine).toMatch(/only the address/);
    const link = await s.c.post('/api/listings', { ...LISTING, town: 'Visit www.example.com' });
    expect(link.status).toBe(400);
    for (const t of ['Walthamstow', 'King’s Lynn', 'Stratford-upon-Avon', 'Ynys Môn']) expect((await s.c.post('/api/listings', { ...LISTING, town: t })).status).toBe(201);
    const ok = await s.c.post('/api/listings', { ...LISTING });
    expect((await s.c.patch(`/api/listings/${ok.json.listing.ref}`, { town: 'Email me at bob@example.com' })).status).toBe(400);
  });

  it('limits edits to 30 a minute per person', async () => {
    const s = await signUp({ accountType: 'owner' });
    const ref = (await s.c.post('/api/listings', LISTING)).json.listing.ref;
    const before = limits.multiplier;
    limits.multiplier = 1;
    try {
      for (let i = 0; i < 30; i++) expect((await s.c.patch(`/api/listings/${ref}`, { price: 500000 + i })).status).toBe(200);
      const over = await s.c.patch(`/api/listings/${ref}`, { price: 400000 });
      expect(over.status).toBe(429);
    } finally { limits.multiplier = before; }
  });
});

describe('photo uploads', () => {
  it('keeps and announces the photos stored before a per-request file limit, and says what to resend', async () => {
    const s = await signUp({ accountType: 'owner' });
    const ref = (await s.c.post('/api/listings', LISTING)).json.listing.ref;
    const created = (await q<{ updated_at: Date }>('SELECT updated_at FROM listings WHERE ref = $1', [ref]))[0].updated_at;
    const announced: string[][] = [];
    on('photosUploaded', (p) => { if (p.ref === ref) announced.push(p.photoIds); });
    const r = await uploadFiles(s.c, ref, Array.from({ length: 13 }, (_, i) => ({ name: `room-${i + 1}.jpg`, data: jpeg(i) })));
    expect(r.status).toBe(201);
    expect(r.json.added).toHaveLength(12);
    expect(r.json.added.map((a: { index: number }) => a.index)).toEqual([...Array(12).keys()]);
    expect(r.json.error.code).toBe('too_many');
    expect(r.json.error.message).toMatch(/up to 12 photos at a time/i);
    expect(announced).toHaveLength(1);
    expect(announced[0]).toHaveLength(12);
    const after = (await q<{ updated_at: Date }>('SELECT updated_at FROM listings WHERE ref = $1', [ref]))[0].updated_at;
    expect(after.getTime()).toBeGreaterThan(created.getTime());
    expect((await s.c.get(`/api/listings/${ref}`)).json.listing.photos).toHaveLength(12);
  });

  it('saves alt text sent with the upload, and refuses contact details or links in alt text', async () => {
    const s = await signUp({ accountType: 'owner' });
    const ref = (await s.c.post('/api/listings', LISTING)).json.listing.ref;
    const meta = JSON.stringify([{ alt: 'Front of the house with a bay window' }, { alt: 'Call 07700 900123 for a viewing' }, null]);
    const r = await uploadFiles(s.c, ref, [{ name: 'a.jpg', data: jpeg(1) }, { name: 'IMG_2041.jpg', data: jpeg(2) }, { name: 'www.agent-site.co.uk.jpg', data: jpeg(3) }], { meta });
    expect(r.status).toBe(201);
    expect(r.json.added.map((a: { alt: string | null }) => a.alt)).toEqual(['Front of the house with a bay window', null, null]);
    expect(r.json.notes.join(' ')).toMatch(/Photo 2: alt text not saved/);
    const id = r.json.added[0].id;
    const bad = await s.c.patch(`/api/listings/${ref}/photos/${id}`, { alt: 'See more at www.example.com' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.fields.alt).toMatch(/only describe the photo/);
    expect((await s.c.patch(`/api/listings/${ref}/photos/${id}`, { alt: 'Living room with a fireplace' })).status).toBe(200);
  });

  it('keeps at least one photo on a submitted listing, and no uploads to a withdrawn one', async () => {
    const { c, ref } = await liveListing();
    const photos = (await c.get(`/api/listings/${ref}`)).json.listing.photos;
    const last = await c.del(`/api/listings/${ref}/photos/${photos[0].id}`);
    expect(last.status).toBe(422);
    expect(last.json.error.fields['photo-min']).toMatch(/at least one photo/);
    await uploadFiles(c, ref, [{ name: 'b.jpg', data: jpeg(9) }]);
    expect((await c.del(`/api/listings/${ref}/photos/${photos[0].id}`)).status).toBe(200);
    await c.post(`/api/listings/${ref}/status`, { status: 'withdrawn' });
    expect((await uploadFiles(c, ref, [{ name: 'c.jpg' }])).status).toBe(409);
  });
});

describe('lister dashboard counts', () => {
  it('leaves enquiries held back as spam out of the counts, and reports them separately', async () => {
    const { c, ref } = await liveListing();
    const buyer = await signUp();
    for (const m of ['Could I view on Saturday?', 'Is there parking?']) {
      expect((await buyer.c.post(`/api/listings/${ref}/enquiries`, { name: 'Sam Buyer', email: buyer.email, kind: 'question', message: m })).status).toBe(201);
    }
    await q(`UPDATE enquiries SET filtered = true WHERE id = (SELECT e.id FROM enquiries e JOIN listings l ON l.id = e.listing_id WHERE l.ref = $1 ORDER BY e.created_at LIMIT 1)`, [ref]);
    const mine = (await c.get('/api/me/listings')).json.items.find((i: { ref: string }) => i.ref === ref);
    expect(mine.stats).toMatchObject({ enquiries: 1, newEnquiries: 1, filtered: 1 });
    const stats = (await c.get(`/api/me/listings/${ref}/stats`)).json;
    expect(stats).toMatchObject({ enquiries: 1, filteredEnquiries: 1 });
    // another lister's listings never appear
    const other = await signUp({ accountType: 'owner' });
    expect((await other.c.get('/api/me/listings')).json.items).toEqual([]);
  });
});

/* ───────── AI photo check: results carried from the preview to the upload ───────── */
const ANALYSIS: PhotoAnalysis = { room: 'kitchen', alt: 'Kitchen with white units and a window', quality: { score: 7, issues: ['dark'] }, features: ['white units'], flags: [] };
const visionReply = (n: number) => reply.json({ photos: Array.from({ length: n }, (_, i) => ({ photo: i + 1, ...ANALYSIS })) });

describe('photo preview results', () => {
  it('signs results for one person and exactly one file, for a limited time', async () => {
    const h = bytesHash(jpeg(1));
    const t = (await signPreview('user-a', h, ANALYSIS))!;
    expect(t).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(await readPreview(t, 'user-a', h)).toEqual(ANALYSIS);
    expect(await readPreview(t, 'user-b', h)).toBeNull();
    expect(await readPreview(t, 'user-a', bytesHash(jpeg(2)))).toBeNull();
    expect(await readPreview(t, 'user-a', h, Date.now() + 25 * 3600_000)).toBeNull();
    // a changed analysis (e.g. flags removed) no longer matches the signature
    const [payload, sig] = t.split('.');
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
    forged.a.flags = [];
    forged.a.room = 'front exterior';
    expect(await readPreview(`${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`, 'user-a', h)).toBeNull();
    expect(await readPreview('nonsense', 'user-a', h)).toBeNull();
  });

  it('stores a previewed result with the upload, so the photo isn’t sent to the AI again', async () => {
    const ai = mockOpenAI({ chat: () => visionReply(1) });
    try {
      const s = await signUp({ accountType: 'owner' });
      const ref = (await s.c.post('/api/listings', LISTING)).json.listing.ref;
      const file = jpeg(42);
      const pm = multipart([{ field: 'photos', name: 'k.jpg', type: 'image/jpeg', data: file }], { consent: 'true' });
      const preview = await s.c.raw('POST', '/api/ai/listing/photos/preview', pm.payload, pm.headers);
      expect(preview.status).toBe(200);
      const token = preview.json.photos[0].token as string;
      expect(token).toBeTruthy();
      expect(ai.calls('chat')).toHaveLength(1);

      // same file + token: stored without another vision call; a different file with the same token is checked as usual
      const up = await uploadFiles(s.c, ref, [{ name: 'k.jpg', data: file }, { name: 'other.jpg', data: jpeg(43) }], { meta: JSON.stringify([{ token }, { token }]) });
      expect(up.status).toBe(201);
      const rows = await q<{ id: string; ai_room: string | null; ai_checked_at: Date | null; alt: string | null; ai_flags: string[] | null }>(
        'SELECT id, ai_room, ai_checked_at, alt, ai_flags FROM listing_photos WHERE id = ANY($1) ORDER BY position', [up.json.added.map((a: { id: string }) => a.id)]);
      expect(rows[0]).toMatchObject({ ai_room: 'kitchen', alt: ANALYSIS.alt, ai_flags: [] });
      expect(rows[0].ai_checked_at).not.toBeNull();
      // the second photo was queued for the background check (one more vision call, for that photo only)
      expect(rows[1].ai_checked_at).not.toBeNull();
      const visionCalls = ai.calls('chat').length;
      expect(visionCalls).toBe(2);

      // uploading only previewed photos queues nothing
      const ref2 = (await s.c.post('/api/listings', LISTING)).json.listing.ref;
      expect((await uploadFiles(s.c, ref2, [{ name: 'k.jpg', data: file }], { meta: JSON.stringify([{ token }]) })).status).toBe(201);
      expect(ai.calls('chat')).toHaveLength(visionCalls);
      expect(await q(`SELECT 1 FROM ai_jobs WHERE subject = $1`, [`listing:${ref2}`])).toHaveLength(0);

      // someone else can't use the token
      const other = await signUp({ accountType: 'owner' });
      const ref3 = (await other.c.post('/api/listings', LISTING)).json.listing.ref;
      const theirs = await uploadFiles(other.c, ref3, [{ name: 'k.jpg', data: file }], { meta: JSON.stringify([{ token }]) });
      expect((await q<{ ai_room: string | null }>('SELECT ai_room FROM listing_photos WHERE id = $1', [theirs.json.added[0].id]))[0].ai_room).toBeNull();
    } finally { ai.restore(); }
  });

  it('shows stored photo checks while AI is off, without using the AI allowance', async () => {
    const s = await signUp({ accountType: 'owner' });
    const ref = (await s.c.post('/api/listings', LISTING)).json.listing.ref;
    const up = await uploadFiles(s.c, ref, [{ name: 'a.jpg' }]);
    await q(`UPDATE listing_photos SET ai_room = 'kitchen', ai_alt = 'Kitchen', ai_quality = '{"score":6,"issues":[]}', ai_features = '{}', ai_flags = '{}', ai_checked_at = now() WHERE id = $1`, [up.json.added[0].id]);
    const r = await s.c.get(`/api/ai/listing/${ref}/photos`);
    expect(r.status).toBe(200);
    expect(r.json.aiEnabled).toBe(false);
    expect(r.json.photos[0].analysis.room).toBe('kitchen');
    expect(await q(`SELECT 1 FROM rate_limits WHERE key = $1`, [`ai.daily:u:${s.user.id}`])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM rate_limits WHERE key = $1`, [`listing.photos_read:u:${s.user.id}`])).toHaveLength(1);
    expect((await client().get(`/api/ai/listing/${ref}/photos`)).status).toBe(401);
    expect((await (await signUp()).c.get(`/api/ai/listing/${ref}/photos`)).status).toBe(403);
  });
});

describe('admin email when a live listing is held', () => {
  it('emails the admin address (sent by the trust review when it takes the listing off the site)', async () => {
    const { config } = await import('../src/config');
    const before = config.adminEmail;
    config.adminEmail = 'moderation@example.com';
    try {
      const { c, ref } = await liveListing();
      const r = await c.patch(`/api/listings/${ref}`, { description: 'Pay the deposit by Western Union before viewing.' });
      expect(r.json.held).toBe(true);
      expect(lastMail('moderation@example.com')?.text).toContain(ref);
    } finally { config.adminEmail = before; }
  });
});

/* ───────── shared rules and helpers (unit) ───────── */
// (Only browser-free modules here: the server type-check can't load the website's client code.)
import { altTextProblem as altProblem, complianceChecks, dataUrlBytes, extractListing, featuresToAdd, isEnforced, placeFieldProblem, repeatsStructuredFact, severityLabel, sizeBatches, streetOnly } from '../../src/engine/listings';

describe('listing rules (unit)', () => {
  it('reads tenure and room counts from portal text (labels first, negation-aware)', () => {
    const portal = 'Flat 3, 12 Example Court\n£325,000\nBEDROOMS ×2 BATHROOMS ×1\nShare of freehold option not available\nTenure: Leasehold\n68 years remaining on the lease';
    expect(extractListing(portal).fields).toMatchObject({ beds: 2, baths: 1, tenure: 'leasehold', leaseYears: 68 });
    expect(extractListing('2 bed flat, 1 bath, no share of freehold, leasehold 120 years remaining').fields).toMatchObject({ beds: 2, baths: 1, tenure: 'leasehold' });
    expect(extractListing('Bedrooms: 4\nBathrooms: 2\nShare of freehold').fields).toMatchObject({ beds: 4, baths: 2, tenure: 'share-of-freehold' });
    expect(extractListing('A 3 bedroom semi-detached house with 2 bathrooms. Freehold.').fields).toMatchObject({ beds: 3, baths: 2, tenure: 'freehold' });
    // Rightmove-style key facts: each label with its value on the next line
    expect(extractListing('PROPERTY TYPE\nFlat\nBEDROOMS\n×2\nBATHROOMS\n×1\nTENURE\nLeasehold').fields).toMatchObject({ beds: 2, baths: 1, tenure: 'leasehold' });
  });

  it('keeps reading the everyday formats: counts before the words, labels before the values', () => {
    const rooms = (s: string) => { const f = extractListing(s).fields; return [f.beds, f.baths]; };
    expect(rooms('3 bedrooms 2 bathrooms')).toEqual([3, 2]);
    expect(rooms('3 bedrooms\n2 bathrooms')).toEqual([3, 2]);
    expect(rooms('3 beds 2 baths 1 reception')).toEqual([3, 2]);
    expect(rooms('3 bed 2 bath semi')).toEqual([3, 2]);
    expect(rooms('3bed 2bath house')).toEqual([3, 2]);
    expect(rooms('2 receptions 3 bedrooms 1 bathroom')).toEqual([3, 1]);
    expect(rooms('BEDROOMS 2 BATHROOMS 1')).toEqual([2, 1]);
    expect(rooms('Bedrooms\n3\nBathrooms\n2')).toEqual([3, 2]);
    expect(rooms('beds: 3 baths: 2')).toEqual([3, 2]);
    expect(rooms('Large double bedroom 2 bathrooms')).toEqual([undefined, 2]);
    // room numbers and measurements aren't counts
    expect(rooms('Bedroom 1: 3.2m x 4.1m\nBedroom 2: 3.0m x 2.9m')).toEqual([undefined, undefined]);
    expect(rooms('3 bedroom house, bedrooms 2 and 3 are doubles')).toEqual([3, undefined]);

    const tenure = (s: string) => extractListing(s).fields.tenure;
    expect(tenure('No onward chain\nLeasehold')).toBe('leasehold');
    expect(tenure('No chain\nFreehold')).toBe('freehold');
    expect(tenure('Leasehold\nParking: not available')).toBe('leasehold');
    expect(tenure('Leasehold, parking not available')).toBe('leasehold');
    expect(tenure('Freehold, garage not included')).toBe('freehold');
    expect(tenure('Leasehold - share of freehold not available')).toBe('leasehold');
    expect(tenure('Not leasehold - freehold')).toBe('freehold');
    expect(tenure('no share of freehold')).toBeUndefined();
    expect(tenure('Freehold not available')).toBeUndefined();
  });

  it('keeps public place fields to place names, and alt text to describing the photo', () => {
    expect(placeFieldProblem('Leeds WhatsApp 07700 900123', 'town')).toMatch(/town or area/);
    expect(placeFieldProblem('Hoe Street pay holding deposit by bank transfer first', 'addressLine')).toMatch(/only the address/);
    expect(placeFieldProblem('Flat 2, 14 Elm Road', 'addressLine')).toBeNull();
    expect(placeFieldProblem('Bury St. Edmunds', 'town')).toBeNull();
    expect(altProblem('Kitchen with white units')).toBeNull();
    expect(altProblem('Call 07700 900123')).toMatch(/only describe the photo/);
    expect(streetOnly('5 Signed Out Street')).toBe('Signed Out Street');
  });

  it('warns about contact details, payment requests and scam wording anywhere the public sees, including the town', () => {
    const base = { listing: 'rent' as const, addressLine: '1 Test Road', town: 'Leeds', postcode: 'LS1 4AP', type: 'flat' as const, tenure: 'leasehold' as const, leaseYears: 100,
      beds: 1, baths: 1, floorArea: 40, price: 900, epc: 'C', councilTax: 'A', serviceChargeAnnual: 900, features: [], photos: ['a'], source: { kind: 'landlord' as const, name: '', licence: '', verified: false } };
    const failing = (over: Partial<typeof base> & { description?: string }) => complianceChecks({ ...base, ...over }, { minPhotos: 1 }).filter((c) => !c.ok && c.id !== 'photos').map((c) => `${c.id}:${c.severity}`);
    expect(failing({ description: 'A bright flat. Email me at bob@example.com.' })).toContain('contact:warn');
    expect(failing({ description: 'Pay the deposit by Western Union before viewing.' })).toContain('payment:warn');
    expect(failing({ description: 'I am abroad so the keys will be posted to you.' })).toContain('scam:warn');
    expect(failing({ description: 'No admin fees and no bidding: the rent is fixed.' })).toEqual([]);
    expect(failing({ description: 'Admin fee £150 applies.' })).toContain('fees:block');
    expect(failing({ photos: [] })).toContain('photo-min:block');
    expect(failing({ town: 'Leeds, no DSS' })).toContain('discrim:block');
  });

  it('never copies structured facts into the saved features', () => {
    for (const line of ['3 bedrooms', '1 bathroom', 'Approx. 90 m² (969 sq ft)', 'Freehold', 'Leasehold, 120 years remaining', 'EPC rating C', 'Council tax band C', 'Studio'])
      expect(repeatsStructuredFact(line)).toBe(true);
    for (const line of ['Garden', 'Two double bedrooms with fitted wardrobes', 'Period features']) expect(repeatsStructuredFact(line)).toBe(false);
    expect(featuresToAdd(['- Garden', '3 bedrooms', 'Freehold', '• Bay window', ''], ['Freehold'])).toEqual(['Garden', 'Bay window']);
  });

  it('splits photo uploads into small requests and labels AI points honestly', () => {
    const MB = 1024 * 1024;
    expect(sizeBatches([1 * MB, 1 * MB, 1 * MB, 1 * MB, 1 * MB], 3.5 * MB, 4)).toEqual([[0, 1, 2], [3, 4]]);
    expect(sizeBatches([0.2 * MB, 0.2 * MB, 0.2 * MB, 0.2 * MB, 0.2 * MB], 3.5 * MB, 4)).toEqual([[0, 1, 2, 3], [4]]);
    expect(sizeBatches([5 * MB, 0.1 * MB], 3.5 * MB, 4)).toEqual([[0], [1]]);
    expect(dataUrlBytes(`data:image/jpeg;base64,${Buffer.from('hello world').toString('base64')}`)).toBe(11);
    expect(severityLabel({ severity: 'block', source: 'ai', enforced: false })).toBe('Likely problem');
    expect(severityLabel({ severity: 'block', source: 'wording', enforced: true })).toBe('Must fix');
    expect(isEnforced({ severity: 'block', source: 'ai' })).toBe(false); // older servers
    expect(isEnforced({ severity: 'block', source: 'checks' })).toBe(true);
  });
});
