import { describe, expect, it, vi } from 'vitest';
import { blmFile, letRow, saleRow, type BlmRow } from '../../src/engine/blmFixture';
import { isFloorPlanCaption } from '../../src/engine/floorplan';
import { config } from '../src/config';
import { q } from '../src/db';
import { FEED_MAX_BYTES } from '../src/routes/feeds';
import { outbox } from '../src/services/email';
import * as feedReport from '../src/services/feedReport';
import { client, getApp, makeAdmin, signUp } from './helpers';
import { fakeHosts } from './setup';

const TEXT = { 'content-type': 'text/plain' };
type Sent = { status: number; json: any };
let seq = 0;

/** An agency with an owner, a site admin, feed keys ("Branch 1", "Branch 2"…) and both ways of sending a file. */
async function agency(o: { verified?: boolean; keys?: number } = {}) {
  const owner = await signUp({ accountType: 'agent' });
  const siteAdmin = await signUp(); await makeAdmin(siteAdmin.email);
  const name = `Feed Test Agency ${Date.now()}-${++seq}`;
  const id: string = (await owner.c.post('/api/orgs', { name, kind: 'agency' })).json.id;
  if (o.verified !== false) await siteAdmin.c.post(`/api/admin/orgs/${id}/verify`, { verified: true });
  const keys: string[] = [];
  for (let i = 0; i < (o.keys ?? 1); i++) keys.push((await owner.c.post(`/api/orgs/${id}/feed-keys`, { label: `Branch ${i + 1}` })).json.key);
  const app = await getApp();
  const file = (rows: BlmRow[] | string | Buffer) => (Array.isArray(rows) ? blmFile(rows) : rows);
  /** From the agency's software, with a feed key. */
  const send = async (rows: BlmRow[] | string | Buffer, key = keys[0], headers: Record<string, string> = TEXT): Promise<Sent> => {
    const r = await app.inject({ method: 'POST', url: '/api/feeds/blm', payload: file(rows), headers: { authorization: `Bearer ${key}`, ...headers } });
    return { status: r.statusCode, json: r.json() };
  };
  /** By hand, as a signed-in person (the owner unless another is given). */
  const upload = async (rows: BlmRow[] | string | Buffer, who = owner, headers: Record<string, string> = TEXT): Promise<Sent> => {
    const r = await app.inject({ method: 'POST', url: `/api/orgs/${id}/feed-upload`, payload: file(rows), headers: { ...(who.c.cookie ? { cookie: who.c.cookie } : {}), ...headers } });
    return { status: r.statusCode, json: r.json() };
  };
  const join = async (role: 'owner' | 'admin' | 'member') => {
    const person = await signUp();
    await q('INSERT INTO memberships (organisation_id, user_id, role) VALUES ($1, $2, $3)', [id, person.user.id, role]);
    return person;
  };
  return { id, name, owner, siteAdmin, keys, send, upload, join };
}
const stored = (orgId: string) => q<{ id: string; source_ref: string; channel: string; status: string; price: number; price_qualifier: string | null; material_info: Record<string, unknown> }>(
  'SELECT id, source_ref, channel, status, price, price_qualifier, material_info FROM listings WHERE organisation_id = $1 ORDER BY source_ref', [orgId]);
const statuses = async (orgId: string) => Object.fromEntries((await stored(orgId)).map((r) => [r.source_ref, r.status]));
const picturesOf = (orgId: string, sourceRef: string) => q<{ id: string; url: string; alt: string | null }>(
  `SELECT p.id, p.url, p.alt FROM listing_photos p JOIN listings l ON l.id = p.listing_id WHERE l.organisation_id = $1 AND l.source_ref = $2 ORDER BY p.position`, [orgId, sourceRef]);
const reports = (to?: string) => outbox.filter((m) => m.template === 'feed_report' && (!to || m.to === to));

