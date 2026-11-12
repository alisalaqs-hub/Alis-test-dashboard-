import { describe, expect, it } from 'vitest';
import { emit } from '../src/ai/hooks';
import { config } from '../src/config';
import { q } from '../src/db';
import { INSTANT, sendInstantAlerts } from '../src/jobs/alerts';
import { runAlerts } from '../src/jobs/run';
import { outbox } from '../src/services/email';
import { limits } from '../src/services/ratelimit';
import { client, getApp, jpegWithExif, lastMail, LISTING, makeAdmin, multipart, signUp, tokenIn } from './helpers';
import { mockOpenAI, reply } from './openai-mock';
import { fakeHosts } from './setup';

type Client = ReturnType<typeof client>;
type Person = Awaited<ReturnType<typeof signUp>>;
type Frequency = 'instant' | 'daily' | 'weekly' | 'off';

async function upload(c: Client, ref: string) {
  const app = await getApp();
  const m = multipart([{ field: 'photos', name: 'front-elevation.jpg', type: 'image/jpeg', data: jpegWithExif() }]);
  const r = await app.inject({ method: 'POST', url: `/api/listings/${ref}/photos`, payload: m.payload, headers: { ...m.headers, cookie: c.cookie } });
  expect(r.statusCode).toBe(201);
}
async function verified(opts: { accountType?: string } = {}) {
  const p = await signUp(opts);
  expect((await p.c.post('/api/auth/verify', { token: tokenIn(lastMail(p.email)!.text) })).status).toBe(200);
  return p;
}
async function admin() { const a = await signUp(); await makeAdmin(a.email); return a; }
/** Saves a search with alerts; returns its id. */
async function saveSearch(p: Person, query: string, alertFrequency: Frequency = 'instant') {
  const r = await p.c.post('/api/me/searches', { query, mode: 'buy', alertFrequency });
  expect(r.status).toBe(201);
  return r.json.search.id as string;
}
let seq = 0;
/** A private seller's 3-bed terrace in E17 as a draft with a photo ("house in E17" matches it). */
async function draft(seller: Person, overrides: Record<string, unknown> = {}) {
  const r = await seller.c.post('/api/listings', { ...LISTING, addressLine: `${++seq} Alert Road`, description: `A bright family home close to Walthamstow Central (alerts ${seq}).`, ...overrides });
  expect(r.status).toBe(201);
  const ref: string = r.json.listing.ref;
  await upload(seller.c, ref);
  return ref;
}
const idOf = async (ref: string) => (await q<{ id: string }>('SELECT id FROM listings WHERE ref = $1', [ref]))[0].id;
/** Alert emails recorded for a person (every attempt, whatever became of it). */
const alertCount = async (email: string) => (await q<{ n: number }>(`SELECT count(*)::int n FROM emails WHERE to_address = $1 AND template = 'search_alert'`, [email]))[0].n;
/** Alert emails in the test outbox for a person, oldest first. */
const alertsTo = (email: string) => outbox.filter((m) => m.to === email && m.template === 'search_alert');
const sendsFor = (searchId: string) => q<{ ref: string; via: string }>(
  `SELECT l.ref, a.via FROM search_alert_sends a JOIN listings l ON l.id = a.listing_id WHERE a.saved_search_id = $1 ORDER BY a.sent_at, l.ref`, [searchId]);
const hours = (n: number) => new Date(Date.now() + n * 3600_000);

/** A stand-in for the email provider: answers each alert email as the test says, and remembers the ones it accepted. */
function fakeProvider(answer: (mail: { to: string; subject: string }) => Promise<Response> | Response) {
  const accepted: { to: string; subject: string; text: string }[] = [];
  config.email.resendApiKey = 're_test';
  fakeHosts.set('api.resend.com', async (_url, init) => {
    const m = JSON.parse(String(init!.body)) as { to: string[]; subject: string; text: string };
    const mail = { to: m.to[0], subject: m.subject, text: m.text };
    const r = /new homes? match/.test(mail.subject) ? await answer(mail) : Response.json({ id: 'ok' });
    if (r.ok) accepted.push(mail);
    return r;
  });
  return { accepted, alertsTo: (email: string) => accepted.filter((m) => m.to === email && /new homes? match/.test(m.subject)), restore: () => { config.email.resendApiKey = ''; fakeHosts.delete('api.resend.com'); } };
}

