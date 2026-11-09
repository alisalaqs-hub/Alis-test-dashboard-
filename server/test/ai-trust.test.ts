import { describe, expect, it } from 'vitest';
import { q } from '../src/db';
import { reviewListing } from '../src/ai/trust/review';
import { contactDetails, discriminatoryWording, groundEvidence, groundFigures, overlap, paymentRequests, priceSignal, scamPhrases, shingles } from '../src/ai/trust/signals';
import { client, getApp, jpegWithExif, lastMail, LISTING, makeAdmin, multipart, signUp, tokenIn } from './helpers';
import { mockOpenAI, reply } from './openai-mock';

type Client = ReturnType<typeof client>;
type Seller = Awaited<ReturnType<typeof signUp>>;

/* ───────── helpers ───────── */
const REVIEW_SCHEMA = 'listing_trust_review';
const isReview = (body: any) => body?.response_format?.json_schema?.name === REVIEW_SCHEMA; // eslint-disable-line @typescript-eslint/no-explicit-any
const lowRisk = { risk: 'low', score: 6, flags: [], summary: 'An ordinary family home listing with nothing of concern.', suggestedReason: null };
/** The model answers the trust review; other features' AI calls (from their own hooks) are politely refused. */
const trustModel = (answer: Record<string, unknown> | ((body: any) => Record<string, unknown>) = lowRisk) => // eslint-disable-line @typescript-eslint/no-explicit-any
  (body: any) => (isReview(body) ? reply.json(typeof answer === 'function' ? answer(body) : answer) : { status: 400, error: { message: 'not part of the trust tests' } }); // eslint-disable-line @typescript-eslint/no-explicit-any

let seq = 0;
/**
 * A unique, ordinary description (so cached moderation results never leak between tests). Kept under
 * 15 words so these listings are never "duplicates" of each other; the duplicate test uses its own text.
 */
const plainDescription = () => `Bright family home near Walthamstow Central (ref ${++seq}-${Date.now() % 100_000}).`;

async function upload(c: Client, ref: string, name = 'front-elevation.jpg') {
  const app = await getApp();
  const m = multipart([{ field: 'photos', name, type: 'image/jpeg', data: jpegWithExif() }]);
  const r = await app.inject({ method: 'POST', url: `/api/listings/${ref}/photos`, payload: m.payload, headers: { ...m.headers, cookie: c.cookie } });
  expect(r.statusCode).toBe(201);
}
async function draft(seller: Seller, overrides: Record<string, unknown> = {}, photos = 1) {
  const r = await seller.c.post('/api/listings', { ...LISTING, description: plainDescription(), ...overrides });
  expect(r.status).toBe(201);
  const ref = r.json.listing.ref as string;
  for (let i = 0; i < photos; i++) await upload(seller.c, ref, `room-${i}.jpg`);
  return ref;
}
async function submitted(seller: Seller, overrides: Record<string, unknown> = {}, photos = 1) {
  const ref = await draft(seller, overrides, photos);
  const s = await seller.c.post(`/api/listings/${ref}/submit`);
  expect(s.status).toBe(200);
  return ref;
}
const reviewsFor = (ref: string) => q<{ risk: string; score: number; flags: { type: string; severity: string; detail: string; evidence: string; source: string }[]; summary: string; suggested_reason: string | null; auto_approved: boolean; triggered_by: string; model: string | null; signals: { aiProblem?: string } }>(
  `SELECT r.* FROM listing_ai_reviews r JOIN listings l ON l.id = r.listing_id WHERE l.ref = $1 ORDER BY r.created_at`, [ref]);
const statusOf = async (ref: string) => (await q<{ status: string }>('SELECT status FROM listings WHERE ref = $1', [ref]))[0]?.status;
async function admin() { const a = await signUp(); await makeAdmin(a.email); return a; }
async function verifiedSeller() {
  const s = await signUp({ accountType: 'owner' });
  const v = await s.c.post('/api/auth/verify', { token: tokenIn(lastMail(s.email)!.text) });
  expect(v.status).toBe(200);
  return s;
}
const jobsFor = (ref: string) => q<{ status: string; attempts: number; error: string | null; output: { rulesOnly?: boolean } | null }>(
  `SELECT status, attempts, error, output FROM ai_jobs WHERE kind = 'trust.listing_review' AND subject = $1 ORDER BY created_at`, [`listing:${ref}`]);