describe('feed import: what the agent sent, and nothing else', () => {
  it('stores each rent as a monthly figure, the price qualifier, and under offer for sold STC, under offer and let agreed', async () => {
    const a = await agency();
    const r = await a.send([
      saleRow('S1', { PRICE_QUALIFIER: '2' }), saleRow('S2', { PRICE_QUALIFIER: '10', STATUS_ID: '1' }), saleRow('S3', { PRICE_QUALIFIER: '5', STATUS_ID: '3' }),
      saleRow('S4', { PRICE_QUALIFIER: '3' }), saleRow('S5', { PRICE_QUALIFIER: '4' }), saleRow('S6'),
      letRow('L1', { PRICE: '300', LET_RENT_FREQUENCY: '0' }), letRow('L2', { PRICE: '3600', LET_RENT_FREQUENCY: '2', STATUS_ID: '5' }),
      letRow('L3', { PRICE: '15000', LET_RENT_FREQUENCY: '3' }), letRow('L4', { PRICE: '1250', LET_RENT_FREQUENCY: '1' }),
      saleRow('X1', { PROP_SUB_ID: '23' }), saleRow('X2', { PRICE_QUALIFIER: '1' }), letRow('X3', { LET_RENT_FREQUENCY: '5' }), letRow('X4', { LET_RENT_FREQUENCY: '' }),
    ]);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ accepted: 10, updated: 0, withdrawn: 0, format: 'BLM 3', note: 'Listings are live.' });
    expect((await stored(a.id)).map((l) => [l.source_ref, l.channel, l.status, l.price, l.price_qualifier])).toEqual([
      ['L1', 'rent', 'live', 1300, 'pcm'],          // £300 a week
      ['L2', 'rent', 'under_offer', 1200, 'pcm'],   // £3,600 a quarter, let agreed
      ['L3', 'rent', 'live', 1250, 'pcm'],          // £15,000 a year
      ['L4', 'rent', 'live', 1250, 'pcm'],
      ['S1', 'sale', 'live', 300000, 'guide'],
      ['S2', 'sale', 'under_offer', 300000, 'offers over'],          // sold subject to contract
      ['S3', 'sale', 'under_offer', 300000, 'offers in region of'],  // under offer
      ['S4', 'sale', 'live', 300000, 'fixed'],
      ['S5', 'sale', 'live', 300000, 'offers over'],
      ['S6', 'sale', 'live', 300000, null],
    ]);
    // the listings that could not be shown truthfully were rejected, each with its reason, and never stored
    const rejected = [
      { ref: 'X1', reason: 'Property type code 23 is not one Streetkey shows (PROP_SUB_ID): it shows terraced, semi-detached and detached houses, flats and bungalows' },
      { ref: 'X2', reason: 'Price on application: Streetkey shows a price on every listing' },
      { ref: 'X3', reason: 'Rent is per person per week (LET_RENT_FREQUENCY 5): Streetkey shows one monthly rent for the whole property' },
      { ref: 'X4', reason: 'Rent frequency not given (LET_RENT_FREQUENCY): Streetkey cannot tell whether the rent is weekly or monthly' },
    ];
    expect(r.json.rejected).toEqual(rejected);
    expect((await q<{ rejected: unknown }>('SELECT rejected FROM feed_runs WHERE organisation_id = $1', [a.id]))[0].rejected).toEqual(rejected);
    // and the public sees them that way
    const shown = (await client().get('/api/listings?pageSize=50')).json.items.filter((l: { agentName: string }) => l.agentName === a.name);
    const pub = Object.fromEntries(shown.map((l: { title: string; price: number; status: string; priceQualifier: string | null; channel: string }) => [`${l.channel}:${l.price}:${l.priceQualifier}`, l.status]));
    expect(pub['rent:1300:pcm']).toBe('live');
    expect(pub['rent:1200:pcm']).toBe('under_offer');
    expect(pub['sale:300000:guide']).toBe('live');
  });

  it('withdraws a listing that turns into one it cannot show, rather than keep showing the old price', async () => {
    const a = await agency();
    await a.send([saleRow('S1'), saleRow('S2')]);
    const r = await a.send([saleRow('S1'), saleRow('S2', { PRICE_QUALIFIER: '1', PRICE: '0' })]);
    expect(r.json).toMatchObject({ accepted: 1, updated: 1, withdrawn: 1 });
    expect(await statuses(a.id)).toEqual({ S1: 'live', S2: 'withdrawn' });
    // back with a price: relisted
    expect((await a.send([saleRow('S1'), saleRow('S2')])).json).toMatchObject({ accepted: 2, updated: 2, withdrawn: 0 });
    expect(await statuses(a.id)).toEqual({ S1: 'live', S2: 'live' });
  });

  it('stores a letting’s deposit, available date and furnishing, on insert and on update', async () => {
    const a = await agency();
    const first = await a.send([letRow('L1', { LET_BOND: '1500', LET_DATE_AVAILABLE: '01/12/2026', LET_FURN_ID: '0' }), letRow('L2'), saleRow('S1', { LET_BOND: '999' })]);
    expect(first.json).toMatchObject({ accepted: 3, rejected: [] });
    const info = async () => Object.fromEntries((await stored(a.id)).map((l) => [l.source_ref, l.material_info]));
    expect(await info()).toEqual({ L1: { letting: { deposit: 1500, availableFrom: '2026-12-01', furnished: 'furnished' } }, L2: {}, S1: {} });

    // something else kept with the listing stays when the feed updates it
    await q(`UPDATE listings SET material_info = material_info || '{"parking": "Permit"}'::jsonb WHERE organisation_id = $1 AND source_ref = 'L1'`, [a.id]);
    const second = await a.send([letRow('L1', { LET_BOND: '1600', LET_DATE_AVAILABLE: 'soon', LET_FURN_ID: '2' }), letRow('L2', { LET_DATE_AVAILABLE: '2027-01-15 00:00:00', LET_FURN_ID: '1' }), saleRow('S1')]);
    expect(second.json).toMatchObject({ accepted: 3, updated: 3 });
    // a date that cannot be read is left out and reported, and the listing still goes in
    expect(second.json.rejected).toEqual([{ ref: 'L1', reason: 'Available date “soon” could not be read (LET_DATE_AVAILABLE): left out', imported: true }]);
    expect(await info()).toEqual({ L1: { parking: 'Permit', letting: { deposit: 1600, furnished: 'unfurnished' } }, L2: { letting: { availableFrom: '2027-01-15', furnished: 'part-furnished' } }, S1: {} });

    // the file no longer gives them: they go
    await a.send([letRow('L1'), letRow('L2'), saleRow('S1')]);
    expect(await info()).toEqual({ L1: { parking: 'Permit' }, L2: {}, S1: {} });
  });

  it('stores a floor plan with the photos under the caption the site knows a floor plan by, and no EPC graph or brochure', async () => {
    const a = await agency();
    const cdn = 'https://images.agency-cdn.example.com';
    const file = (plan = `${cdn}/p1-plan.png`) => [
      saleRow('P1', {
        MEDIA_IMAGE_00: `${cdn}/p1-front.jpg`, MEDIA_IMAGE_TEXT_00: 'Front', MEDIA_IMAGE_01: `${cdn}/p1-kitchen.jpg`, MEDIA_IMAGE_TEXT_01: 'Kitchen',
        MEDIA_IMAGE_60: `${cdn}/p1-epc.png`, MEDIA_IMAGE_TEXT_60: 'EPC', MEDIA_FLOOR_PLAN_00: plan, MEDIA_FLOOR_PLAN_01: `${cdn}/p1-plan-first-floor.png`,
        MEDIA_DOCUMENT_00: `${cdn}/p1-brochure.pdf`, MEDIA_DOCUMENT_50: `${cdn}/p1-epc.pdf`, MEDIA_VIRTUAL_TOUR_00: 'https://tours.example.com/p1',
      }),
      saleRow('P2', { MEDIA_IMAGE_00: 'P2_IMG_00.jpg', MEDIA_FLOOR_PLAN_00: `${cdn}/p2-plan.pdf` }),
      // a plan sent among the images with the caption "Floor plan", and a plan link the server must not fetch
      saleRow('P3', { MEDIA_IMAGE_00: `${cdn}/p3-plan.gif`, MEDIA_IMAGE_TEXT_00: 'Floor plan', MEDIA_FLOOR_PLAN_00: 'https://127.0.0.1/p3.png' }),
    ];
    const r = await a.send(file());
    expect(r.json).toMatchObject({ accepted: 3, leftOut: { epc: 2, documents: 1, virtualTours: 1, notLinks: 1 } });
    expect(r.json.rejected).toEqual([
      { ref: 'P1', reason: 'Streetkey shows one floor plan for each listing: the first was used and 1 more was left out', imported: true },
      { ref: 'P2', reason: 'Floor plan 1 skipped: it is a PDF, and Streetkey shows a floor plan as a picture', imported: true },
      { ref: 'P3', reason: 'Floor plan 1 skipped (127.0.0.1): floor plans must be on a public https web address', imported: true },
    ]);
    const p1 = await picturesOf(a.id, 'P1');
    expect(p1.map((p) => [p.url, p.alt])).toEqual([[`${cdn}/p1-front.jpg`, null], [`${cdn}/p1-kitchen.jpg`, null], [`${cdn}/p1-plan.png`, 'Floor plan']]);
    expect(p1.map((p) => isFloorPlanCaption(p.alt))).toEqual([false, false, true]);
    expect(await picturesOf(a.id, 'P2')).toEqual([]);
    expect((await picturesOf(a.id, 'P3')).map((p) => [p.url, isFloorPlanCaption(p.alt)])).toEqual([[`${cdn}/p3-plan.gif`, true]]);
    // nothing that is not a photo or the plan was stored
    const all = await q<{ url: string }>('SELECT p.url FROM listing_photos p JOIN listings l ON l.id = p.listing_id WHERE l.organisation_id = $1', [a.id]);
    expect(all.filter((p) => /epc|brochure|tour|first-floor|\.pdf/.test(p.url))).toEqual([]);

    // the same file again keeps the stored pictures; a new plan replaces them
    await a.send(file());
    expect((await picturesOf(a.id, 'P1')).map((p) => p.id)).toEqual(p1.map((p) => p.id));
    await a.send(file(`${cdn}/p1-plan-v2.png`));
    expect((await picturesOf(a.id, 'P1')).map((p) => [p.url, p.alt])).toEqual([[`${cdn}/p1-front.jpg`, null], [`${cdn}/p1-kitchen.jpg`, null], [`${cdn}/p1-plan-v2.png`, 'Floor plan']]);
  });

  it('reads a Windows-1252 file as it was written, whatever content type it arrives with', async () => {
    const a = await agency();
    const win1252 = (ref: string) => Buffer.from(blmFile([saleRow(ref, { DESCRIPTION: 'Service charge \xa31,400 a year. The owner\x92s garden \x96 south facing. Leasehold.' })]), 'latin1');
    expect((await a.send(win1252('W1'))).json.accepted).toBe(1);
    expect((await a.upload(win1252('W2'), a.owner, { 'content-type': 'application/octet-stream' })).json.accepted).toBe(1);
    expect((await a.send(Buffer.from(blmFile([saleRow('W1'), saleRow('W3', { DESCRIPTION: 'Service charge £1,400 a year. Leasehold.' })]), 'utf8'), a.keys[0], { 'content-type': 'application/x-blm' })).json.accepted).toBe(2);
    const text = Object.fromEntries((await q<{ source_ref: string; description: string }>('SELECT source_ref, description FROM listings WHERE organisation_id = $1', [a.id])).map((l) => [l.source_ref, l.description]));
    expect(text.W2).toBe('Service charge £1,400 a year. The owner’s garden – south facing. Leasehold.');
    expect(text.W3).toBe('Service charge £1,400 a year. Leasehold.');
  });
});