/** A minimal BLM v3 file: one two-bedroom flat for sale in E17 per [ref, price]. */
function blm(rows: [ref: string, price: number][]) {
  const fields = ['AGENT_REF', 'ADDRESS_1', 'ADDRESS_2', 'TOWN', 'POSTCODE1', 'POSTCODE2', 'SUMMARY', 'DESCRIPTION', 'BEDROOMS', 'BATHROOMS', 'PRICE', 'PROP_SUB_ID', 'TENURE_TYPE_ID', 'TRANS_TYPE_ID', 'STATUS_ID'];
  const data = rows.map(([ref, price]) => [ref, `${ref.length} Feed Street`, '', 'London', 'E17', '4QH', `Two-bedroom flat ${ref}`, 'A bright flat with a balcony. EPC rating C. Council tax band B.', '2', '1', String(price), '8', '2', '1', '0'].join('^') + '^');
  return `#HEADER#\nVersion : 3\nEOF : '^'\nEOR : '~'\n#DEFINITION#\n${fields.join('^')}^~\n#DATA#\n${data.join('~\n')}~\n#END#`;
}
async function agency(isVerified: boolean) {
  const agent = await signUp({ accountType: 'agent' });
  const adm = await admin();
  const org = (await agent.c.post('/api/orgs', { name: `Alert Agency ${Date.now()}-${++seq}`, kind: 'agency' })).json;
  if (isVerified) await adm.c.post(`/api/admin/orgs/${org.id}/verify`, { verified: true });
  const key = (await agent.c.post(`/api/orgs/${org.id}/feed-keys`, { label: 'CRM' })).json.key;
  const app = await getApp();
  const send = async (body: string) => { const r = await app.inject({ method: 'POST', url: '/api/feeds/blm', payload: body, headers: { authorization: `Bearer ${key}`, 'content-type': 'text/plain' } }); expect(r.statusCode).toBe(200); return r.json(); };
  const refOf = async (sourceRef: string) => (await q<{ ref: string }>('SELECT ref FROM listings WHERE organisation_id = $1 AND source_ref = $2', [org.id, sourceRef]))[0].ref;
  return { org, adm, send, refOf };
}