/** The model can't answer the trust review (a non-retriable error); other features' calls are refused as usual. */
const failingModel = (status = 400) => (body: any) => (isReview(body) ? { status, error: { message: 'Invalid request' } } : { status: 400, error: { message: 'not part of the trust tests' } }); // eslint-disable-line @typescript-eslint/no-explicit-any
const withAutoApprove = async (fn: () => Promise<void>) => {
  const prev = process.env.AI_AUTO_APPROVE_LOW_RISK;
  process.env.AI_AUTO_APPROVE_LOW_RISK = 'true';
  try { await fn(); } finally { if (prev === undefined) delete process.env.AI_AUTO_APPROVE_LOW_RISK; else process.env.AI_AUTO_APPROVE_LOW_RISK = prev; }
};

/* ───────── pure signals ───────── */
describe('trust signals (code, no AI)', () => {
  it('finds contact details but not prices, sizes or dates', () => {
    const found = contactDetails('Asking £525,000 for 1,200 sq ft, 0.5 miles from the station, built 01/02/2004. Call 07700 900123 or +44 20 7946 0000, email landlord@example.com, see www.mysite.co.uk/flat or WhatsApp me.');
    expect(found.map((f) => f.text)).toEqual(expect.arrayContaining(['07700 900123', '+44 20 7946 0000', 'landlord@example.com', 'www.mysite.co.uk/flat', 'WhatsApp']));
    expect(found.some((f) => /525|1,200|2004/.test(f.text))).toBe(false);
    expect(contactDetails('Close to Walthamstow Central. Offers in the region of £450k.')).toEqual([]);
  });

  it('spots payment requests and scam wording, but not ordinary lettings terms', () => {
    expect(paymentRequests('Please pay the deposit by bank transfer before viewing. Bitcoin accepted.').map((p) => p.label)).toEqual(expect.arrayContaining(['bank transfer', 'cryptocurrency', 'payment before viewing']));
    expect(paymentRequests('Rent is payable monthly in advance. Deposit: 5 weeks’ rent. Holding deposit: one week’s rent.')).toEqual([]);
    expect(scamPhrases('I am currently abroad so the keys will be posted to you.').map((p) => p.label)).toEqual(['lister says they are abroad', 'keys sent by post']);
    expect(discriminatoryWording('Sorry no foreigners. British only.')).toHaveLength(2);
    expect(discriminatoryWording('Not suitable for wheelchair users because of the stairs.')).toEqual([]);
  });

  it('does not mistake ordinary listing wording for contact details, scams or discrimination', () => {
    // reception, prose and decorating, not contact details or excluded groups
    expect(contactDetails('Excellent mobile signal on all networks.')).toEqual([]);
    expect(contactDetails('Viewings at weekends. Net internal area 92 sq m.')).toEqual([]);
    expect(contactDetails('A home at heart. Uk buyers will love the garden.')).toEqual([]);
    expect(discriminatoryWording('The original floorboards need no polish.')).toEqual([]);
    expect(discriminatoryWording('No Indian restaurant nearby, but plenty of cafés.')).toEqual([]);
    expect(discriminatoryWording('No Chinese or Indian takeaways on the street.')).toEqual([]);
    expect(scamPhrases('No viewings on Sundays or before 10am. No viewings without an appointment.')).toEqual([]);
    expect(paymentRequests('We never ask for payment before a viewing, and there are no viewing fees. Never pay by bank transfer.')).toEqual([]);
    // …while the real thing is still found
    expect(contactDetails('Message me on Signal, or email jo at example dot co dot uk or jo(at)example.com.').map((f) => f.label)).toEqual(['email address', 'email address', 'messaging app']);
    expect(discriminatoryWording('No Polish.')).toHaveLength(1);
    expect(discriminatoryWording('Sorry, no Polish tenants. No Romanians.')).toHaveLength(2);
    expect(discriminatoryWording('No Irish or Indian applicants please.')).toHaveLength(1);
    expect(scamPhrases('Sorry, no viewings: I am abroad.').map((p) => p.label)).toEqual(expect.arrayContaining(['no viewings offered', 'lister says they are abroad']));
    expect(paymentRequests('Not far from the station. Pay the deposit by bank transfer before viewing.').map((p) => p.label)).toEqual(['bank transfer', 'payment before viewing']);
  });

  it('keeps AI evidence only when it is a real quote from the listing or a named Streetkey signal', () => {
    const text = '3-bed Victorian terrace with garden\nA bright family home close to Walthamstow Central.\nGarden. Period features';
    const names = { councilTaxBand: 'council tax band', priceVsArea: 'price compared with the area' };
    expect(groundEvidence('“close to Walthamstow Central”', text, names)).toBe('“close to Walthamstow Central”');
    expect(groundEvidence('"bright family home" … "Period features"', text, names)).toBe('"bright family home" … "Period features"');
    expect(groundEvidence('cash only, no viewings', text, names)).toBe(''); // not in the listing
    expect(groundEvidence('ome close', text, names)).toBe(''); // whole words only
    expect(groundEvidence('SIGNALS.priceVsArea', text, names)).toBe('Streetkey data: price compared with the area');
    expect(groundEvidence('councilTaxBand: null', text, names)).toBe('Streetkey data: council tax band');
    expect(groundEvidence('askingPriceSuspicious', text, names)).toBe('');
  });

  it('compares the price with Streetkey area evidence', () => {
    const cheap = priceSignal({ channel: 'sale', postcode: 'E17 4QH', property_type: 'terraced', price: 200_000, floor_area: 92 });
    expect(cheap).toMatchObject({ checked: true, farBelow: true, scope: 'postcode district E17' });
    expect(cheap.belowPct).toBeGreaterThan(40);
    expect(priceSignal({ channel: 'sale', postcode: 'E17 4QH', property_type: 'terraced', price: 525_000, floor_area: 92 }).farBelow).toBe(false);
    expect(priceSignal({ channel: 'sale', postcode: 'E17 4QH', property_type: 'commercial', price: 1, floor_area: 92 })).toMatchObject({ checked: false, reason: 'commercial' });
  });

  it('drops sentences with figures the AI made up, and measures duplicated text', () => {
    const out = groundFigures('The asking price is £200,000. It is really worth £999,999. That is 59% below the area. Some 87% of buyers agree.', { money: [200_000], percent: [59] });
    expect(out).toBe('The asking price is £200,000. That is 59% below the area.');
    const a = shingles('A bright family home close to the station with a long garden and period features throughout');
    expect(overlap(a, shingles('A bright family home close to the station with a long garden and period features throughout. Call today.'))).toBeGreaterThan(0.8);
    expect(overlap(a, shingles('A modern flat on the top floor with a lift, concierge and a private balcony facing south'))).toBeLessThan(0.1);
  });
});