describe('feed report email', () => {
  it('tells the agency’s owners and admins how many listings were accepted, updated and withdrawn, and every rejected reference with its reason', async () => {
    const a = await agency();
    const admin = await a.join('admin'), member = await a.join('member'), gone = await a.join('owner'), outsider = await signUp();
    await q('UPDATE users SET deleted_at = now() WHERE id = $1', [gone.user.id]);
    await a.send([saleRow('A1'), saleRow('A2')]);
    outbox.length = 0;

    const r = await a.send([saleRow('A1', { PRICE: '295000' }), saleRow('A3'), saleRow('A3', { PRICE: '310000' }), saleRow('X1', { PROP_SUB_ID: '23' }), saleRow('X2', { PRICE_QUALIFIER: '1' })]);
    expect(r.json).toMatchObject({ accepted: 2, updated: 1, withdrawn: 1 });
    expect(reports().map((m) => m.to).sort()).toEqual([a.owner.email, admin.email].sort());
    for (const no of [member, gone, outsider, a.siteAdmin]) expect(reports(no.email)).toEqual([]);
    const mail = reports(a.owner.email)[0];
    expect(mail.subject).toBe(`Feed report for ${a.name}: 2 accepted, 1 withdrawn, 2 not imported`);
    expect(mail.text).toContain(`Streetkey has imported the listing file sent with the feed key “Branch 1” for ${a.name} on `);
    expect(mail.text).toContain('Accepted: 2 (1 new, 1 updated)\nWithdrawn: 1\nNot imported: 2');
    expect(mail.text).toContain('Not imported (2). A listing that is not imported is not shown on Streetkey:\n'
      + 'X1: Property type code 23 is not one Streetkey shows (PROP_SUB_ID): it shows terraced, semi-detached and detached houses, flats and bungalows\n'
      + 'X2: Price on application: Streetkey shows a price on every listing');
    expect(mail.text).toContain('Imported, with something left out (1):\nA3: Listed more than once in this file: the last one was used');
    expect(mail.text).toContain('Withdrawn listings were on Streetkey from an earlier file sent with this feed key');
    expect(mail.text).toContain('http://streetkey.test/account/agency');
    expect(mail.text).not.toMatch(/awaiting verification|—/);
    // and each message is on record
    const logged = await q<{ to_address: string; status: string }>(`SELECT to_address, status FROM emails WHERE template = 'feed_report' AND to_address = ANY($1)`, [[a.owner.email, admin.email]]);
    expect(logged).toHaveLength(4);
  });

  it('names at most 200 listings and says how many more there were', async () => {
    const a = await agency();
    outbox.length = 0;
    const rows = [saleRow('OK1'), ...Array.from({ length: 205 }, (_, i) => saleRow(`R${String(i + 1).padStart(3, '0')}`, { PROP_SUB_ID: '23' }))];
    const r = await a.send(rows);
    expect(r.json).toMatchObject({ accepted: 1 });
    expect(r.json.rejected).toHaveLength(205); // the answer itself is never cut short
    const mail = reports(a.owner.email)[0];
    const named = mail.text.split('\n').filter((l) => /^R\d{3}: Property type code 23/.test(l));
    expect(named).toHaveLength(feedReport.FEED_REPORT_MAX_LINES);
    expect(named[0]).toMatch(/^R001: /);
    expect(named.at(-1)).toMatch(/^R200: /);
    expect(mail.text).toContain('Not imported: 205');
    expect(mail.text).toContain('And 5 more listings not named here: this email lists the first 200.');

    // the limit covers both lists together, rejected listings first
    const issues = [...Array.from({ length: 150 }, (_, i) => ({ ref: `N${i}`, reason: 'Missing price' })), ...Array.from({ length: 100 }, (_, i) => ({ ref: `P${i}`, reason: 'Photo 1 skipped', imported: true }))];
    const both = feedReport.feedReportMail('someone@example.com', { organisationName: 'Agency', via: 'upload', format: 'BLM 3', accepted: 100, updated: 0, withdrawn: 0, issues, leftOut: { epc: 3, documents: 0, virtualTours: 1, notLinks: 2 }, verified: true, at: new Date('2026-11-19T14:05:00Z') });
    expect(both.text.split('\n').filter((l) => /^N\d+: /.test(l))).toHaveLength(150);
    expect(both.text.split('\n').filter((l) => /^P\d+: /.test(l))).toHaveLength(50);
    expect(both.text).toContain('And 50 more listings not named here');
    expect(both.text).toContain('uploaded by hand for Agency on 19 November 2026 at 14:05 (BLM 3).');
    expect(both.text).toContain('Streetkey does not show these yet, so they were left out: 3 energy certificate graphs or documents, 1 virtual tour.');
    expect(both.text).toContain('2 pictures were left out because they were not given as https web addresses.');
    // one more is "1 more listing"
    const one = feedReport.feedReportMail('someone@example.com', { organisationName: 'Agency', via: 'upload', format: 'BLM 3', accepted: 0, updated: 0, withdrawn: 0, issues: issues.slice(0, 150).concat(issues.slice(0, 51)), leftOut: { epc: 0, documents: 0, virtualTours: 0, notLinks: 0 }, verified: true, at: new Date() });
    expect(one.text).toContain('And 1 more listing not named here');
  });

  it('never fails the import when the email cannot be sent', async () => {
    const a = await agency();
    config.email.resendApiKey = 're_test';
    fakeHosts.set('api.resend.com', () => { throw new Error('socket hang up'); });
    try {
      const refused = await a.send([saleRow('E1')]);
      expect(refused.status).toBe(200);
      expect(refused.json).toMatchObject({ accepted: 1 });
      fakeHosts.set('api.resend.com', () => Response.json({ message: 'Internal error' }, { status: 500 }));
      expect((await a.upload([saleRow('E2')])).status).toBe(200);
    } finally { config.email.resendApiKey = ''; fakeHosts.delete('api.resend.com'); }
    expect((await q<{ status: string }>(`SELECT status FROM emails WHERE template = 'feed_report' AND to_address = $1`, [a.owner.email])).map((e) => e.status)).toEqual(['failed', 'failed']);
    // nor when the report cannot even be put together (the recipients cannot be read, say)
    const broken = vi.spyOn(feedReport, 'sendFeedReport').mockRejectedValueOnce(new Error('connection lost'));
    try {
      const r = await a.send([saleRow('E1'), saleRow('E3')]);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ accepted: 2, updated: 1 });
      expect(broken).toHaveBeenCalledTimes(1);
    } finally { broken.mockRestore(); }
    expect(await statuses(a.id)).toEqual({ E1: 'live', E2: 'live', E3: 'live' });
  });
});