describe('instant alerts', () => {
  it('emails "as soon as they’re listed" searches the moment a listing is approved, once, and only people who should hear', async () => {
    const instant = await verified();
    const daily = await verified();
    const off = await verified();
    const unverified = await signUp();
    const deleted = await verified();
    const instantId = await saveSearch(instant, 'house in E17');
    const dailyId = await saveSearch(daily, 'house in E17', 'daily');
    const offId = await saveSearch(off, 'house in E17');
    expect((await off.c.patch(`/api/me/searches/${offId}`, { alertFrequency: 'off' })).json.search.alertFrequency).toBe('off'); // unsubscribed
    await saveSearch(unverified, 'house in E17');
    await saveSearch(deleted, 'house in E17');
    await q('UPDATE users SET deleted_at = now() WHERE email = $1', [deleted.email]);
    const elsewhere = await verified();
    await saveSearch(elsewhere, 'flat in Manchester'); // doesn't match

    const seller = await signUp({ accountType: 'owner' });
    const adm = await admin();
    const ref = await draft(seller);
    const id = await idOf(ref);

    // Waiting for review: nobody hears about it, even if the "published" event were sent for it.
    expect((await seller.c.post(`/api/listings/${ref}/submit`)).json.status).toBe('pending');
    await emit('listingsPublished', { listingIds: [id] });
    expect(await sendInstantAlerts([id])).toMatchObject({ listings: 0, emails: 0 });
    expect(await alertCount(instant.email)).toBe(0);

    // Approved: the instant search hears at once, with the hourly job's own wording.
    expect((await adm.c.post(`/api/admin/listings/${ref}/approve`)).json.status).toBe('live');
    const [mail] = alertsTo(instant.email);
    expect(mail.subject).toBe('1 new home matches “house in E17”');
    expect(mail.text).toContain(`/property/${ref}`);
    expect(mail.text).toContain('3-bed Victorian terrace with garden, £525,000');
    expect(mail.text).toMatch(/Manage alerts: http:\/\/streetkey\.test\/(#\/)?account\/searches/); // whichever form of page address the site uses
    expect(mail.text).not.toMatch(/Alert Road|4QH/); // the private seller's house number, street line and full postcode stay private
    expect(await sendsFor(instantId)).toEqual([{ ref, via: 'instant' }]);
    for (const p of [daily, off, unverified, deleted, elsewhere]) expect(await alertCount(p.email), p.email).toBe(0);

    // The same listing announced again (an edit approved again, a feed sending its stock again): nothing more.
    await emit('listingsPublished', { listingIds: [id] });
    expect(await sendInstantAlerts([id, id])).toMatchObject({ emails: 0, more: false });
    expect(await alertCount(instant.email)).toBe(1);

    // The hourly job skips what was sent instantly, and sends the daily digest when it is due.
    expect((await runAlerts(hours(2))).emails).toBe(0);
    expect(await alertCount(instant.email)).toBe(1);
    expect(await alertCount(daily.email)).toBe(0); // not due yet
    expect((await runAlerts(hours(25))).emails).toBe(1);
    expect(alertsTo(daily.email)).toHaveLength(1);
    expect(alertsTo(daily.email)[0].subject).toBe(mail.subject);
    expect(alertsTo(daily.email)[0].text).toBe(mail.text); // one wording for both paths
    expect(await sendsFor(dailyId)).toEqual([{ ref, via: 'hourly' }]);
    expect((await runAlerts(hours(50))).emails).toBe(0);
    expect(await alertCount(instant.email)).toBe(1);
    expect(await alertCount(daily.email)).toBe(1);
    for (const p of [off, unverified, deleted, elsewhere]) expect(await alertCount(p.email), p.email).toBe(0);
  });

  it('does not alert on a listing that was public before the search was saved, or again after an edit is re-approved', async () => {
    const seller = await signUp({ accountType: 'owner' });
    const adm = await admin();
    const early = await verified();
    await saveSearch(early, 'house in E17');
    const ref = await draft(seller);
    await seller.c.post(`/api/listings/${ref}/submit`);
    await adm.c.post(`/api/admin/listings/${ref}/approve`);
    expect(await alertCount(early.email)).toBe(1);

    const late = await verified();
    await saveSearch(late, 'house in E17'); // saved after the listing went live
    // An edit that needs a check takes the listing off the site; approving it again puts it back.
    const held = await seller.c.patch(`/api/listings/${ref}`, { description: 'Lovely home. Call me on 07700 900123 to arrange a viewing before it goes.' });
    expect(held.json.held).toBe(true);
    await seller.c.patch(`/api/listings/${ref}`, { description: 'A lovely home near the park, ready to move into.' });
    expect((await adm.c.post(`/api/admin/listings/${ref}/approve`)).json.status).toBe('live');
    expect(await alertCount(early.email)).toBe(1); // not again
    expect(await alertCount(late.email)).toBe(0); // it isn't new to the market
    expect((await runAlerts(hours(2))).emails).toBe(0);
  });

  it('stops when its time is up, finishes the email it started, and leaves the rest to the hourly job (which the instant path then never repeats)', async () => {
    const buyers = [await verified(), await verified(), await verified()];
    const searchIds: string[] = [];
    for (const b of buyers) searchIds.push(await saveSearch(b, 'house in E17'));
    const seller = await signUp({ accountType: 'owner' });
    const adm = await admin();
    const ref = await draft(seller);
    const id = await idOf(ref);
    await seller.c.post(`/api/listings/${ref}/submit`);

    // The email provider takes 400 ms an email; the instant path has 250 ms to start work.
    const provider = fakeProvider(async () => { await new Promise((r) => setTimeout(r, 400)); return Response.json({ id: 'ok' }); });
    const before = INSTANT.budgetMs;
    INSTANT.budgetMs = 250;
    try {
      const started = Date.now();
      expect((await adm.c.post(`/api/admin/listings/${ref}/approve`)).json.status).toBe('live');
      expect(Date.now() - started).toBeLessThan(1500); // one email's wait, not three
      const told = buyers.filter((b) => provider.alertsTo(b.email).length === 1);
      expect(told).toHaveLength(1); // the one that was started was finished
      expect(provider.alertsTo(told[0].email)[0].text).toContain(ref);
      const sends = (await Promise.all(searchIds.map(sendsFor))).flat();
      expect(sends).toEqual([{ ref, via: 'instant' }]); // nothing was claimed for the two it didn't get to

      // No time at all: nothing is sent or claimed, and the result says work is left.
      expect(await sendInstantAlerts([id], { budgetMs: -1 })).toMatchObject({ emails: 0, more: true });

      // The hourly job picks up the other two…
      expect((await runAlerts(hours(2))).emails).toBe(2);
      for (const b of buyers) expect(provider.alertsTo(b.email), b.email).toHaveLength(1);
      expect((await Promise.all(searchIds.map(sendsFor))).flat().map((s) => s.via).sort()).toEqual(['hourly', 'hourly', 'instant']);
      // …and neither path sends any of them again.
      INSTANT.budgetMs = before;
      await emit('listingsPublished', { listingIds: [id] });
      expect(await sendInstantAlerts([id])).toMatchObject({ emails: 0 });
      expect((await runAlerts(hours(4))).emails).toBe(0);
      for (const b of buyers) expect(provider.alertsTo(b.email), b.email).toHaveLength(1);
    } finally { INSTANT.budgetMs = before; provider.restore(); }
  });

  it('retries with the hourly job (until it is accepted) when the email provider refuses an alert, and never resends one that may have gone', async () => {
    const refused = await verified();
    const unsure = await verified();
    const refusedId = await saveSearch(refused, 'house in E17');
    const unsureId = await saveSearch(unsure, 'house in E17');
    const seller = await signUp({ accountType: 'owner' });
    const adm = await admin();
    const ref = await draft(seller);
    await seller.c.post(`/api/listings/${ref}/submit`);

    let working = false;
    const provider = fakeProvider((mail) => {
      if (working) return Response.json({ id: 'ok' });
      if (mail.to === refused.email) return Response.json({ message: 'Too many requests' }, { status: 429 }); // turned down: nothing was sent
      throw new Error('socket hang up'); // no answer: it may or may not have gone
    });
    try {
      expect((await adm.c.post(`/api/admin/listings/${ref}/approve`)).json.status).toBe('live');
      expect(provider.alertsTo(refused.email)).toHaveLength(0);
      expect(await sendsFor(refusedId)).toEqual([]); // released, so the hourly job can try again
      expect(await sendsFor(unsureId)).toEqual([{ ref, via: 'instant' }]); // kept: never send it twice
      // Both attempts are on record as failed, so nothing is lost silently.
      const failed = await q<{ to_address: string; error: string }>(`SELECT to_address, error FROM emails WHERE template = 'search_alert' AND status = 'failed' AND to_address = ANY($1) ORDER BY to_address`, [[refused.email, unsure.email]]);
      expect(failed.map((f) => f.to_address).sort()).toEqual([refused.email, unsure.email].sort());
      expect(failed.find((f) => f.to_address === refused.email)!.error).toBe('Too many requests');

      // Still refused at the next hourly run: nothing is sent, and the search stays due for the run after.
      expect(await runAlerts(hours(2))).toMatchObject({ emails: 0, more: true });
      expect(await sendsFor(refusedId)).toEqual([]);

      working = true;
      expect((await runAlerts(hours(3))).emails).toBe(1);
      expect(provider.alertsTo(refused.email)).toHaveLength(1);
      expect(provider.alertsTo(refused.email)[0].text).toContain(ref);
      expect(await sendsFor(refusedId)).toEqual([{ ref, via: 'hourly' }]);
      expect(provider.alertsTo(unsure.email)).toHaveLength(0);
      expect((await runAlerts(hours(5))).emails).toBe(0);
      expect(provider.alertsTo(refused.email)).toHaveLength(1);
      expect(provider.alertsTo(unsure.email)).toHaveLength(0);
    } finally { provider.restore(); }
  });

  it('caps instant emails per person; the hourly job sends what the cap held back', async () => {
    const buyer = await verified();
    const ids = [await saveSearch(buyer, 'house in E17'), await saveSearch(buyer, '3 bed house in E17'), await saveSearch(buyer, 'terraced house in E17 with a garden')];
    const seller = await signUp({ accountType: 'owner' });
    const adm = await admin();
    const ref = await draft(seller);
    await seller.c.post(`/api/listings/${ref}/submit`);

    // The cap counts by the clock hour: don't start within a few seconds of the next one.
    const toNextHour = 3600_000 - (Date.now() % 3600_000);
    if (toNextHour < 5000) await new Promise((r) => setTimeout(r, toNextHour + 50));
    const cap = INSTANT.perPersonPerHour, multiplier = limits.multiplier;
    INSTANT.perPersonPerHour = 2; limits.multiplier = 1;
    try {
      await adm.c.post(`/api/admin/listings/${ref}/approve`);
      expect(await alertCount(buyer.email)).toBe(2);
      expect((await Promise.all(ids.map(sendsFor))).flat()).toHaveLength(2);
      // More listings in the same hour wait for the hourly job too.
      const second = await draft(seller);
      await seller.c.post(`/api/listings/${second}/submit`);
      await adm.c.post(`/api/admin/listings/${second}/approve`);
      expect(await alertCount(buyer.email)).toBe(2);
    } finally { INSTANT.perPersonPerHour = cap; limits.multiplier = multiplier; }

    // One email per search from the hourly job: the search the cap held back gets both listings, the other two only the second.
    expect((await runAlerts(hours(2))).emails).toBe(3);
    expect(await alertCount(buyer.email)).toBe(5);
    const sends = (await Promise.all(ids.map(sendsFor))).flat();
    expect(sends).toHaveLength(6); // 3 searches × 2 listings, each exactly once
    expect(sends.filter((s) => s.via === 'instant')).toHaveLength(2);
    expect((await runAlerts(hours(4))).emails).toBe(0);
  });

  it('alerts when a private seller publishes directly (review switched off)', async () => {
    const buyer = await verified();
    const searchId = await saveSearch(buyer, 'house in E17');
    const seller = await signUp({ accountType: 'owner' });
    const ref = await draft(seller);
    const moderate = config.moderateOwnerListings;
    config.moderateOwnerListings = false;
    try {
      expect((await seller.c.post(`/api/listings/${ref}/submit`)).json.status).toBe('live');
    } finally { config.moderateOwnerListings = moderate; }
    expect(alertsTo(buyer.email).map((m) => m.text).join('\n')).toContain(ref);
    expect(await sendsFor(searchId)).toEqual([{ ref, via: 'instant' }]);
  });

  it('alerts when the trust review approves a listing automatically', async () => {
    const buyer = await verified();
    const searchId = await saveSearch(buyer, 'house in E17');
    const isReview = (body: any) => body?.response_format?.json_schema?.name === 'listing_trust_review'; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ai = mockOpenAI({ chat: (body) => (isReview(body) ? reply.json({ risk: 'low', score: 6, flags: [], summary: 'An ordinary family home listing with nothing of concern.', suggestedReason: null }) : { status: 400, error: { message: 'not part of this test' } }) });
    const before = process.env.AI_AUTO_APPROVE_LOW_RISK;
    process.env.AI_AUTO_APPROVE_LOW_RISK = 'true';
    try {
      const seller = await verified({ accountType: 'owner' });
      const ref = await draft(seller);
      expect((await seller.c.post(`/api/listings/${ref}/submit`)).json.status).toBe('live');
      expect(await sendsFor(searchId)).toEqual([{ ref, via: 'instant' }]);
      expect(alertsTo(buyer.email).at(-1)!.text).toContain(ref);
    } finally {
      if (before === undefined) delete process.env.AI_AUTO_APPROVE_LOW_RISK; else process.env.AI_AUTO_APPROVE_LOW_RISK = before;
      ai.restore();
    }
  });

  it('alerts on agency feed imports (one email for the file, nothing when the stock is sent again) and when an agency is verified', async () => {
    const buyer = await verified();
    const searchId = await saveSearch(buyer, 'flat in E17');
    const a = await agency(true);
    await a.send(blm([['F1', 300_000], ['F2', 310_000]]));
    const f1 = await a.refOf('F1'), f2 = await a.refOf('F2');
    const first = alertsTo(buyer.email);
    expect(first).toHaveLength(1);
    expect(first[0].subject).toBe('2 new homes match “flat in E17”');
    expect(first[0].text).toContain(f1);
    expect(first[0].text).toContain(f2);

    // The whole stock again, with one new flat: only the new one is emailed.
    await a.send(blm([['F1', 300_000], ['F2', 310_000]]));
    expect(alertsTo(buyer.email)).toHaveLength(1);
    await a.send(blm([['F1', 300_000], ['F2', 310_000], ['F3', 320_000]]));
    const f3 = await a.refOf('F3');
    const second = alertsTo(buyer.email);
    expect(second).toHaveLength(2);
    expect(second[1].subject).toBe('1 new home matches “flat in E17”');
    expect(second[1].text).toContain(f3);
    expect(second[1].text).not.toContain(f1);
    expect((await sendsFor(searchId)).map((s) => s.ref).sort()).toEqual([f1, f2, f3].sort());

    // An agency waiting for verification: its listings aren't public, so no alert until it is verified.
    const waiting = await agency(false);
    await waiting.send(blm([['W1', 330_000]]));
    expect(alertsTo(buyer.email)).toHaveLength(2);
    expect((await waiting.adm.c.post(`/api/admin/orgs/${waiting.org.id}/verify`, { verified: true })).json.released).toBe(1);
    const third = alertsTo(buyer.email);
    expect(third).toHaveLength(3);
    expect(third[2].text).toContain(await waiting.refOf('W1'));
    expect((await runAlerts(hours(2))).emails).toBe(0);
    expect(alertsTo(buyer.email)).toHaveLength(3);
  });

  it('puts at most 10 listings in an email and sends the rest with the hourly job', async () => {
    const buyer = await verified();
    const searchId = await saveSearch(buyer, 'flat in E17');
    const a = await agency(true);
    await a.send(blm(Array.from({ length: 13 }, (_, i) => [`B${i + 1}`, 300_000 + i * 1000] as [string, number])));
    const first = alertsTo(buyer.email);
    expect(first).toHaveLength(1);
    expect(first[0].subject).toBe('10 new homes match “flat in E17”');
    expect(await sendsFor(searchId)).toHaveLength(10);
    expect((await runAlerts(hours(2))).emails).toBe(1);
    expect(alertsTo(buyer.email)[1].subject).toBe('3 new homes match “flat in E17”');
    const sends = await sendsFor(searchId);
    expect(sends).toHaveLength(13);
    expect(new Set(sends.map((s) => s.ref)).size).toBe(13); // every flat exactly once
  });
});