/* ───────── the review job ───────── */
describe('listing trust review', () => {
  it('reviews a listing automatically when it is submitted (text and each photo moderated, then the AI review)', async () => {
    const ai = mockOpenAI({ chat: trustModel({ ...lowRisk, summary: 'Nothing of concern. The home is worth £999,999 according to me.' }) });
    try {
      const seller = await signUp({ accountType: 'owner' });
      const a = await admin();
      const ref = await submitted(seller, {}, 2);
      expect(await statusOf(ref)).toBe('pending'); // auto-approval is off by default

      const [review] = await reviewsFor(ref);
      expect(review).toMatchObject({ risk: 'low', triggered_by: 'submitted', auto_approved: false, model: 'gpt-5' });
      expect(review.score).toBeLessThan(30);
      expect(review.summary).toBe('Nothing of concern.'); // the invented figure was removed
      expect(review.suggested_reason).toBeNull();
      expect(review.flags.some((f) => f.type === 'photos' && f.severity === 'low' && f.source === 'rules')).toBe(true); // fewer than 3 photos

      const mods = ai.calls('moderations').map((c) => c.body.input as { type: string; image_url?: { url: string } }[]);
      expect(mods.some((parts) => parts.length === 1 && parts[0].type === 'text')).toBe(true);
      // one photo per moderation call, sent as a data URL
      const images = mods.filter((parts) => parts.length === 1 && parts[0].type === 'image_url' && parts[0].image_url!.url.startsWith('data:image/jpeg;base64,'));
      expect(images.length).toBeGreaterThanOrEqual(2);

      const chat = ai.calls('chat').find((c) => isReview(c.body))!;
      expect(chat.body.model).toBe('gpt-5'); // role 'main'
      expect(chat.body.response_format.json_schema.strict).toBe(true);
      expect(chat.body.messages[0].content).toMatch(/Streetkey’s AI/);
      const prompt = chat.body.messages[1].content as string;
      expect(prompt).toMatch(/<<<listing_description/);
      expect(prompt).not.toContain('14 Elm Road'); // the street address never goes to the model

      const one = await a.c.get(`/api/ai/trust/listings/${ref}`);
      expect(one.status).toBe(200);
      expect(one.json.review).toMatchObject({ risk: 'low', stale: false, autoApproved: false, triggeredBy: 'submitted' });
      expect(one.json.review.checks).toMatchObject({ textModeration: 'passed', photosChecked: 2, photosFlagged: 0, paymentRequests: 0 });
      expect(one.json.review.checks.price).toMatchObject({ checked: true, farBelow: false });

      // editing the listing afterwards marks the review as stale
      await seller.c.patch(`/api/listings/${ref}`, { title: 'Bright Victorian terrace' });
      expect((await a.c.get(`/api/ai/trust/listings/${ref}`)).json.review.stale).toBe(true);
    } finally { ai.restore(); }
  });

  it('applies hard rules: payment requests and contact details are at least medium; with a scam price, high', async () => {
    // The model is (wrongly) relaxed about both listings; the code must not be.
    const ai = mockOpenAI({ chat: trustModel(lowRisk) });
    try {
      const seller = await signUp({ accountType: 'owner' });
      const contact = await submitted(seller, { description: `${plainDescription()} Call me on 07700 900123 or email seller.home@example.com to arrange a visit.` });
      const [c] = await reviewsFor(contact);
      expect(c.risk).toBe('medium');
      expect(c.score).toBeGreaterThanOrEqual(30);
      expect(c.flags.find((f) => f.type === 'contact-details')).toMatchObject({ severity: 'medium', source: 'rules' });
      expect(c.flags.find((f) => f.type === 'contact-details')!.evidence).toContain('07700 900123');
      expect(c.suggested_reason).toMatch(/Remove phone numbers/);
      expect(c.summary).toMatch(/raised this to medium risk/);
      const chat = ai.calls('chat').filter((x) => isReview(x.body)).at(-1)!;
      const signals = chat.body.messages[1].content.split('\n')[3] as string;
      expect(signals).not.toContain('07700 900123'); // contact details are masked in the signals sent to the model

      const pay = await submitted(seller, { description: `${plainDescription()} Please pay a deposit by bank transfer before viewing.` });
      expect((await reviewsFor(pay))[0].risk).toBe('medium');

      const scam = await submitted(seller, { price: 150_000, description: `${plainDescription()} I am currently abroad, so please send the deposit by bank transfer before viewing and the keys will be posted to you.` });
      const [s] = await reviewsFor(scam);
      expect(s.risk).toBe('high');
      expect(s.score).toBeGreaterThanOrEqual(70);
      expect(s.flags.filter((f) => f.type === 'scam' && f.severity === 'high').length).toBeGreaterThanOrEqual(1);
      expect(s.suggested_reason).toMatch(/double-check the price/);
      expect(await statusOf(scam)).toBe('pending'); // never auto-rejected
    } finally { ai.restore(); }
  });

  it('raises the risk when moderation flags a photo, and keeps the model’s own flags and wording', async () => {
    const ai = mockOpenAI({
      moderations: (input) => ((input[0] as { type: string }).type === 'image_url' ? { flagged: true, categories: ['violence'] } : { flagged: false }),
      chat: trustModel({ risk: 'low', score: 12, flags: [{ type: 'misleading', severity: 'low', detail: 'The title says “newly renovated” but the condition is fair.', evidence: 'newly renovated' }], summary: 'Mostly fine.', suggestedReason: 'Thank you for your listing.\n- Please replace the second photo with a clear photo of the property.\n- Check the title matches its condition.' }),
    });
    try {
      const seller = await signUp({ accountType: 'owner' });
      const ref = await submitted(seller);
      const [r] = await reviewsFor(ref);
      expect(r.risk).toBe('medium');
      expect(r.flags.find((f) => f.type === 'photos' && f.severity === 'medium')).toBeTruthy();
      expect(r.flags.find((f) => f.source === 'ai' && f.type === 'misleading')).toBeTruthy();
      expect(r.suggested_reason).toBe('Thank you for your listing.\n- Please replace the second photo with a clear photo of the property.\n- Check the title matches its condition.');
    } finally { ai.restore(); }

    // AI wording that contains a link is never offered to the lister: the rule-based wording is used instead
    const textAi = mockOpenAI({ moderations: (input) => ((input[0] as { type: string }).type === 'text' ? { flagged: true, categories: ['harassment'] } : { flagged: false }), chat: trustModel({ ...lowRisk, suggestedReason: 'Thank you. Please read our guidance at www.example-guidance.com before resubmitting.' }) });
    try {
      const seller = await signUp({ accountType: 'owner' });
      const ref = await submitted(seller);
      const [r] = await reviewsFor(ref);
      expect(r.risk).toBe('medium');
      expect(r.flags.find((f) => f.type === 'other' && f.source === 'rules')!.evidence).toMatch(/harassment/);
      expect(r.suggested_reason).toMatch(/offensive/);
      expect(r.suggested_reason).not.toMatch(/example-guidance/);
    } finally { textAi.restore(); }
  });

  it('flags a description copied from another lister’s listing', async () => {
    const ai = mockOpenAI({ chat: trustModel(lowRisk) });
    try {
      const text = `Stunning three bedroom Victorian terrace moments from Walthamstow Central, with a landscaped garden, bay windows, stripped floorboards and a kitchen extension finished in oak and slate. Unique wording ${Date.now()}.`;
      const first = await signUp({ accountType: 'owner' });
      const original = await submitted(first, { description: text });
      expect((await reviewsFor(original))[0].flags.some((f) => f.type === 'duplicate')).toBe(false);
      const copier = await signUp({ accountType: 'owner' });
      const copy = await submitted(copier, { description: `${text} Viewings welcome.` });
      const [r] = await reviewsFor(copy);
      const dup = r.flags.find((f) => f.type === 'duplicate')!;
      expect(dup).toMatchObject({ severity: 'medium', source: 'rules' });
      expect(dup.evidence).toContain(original);
      expect(r.risk).toBe('medium');
    } finally { ai.restore(); }
  });

  it('auto-approves clearly low-risk listings from verified listers only when switched on, and never auto-rejects', async () => {
    const ai = mockOpenAI({ chat: trustModel(lowRisk) });
    try {
      const verified = await verifiedSeller();
      // off by default
      const off = await submitted(verified);
      expect(await statusOf(off)).toBe('pending');

      await withAutoApprove(async () => {
        const ref = await submitted(verified);
        expect(await statusOf(ref)).toBe('live');
        expect((await reviewsFor(ref))[0].auto_approved).toBe(true);
        expect(lastMail(verified.email)!.template).toBe('listing_live');
        expect((await client().get(`/api/listings/${ref}`)).status).toBe(200);
        const audit = await q<{ action: string }>(`SELECT action FROM audit_log WHERE subject = $1`, [`listing:${ref}`]);
        expect(audit.map((x) => x.action)).toContain('ai.auto_approved');

        // unverified email: waits for a person
        const unverified = await signUp({ accountType: 'owner' });
        expect(await statusOf(await submitted(unverified))).toBe('pending');
        // anything above low risk: waits for a person (and is never rejected automatically)
        const contact = await submitted(verified, { description: `${plainDescription()} Text 07700 900456 for details.` });
        expect(await statusOf(contact)).toBe('pending');
        expect((await reviewsFor(contact))[0].auto_approved).toBe(false);
        // agency listings keep their own verification step: never auto-approved
        const agent = await signUp({ accountType: 'agent' });
        await agent.c.post('/api/auth/verify', { token: tokenIn(lastMail(agent.email)!.text) });
        expect((await agent.c.post('/api/orgs', { name: 'Unverified Lettings Ltd', kind: 'agency' })).status).toBe(201);
        const agency = await submitted(agent);
        expect(await statusOf(agency)).toBe('pending');
        expect((await reviewsFor(agency))[0]).toMatchObject({ risk: 'low', auto_approved: false });
      });

      // the queue shows recent auto-approvals so people keep oversight
      const a = await admin();
      const queue = await a.c.get('/api/ai/trust/pending');
      expect(queue.json.autoApprove).toEqual({ enabled: false, maxScore: 20 });
      expect(queue.json.recentAutoApproved.length).toBeGreaterThanOrEqual(1);
    } finally { ai.restore(); }
  });

  it('does not auto-approve when the model scores the listing 20 or more', async () => {
    const ai = mockOpenAI({ chat: trustModel({ ...lowRisk, score: 24 }) });
    try {
      const verified = await verifiedSeller();
      await withAutoApprove(async () => {
        const ref = await submitted(verified);
        expect(await statusOf(ref)).toBe('pending');
        expect((await reviewsFor(ref))[0]).toMatchObject({ risk: 'low', score: 24, auto_approved: false });
      });
    } finally { ai.restore(); }
  });

  it('keeps every endpoint for admins only, and sorts the queue riskiest first', async () => {
    const ai = mockOpenAI({ chat: trustModel(lowRisk) });
    try {
      const seller = await signUp({ accountType: 'owner' });
      const a = await admin();
      const low = await submitted(seller);
      const high = await submitted(seller, { price: 150_000, description: `${plainDescription()} Pay the holding deposit by bank transfer before viewing.` });
      const medium = await submitted(seller, { description: `${plainDescription()} More at www.my-own-site.co.uk today.` });
      const unchecked = await draft(seller); // never submitted: not in the queue

      const anon = client();
      for (const [method, url] of [['GET', '/api/ai/trust/pending'], ['GET', `/api/ai/trust/listings/${low}`], ['POST', `/api/ai/trust/listings/${low}/review`]] as const) {
        expect((await anon.raw(method, url)).status).toBe(401);
        expect((await seller.c.raw(method, url)).status).toBe(403); // even the listing’s own lister
      }
      expect((await a.c.get('/api/ai/trust/listings/sk-nothere')).status).toBe(404);
      expect((await a.c.get('/api/ai/trust/listings/bad%20ref!')).status).toBe(400);

      const queue = await a.c.get('/api/ai/trust/pending');
      expect(queue.status).toBe(200);
      expect(queue.json.aiEnabled).toBe(true);
      const refs = queue.json.items.map((i: { ref: string }) => i.ref);
      expect(refs).not.toContain(unchecked);
      const order = [high, medium, low].map((r) => refs.indexOf(r));
      expect(order.every((n) => n >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((x, y) => x - y));
      const top = queue.json.items.find((i: { ref: string }) => i.ref === high);
      expect(top.review).toMatchObject({ risk: 'high', stale: false });
      expect(top.review.suggestedReason).toMatch(/bank transfer/);
      expect(top.review.flags[0].severity).toBe('high');
      expect(top.checking).toBeNull();
    } finally { ai.restore(); }
  });

  it('re-runs a check on request and returns the job to poll', async () => {
    let calls = 0;
    const ai = mockOpenAI({ chat: trustModel(() => (++calls === 1 ? lowRisk : { ...lowRisk, risk: 'medium', score: 41, summary: 'The new description makes claims to check.', suggestedReason: 'Thank you. Please explain what “fully renovated” covers, such as the rewiring and new boiler.' })) });
    try {
      const seller = await signUp({ accountType: 'owner' });
      const a = await admin();
      const ref = await submitted(seller);
      expect(await reviewsFor(ref)).toHaveLength(1);

      const r = await a.c.post(`/api/ai/trust/listings/${ref}/review`);
      expect(r.status).toBe(202);
      expect(r.json.job).toMatchObject({ kind: 'trust.listing_review', status: 'done' });
      expect(r.json.job.output).toMatchObject({ risk: 'medium', score: 41, autoApproved: false });
      const polled = await a.c.get(`/api/ai/jobs/${r.json.job.id}`);
      expect(polled.json.job.status).toBe('done');
      expect((await seller.c.get(`/api/ai/jobs/${r.json.job.id}`)).status).toBe(403);

      const reviews = await reviewsFor(ref);
      expect(reviews).toHaveLength(2);
      expect(reviews[1]).toMatchObject({ triggered_by: 'admin', risk: 'medium' });
      const latest = (await a.c.get(`/api/ai/trust/listings/${ref}`)).json.review;
      expect(latest).toMatchObject({ risk: 'medium', score: 41, triggeredBy: 'admin' });
      expect(latest.suggestedReason).toMatch(/fully renovated/);
      const audit = await q<{ action: string }>(`SELECT action FROM audit_log WHERE subject = $1`, [`listing:${ref}`]);
      expect(audit.map((x) => x.action)).toContain('ai.trust_recheck');
    } finally { ai.restore(); }

    // with AI off the re-check explains itself, and stored reviews can still be read
    const a = await admin();
    const seller = await signUp({ accountType: 'owner' });
    const ref = await submitted(seller);
    const off = await a.c.post(`/api/ai/trust/listings/${ref}/review`);
    expect(off.status).toBe(503);
    expect(off.json.error.code).toBe('ai_unavailable');
    expect((await a.c.get('/api/ai/trust/pending')).json.aiEnabled).toBe(false);
  });

  it('does nothing when AI is off: listings still go to the queue for a person', async () => {
    const seller = await signUp({ accountType: 'owner' });
    const ref = await submitted(seller);
    expect(await statusOf(ref)).toBe('pending');
    expect(await reviewsFor(ref)).toHaveLength(0);
    const a = await admin();
    const item = (await a.c.get('/api/ai/trust/pending')).json.items.find((i: { ref: string }) => i.ref === ref);
    expect(item).toMatchObject({ ref, review: null, checking: null });
  });

  it('skips listings that are no longer submitted when the job runs', async () => {
    const ai = mockOpenAI({ chat: trustModel(lowRisk) });
    try {
      const seller = await signUp({ accountType: 'owner' });
      const ref = await draft(seller);
      const [{ id }] = await q<{ id: string }>('SELECT id FROM listings WHERE ref = $1', [ref]);
      const out = await reviewListing(id, { trigger: 'submitted', userId: null });
      expect(out).toMatchObject({ reviewId: null, autoApproved: false, skipped: 'The listing is no longer submitted.' });
      expect(ai.calls('chat').filter((c) => isReview(c.body))).toHaveLength(0);
      // an admin can still ask for a check at any stage
      const admin = await reviewListing(id, { trigger: 'admin', userId: null });
      expect(admin.reviewId).toBeTruthy();
    } finally { ai.restore(); }
  });

  it('stores a rules-only review when the AI answer is unusable (the job still finishes, submission still works)', async () => {
    const ai = mockOpenAI({ chat: (body) => (isReview(body) ? reply.json({ risk: 'unknown' }) : { status: 400, error: { message: 'no' } }) });
    try {
      const seller = await signUp({ accountType: 'owner' });
      const a = await admin();
      const ref = await submitted(seller);
      expect(await statusOf(ref)).toBe('pending');
      const [r] = await reviewsFor(ref);
      expect(r).toMatchObject({ risk: 'low', score: 0, model: null, auto_approved: false });
      expect(r.summary).toMatch(/AI review couldn’t run, so this shows Streetkey’s automatic rules only/);
      expect(r.flags.every((f) => f.source === 'rules')).toBe(true);
      expect(r.signals.aiProblem).toMatch(/unexpected/);
      const [job] = await jobsFor(ref);
      expect(job).toMatchObject({ status: 'done', output: { rulesOnly: true } });
      const one = (await a.c.get(`/api/ai/trust/listings/${ref}`)).json;
      expect(one.review).toMatchObject({ rulesOnly: true, model: null });
      expect(one.review.aiProblem).toMatch(/unexpected/);
      expect(one.lastCheckFailed).toBeNull();
    } finally { ai.restore(); }
  });

  it('falls back to Streetkey’s rules when the AI can’t run, so a likely scam still goes to the top of the queue', async () => {
    const verified = await verifiedSeller();
    const a = await admin();
    let scam = '', clean = '';
    const ai = mockOpenAI({ chat: failingModel() });
    try {
      await withAutoApprove(async () => {
        scam = await submitted(verified, { price: 150_000, description: `${plainDescription()} Please pay the holding deposit by bank transfer before viewing.` });
        clean = await submitted(verified);
      });
      const [s] = await reviewsFor(scam);
      expect(s).toMatchObject({ risk: 'high', score: 70, model: null, auto_approved: false });
      expect(s.flags.filter((f) => f.type === 'scam' && f.severity === 'high').length).toBeGreaterThanOrEqual(1);
      expect(s.suggested_reason).toMatch(/double-check the price/);
      // never auto-approved without the AI review, even when the rules find nothing serious
      expect(await statusOf(clean)).toBe('pending');
      expect((await reviewsFor(clean))[0]).toMatchObject({ risk: 'low', model: null, auto_approved: false });
    } finally { ai.restore(); }

    // a listing the AI did review and rate low risk
    const okAi = mockOpenAI({ chat: trustModel(lowRisk) });
    let aiLow = '';
    try { aiLow = await submitted(verified); } finally { okAi.restore(); }

    const queue = (await a.c.get('/api/ai/trust/pending')).json;
    const refs: string[] = queue.items.map((i: { ref: string }) => i.ref);
    // high (rules only) → not reviewed by AI → AI-rated low risk
    expect([scam, clean, aiLow].map((r) => refs.indexOf(r))).toEqual([scam, clean, aiLow].map((r) => refs.indexOf(r)).sort((x, y) => x - y));
    const top = queue.items.find((i: { ref: string }) => i.ref === scam);
    expect(top.review).toMatchObject({ risk: 'high', rulesOnly: true });
    expect(top.review.aiProblem).toMatch(/couldn’t process/);
    expect(top.review.summary).toMatch(/automatic rules only/);
  });

  it('retries a transient AI fault, then stores a rules-only review on the last attempt', async () => {
    const ai = mockOpenAI({ chat: failingModel(500) });
    try {
      const seller = await signUp({ accountType: 'owner' });
      const ref = await submitted(seller, { description: `${plainDescription()} Call 07700 900123 to arrange a visit.` });
      const [r] = await reviewsFor(ref);
      expect(r).toMatchObject({ risk: 'medium', model: null, auto_approved: false });
      expect(r.flags.find((f) => f.type === 'contact-details')).toMatchObject({ severity: 'medium', source: 'rules' });
      const [job] = await jobsFor(ref);
      expect(job).toMatchObject({ status: 'done', attempts: 2, output: { rulesOnly: true } });
    } finally { ai.restore(); }
  });

  it('keeps an earlier AI review when a re-check of the same version fails, and tells admins the check failed', async () => {
    let fail = false;
    const ai = mockOpenAI({ chat: (body) => (fail ? failingModel()(body) : trustModel(lowRisk)(body)) });
    try {
      const seller = await signUp({ accountType: 'owner' });
      const a = await admin();
      const ref = await submitted(seller);
      fail = true;
      const r = await a.c.post(`/api/ai/trust/listings/${ref}/review`);
      expect(r.status).toBe(202);
      expect(r.json.job).toMatchObject({ status: 'failed' });
      expect(r.json.job.error).toMatch(/couldn’t process/);
      expect(await reviewsFor(ref)).toHaveLength(1); // not replaced by a rules-only review
      const one = (await a.c.get(`/api/ai/trust/listings/${ref}`)).json;
      expect(one.review).toMatchObject({ risk: 'low', rulesOnly: false, triggeredBy: 'submitted' });
      expect(one.lastCheckFailed.error).toMatch(/couldn’t process/);
      const item = (await a.c.get('/api/ai/trust/pending')).json.items.find((i: { ref: string }) => i.ref === ref);
      expect(item.lastCheckFailed.error).toMatch(/couldn’t process/);

      // a successful re-check clears it
      fail = false;
      expect((await a.c.post(`/api/ai/trust/listings/${ref}/review`)).json.job.status).toBe('done');
      expect((await a.c.get(`/api/ai/trust/listings/${ref}`)).json.lastCheckFailed).toBeNull();
    } finally { ai.restore(); }
  });

  it('shows AI evidence only when it can be checked, and sends the whole listing text to the model', async () => {
    const ai = mockOpenAI({ chat: trustModel({ risk: 'medium', score: 35, summary: 'A few points to check.', suggestedReason: null, flags: [
      { type: 'scam', severity: 'medium', detail: 'The listing seems to refuse viewings.', evidence: 'cash only, no viewings' },
      { type: 'misleading', severity: 'low', detail: 'Check the location claim.', evidence: '“near Walthamstow Central”' },
      { type: 'material-info', severity: 'low', detail: 'Check the council tax band.', evidence: 'councilTaxBand' },
    ] }) });
    try {
      const seller = await signUp({ accountType: 'owner' });
      // A description and feature list as long as a listing may hold: the end of each must reach the model.
      const description = `${plainDescription()} ${Array.from({ length: 135 }, (_, i) => `Room ${i} has good light and plenty of storage space.`).join(' ')} The cellar is dry, tanked and ready to use.`;
      const features = Array.from({ length: 30 }, (_, i) => (i === 29 ? 'Last feature: a zebra-striped boot room' : `Feature ${i} described at some length for the test`.padEnd(58, '.')));
      expect(description.length).toBeGreaterThan(6000);
      expect(features.join('. ').length).toBeGreaterThan(1500);
      const ref = await submitted(seller, { description, features });
      const prompt = ai.calls('chat').filter((c) => isReview(c.body)).at(-1)!.body.messages[1].content as string;
      expect(prompt).toContain('The cellar is dry, tanked and ready to use.');
      expect(prompt).toContain('zebra-striped boot room');

      const [r] = await reviewsFor(ref);
      const byDetail = (d: string) => r.flags.find((f) => f.source === 'ai' && f.detail === d)!;
      expect(byDetail('The listing seems to refuse viewings.').evidence).toBe(''); // an invented quote is never shown as evidence
      expect(byDetail('Check the location claim.').evidence).toBe('“near Walthamstow Central”');
      expect(byDetail('Check the council tax band.').evidence).toBe('Streetkey data: council tax band');
    } finally { ai.restore(); }
  });
});