describe('uploading a feed file by hand', () => {
  it('is for the agency’s owners and admins, signed in, from the site itself', async () => {
    const a = await agency();
    const admin = await a.join('admin'), member = await a.join('member'), outsider = await signUp();
    const file = [saleRow('H1')];
    expect((await a.upload(file, { ...a.owner, c: client() })).status).toBe(401);
    expect((await a.upload(file, outsider)).status).toBe(404);
    expect((await a.upload(file, member)).status).toBe(403);
    expect(await statuses(a.id)).toEqual({});
    expect((await a.upload(file, a.owner, { ...TEXT, origin: 'https://evil.example' })).json.error.code).toBe('bad_origin');
    expect((await a.upload('AGENT_REF,PRICE\nH1,300000')).json.error).toMatchObject({ code: 'bad_feed' });
    expect(await statuses(a.id)).toEqual({});

    expect((await a.upload(file)).json).toMatchObject({ accepted: 1, updated: 0, withdrawn: 0, note: 'Listings are live.' });
    expect((await a.upload(file, admin)).json).toMatchObject({ accepted: 1, updated: 1 });
    expect((await a.upload(file, a.siteAdmin)).json).toMatchObject({ accepted: 1, updated: 1 });
    // an address that is not an agency
    expect((await a.owner.c.post('/api/orgs/not-an-id/feed-upload', blmFile(file), TEXT)).status).toBe(404);
    expect((await a.siteAdmin.c.post('/api/orgs/0b5c0f0e-1111-4222-8333-444455556666/feed-upload', blmFile(file), TEXT)).status).toBe(404);
  });

  it('runs the same import as a file sent with a feed key', async () => {
    const byKey = await agency(), byHand = await agency();
    const cdn = 'https://images.agency-cdn.example.com';
    const file = [
      saleRow('S1', { PRICE_QUALIFIER: '2', MEDIA_IMAGE_00: `${cdn}/s1.jpg`, MEDIA_FLOOR_PLAN_00: `${cdn}/s1-plan.png`, MEDIA_IMAGE_60: `${cdn}/s1-epc.png` }),
      saleRow('S2', { STATUS_ID: '1' }), saleRow('S2', { STATUS_ID: '3', PRICE: '410000' }),
      letRow('L1', { PRICE: '300', LET_RENT_FREQUENCY: '0', LET_BOND: '1500', LET_DATE_AVAILABLE: '01/12/2026', LET_FURN_ID: '1' }),
      saleRow('X1', { PROP_SUB_ID: '23' }), saleRow('X2', { PRICE_QUALIFIER: '1' }), saleRow('X3', { POSTCODE1: 'XX' }),
    ];
    const key = await byKey.send(file), hand = await byHand.upload(file);
    expect(hand.status).toBe(200);
    expect(hand.json).toEqual(key.json);
    expect(hand.json).toMatchObject({ accepted: 3, updated: 0, withdrawn: 0, leftOut: { epc: 1, documents: 0, virtualTours: 0, notLinks: 0 } });
    const rows = (id: string) => q(`SELECT source_ref, source_kind, channel, status, title, address_line, town, postcode, district, property_type, tenure, beds, baths, floor_area, price, price_qualifier, epc, council_tax,
      features, description, material_info, ownership_declared, published_at IS NOT NULL AS published FROM listings WHERE organisation_id = $1 ORDER BY source_ref`, [id]);
    expect(await rows(byHand.id)).toEqual(await rows(byKey.id));
    expect((await rows(byHand.id)).map((l) => [l.source_ref, l.status, l.price])).toEqual([['L1', 'live', 1300], ['S1', 'live', 300000], ['S2', 'under_offer', 410000]]);
    const pictures = async (id: string) => (await picturesOf(id, 'S1')).map((p) => [p.url, p.alt]);
    expect(await pictures(byHand.id)).toEqual(await pictures(byKey.id));
    expect(await pictures(byHand.id)).toEqual([[`${cdn}/s1.jpg`, null], [`${cdn}/s1-plan.png`, 'Floor plan']]);
    // both are on record as runs, and the listing history is written either way
    const history = (id: string) => q<{ kind: string }>(`SELECT e.kind FROM listing_events e JOIN listings l ON l.id = e.listing_id WHERE l.organisation_id = $1 ORDER BY l.source_ref, e.id`, [id]);
    expect(await history(byHand.id)).toEqual(await history(byKey.id));
    // the report says how each file arrived
    expect(reports(byHand.owner.email).at(-1)!.text).toContain(`Streetkey has imported the listing file uploaded by hand for ${byHand.name} on `);
    expect(reports(byKey.owner.email).at(-1)!.text).toContain('sent with the feed key “Branch 1”');
  });

  it('is one more source: it withdraws only listings uploaded by hand, and a feed key never withdraws those', async () => {
    const a = await agency();
    expect((await a.send([saleRow('K1'), saleRow('K2')])).json).toMatchObject({ accepted: 2, withdrawn: 0 });
    expect((await a.upload([saleRow('H1'), saleRow('H2')])).json).toMatchObject({ accepted: 2, withdrawn: 0 });
    expect(await statuses(a.id)).toEqual({ H1: 'live', H2: 'live', K1: 'live', K2: 'live' });

    // by hand without H2: only H2 goes
    expect((await a.upload([saleRow('H1')])).json).toMatchObject({ accepted: 1, updated: 1, withdrawn: 1 });
    expect(await statuses(a.id)).toEqual({ H1: 'live', H2: 'withdrawn', K1: 'live', K2: 'live' });
    // with the key without K2: only K2 goes, although this is the agency's only working key
    expect((await a.send([saleRow('K1')])).json).toMatchObject({ accepted: 1, withdrawn: 1 });
    expect(await statuses(a.id)).toEqual({ H1: 'live', H2: 'withdrawn', K1: 'live', K2: 'withdrawn' });

    // a listing belongs to the source that sent it last: K1 uploaded by hand is now a hand-uploaded listing
    expect((await a.upload([saleRow('H1'), saleRow('K1')])).json).toMatchObject({ accepted: 2, updated: 2, withdrawn: 0 });
    expect((await a.send([saleRow('K3')])).json).toMatchObject({ accepted: 1, withdrawn: 0 });
    expect((await a.upload([saleRow('H1')])).json).toMatchObject({ withdrawn: 1 });
    expect(await statuses(a.id)).toEqual({ H1: 'live', H2: 'withdrawn', K1: 'withdrawn', K2: 'withdrawn', K3: 'live' });

    // a replacement key takes over the revoked key's listings (K3), never the hand-uploaded one
    const keyId = (await a.owner.c.get(`/api/orgs/${a.id}/feed-keys`)).json.items[0].id;
    await a.owner.c.del(`/api/orgs/${a.id}/feed-keys/${keyId}`);
    const replacement: string = (await a.owner.c.post(`/api/orgs/${a.id}/feed-keys`, { label: 'New CRM key' })).json.key;
    expect((await a.send([saleRow('K4')], replacement)).json).toMatchObject({ accepted: 1, withdrawn: 1 });
    expect(await statuses(a.id)).toEqual({ H1: 'live', H2: 'withdrawn', K1: 'withdrawn', K2: 'withdrawn', K3: 'withdrawn', K4: 'live' });
    // an empty upload by hand withdraws the rest of what was uploaded by hand, and nothing else
    expect((await a.upload(blmFile([]))).json).toMatchObject({ accepted: 0, withdrawn: 1 });
    expect(await statuses(a.id)).toMatchObject({ H1: 'withdrawn', K4: 'live' });
  });

  it('keeps "uploaded by hand" out of the feed keys, and says in the list of runs how each file arrived', async () => {
    const a = await agency();
    await a.upload([saleRow('H1')]);
    await a.send([saleRow('K1')]);
    await a.upload([saleRow('H1')], await a.join('admin'));
    const keys = (await a.owner.c.get(`/api/orgs/${a.id}/feed-keys`)).json.items;
    expect(keys.map((k: { label: string }) => k.label)).toEqual(['Branch 1']);
    // one stand-in row for the agency however many uploads, and it can never be used as a key
    const hand = await q<{ id: string; revoked: boolean }>(`SELECT id, revoked_at IS NOT NULL AS revoked FROM feed_keys WHERE organisation_id = $1 AND prefix = 'upload'`, [a.id]);
    expect(hand).toEqual([{ id: hand[0].id, revoked: true }]);
    const owners = await q<{ source_ref: string; feed_key_id: string }>('SELECT source_ref, feed_key_id FROM listings WHERE organisation_id = $1 ORDER BY source_ref', [a.id]);
    expect(owners.map((o) => [o.source_ref, o.feed_key_id === hand[0].id])).toEqual([['H1', true], ['K1', false]]);
    const runs = (await a.owner.c.get(`/api/orgs/${a.id}/feed-runs`)).json.items;
    expect(runs.map((r: { source: string; keyLabel: string | null; accepted: number }) => [r.source, r.keyLabel, r.accepted])).toEqual([['upload', null, 1], ['key', 'Branch 1', 1], ['upload', null, 1]]);
  });

  it('leaves listings imported before keys were remembered to the feed key, not to an upload by hand', async () => {
    const a = await agency();
    await a.send([saleRow('N1'), saleRow('N2')]);
    await q('UPDATE listings SET feed_key_id = NULL WHERE organisation_id = $1', [a.id]); // as imported before migration 013
    expect((await a.upload([saleRow('H1')])).json).toMatchObject({ accepted: 1, withdrawn: 0 });
    expect((await a.upload([saleRow('H1')])).json).toMatchObject({ accepted: 1, withdrawn: 0 });
    expect(await statuses(a.id)).toEqual({ H1: 'live', N1: 'live', N2: 'live' });
    // the key's next file still withdraws what it dropped
    expect((await a.send([saleRow('N1')])).json).toMatchObject({ accepted: 1, withdrawn: 1 });
    expect(await statuses(a.id)).toEqual({ H1: 'live', N1: 'live', N2: 'withdrawn' });
  });

  it('holds an unverified agency’s upload as pending, and says so in the answer and the email', async () => {
    const a = await agency({ verified: false });
    outbox.length = 0;
    const r = await a.upload([saleRow('U1'), saleRow('U2', { STATUS_ID: '3' })]);
    expect(r.json).toMatchObject({ accepted: 2, note: 'Your agency is awaiting verification, so these listings are pending until an admin approves the agency.' });
    expect(await statuses(a.id)).toEqual({ U1: 'pending', U2: 'pending' });
    const mail = reports(a.owner.email)[0];
    expect(mail.subject).toBe(`Feed report for ${a.name}: 2 accepted, 0 withdrawn, 0 not imported`);
    expect(mail.text).toContain('Your agency is awaiting verification, so the accepted listings are pending until an admin approves the agency.');
    expect(mail.text).not.toContain('Not imported (');
  });

  it('has the same size limit as a file sent with a key, and says what the limit is', async () => {
    const a = await agency();
    const big = `#HEADER#\n#DATA#\n${'x'.repeat(FEED_MAX_BYTES)}`;
    const up = await a.upload(big);
    expect(up.status).toBe(413);
    expect(up.json.error).toEqual({ code: 'feed_too_large', message: 'That file is too large: the limit is 25 MB per upload. Larger agencies send each branch’s stock from their software with its own feed key.' });
    const keyed = await a.send(big);
    expect(keyed.status).toBe(413);
    expect(keyed.json.error.code).toBe('feed_too_large');
    expect(await statuses(a.id)).toEqual({});
  });
});
