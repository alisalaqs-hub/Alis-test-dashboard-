import { describe, expect, it } from 'vitest';
import { designCost, STYLES, TIERS, type Tier } from '../../src/engine/design';
import { config } from '../src/config';
import { q } from '../src/db';
import { limits } from '../src/services/ratelimit';
import { DEFAULT_DIMS } from '../src/ai/studio/brief';
import { client, getApp, jpegWithExif, multipart, signUp } from './helpers';
import { mockOpenAI, reply, TINY_PNG } from './openai-mock';
import { fakeHosts } from './setup';

/* ───────────────────────── Check any listing (import) ───────────────────────── */
const PASTE = `Charming 2 bedroom maisonette for sale
Guide price £375,000
Lordship Lane, London SE22 8JL
2 bedrooms · 1 bathroom · 721 sq ft
Leasehold · 72 years remaining · Council tax band C
For sale by modern method of auction. A reservation fee applies.
Period features, private garden, needs updating.`;

const f = (value: unknown, confidence: 'stated' | 'inferred' = 'stated', evidence: string | null = null) => ({ value, confidence, evidence });
const EMPTY = {
  title: null, listing: null, price: null, priceQualifier: null, addressLine: null, town: null, postcode: null, type: null, tenure: null, leaseYears: null,
  beds: null, baths: null, floorArea: null, era: null, condition: null, epc: null, councilTax: null, serviceCharge: null, groundRent: null, saleMethod: null,
  features: [] as string[], redFlags: [] as unknown[], questionsToAsk: [] as string[],
};
const READING = {
  ...EMPTY,
  title: f('Charming 2 bedroom maisonette for sale', 'stated', 'Charming 2 bedroom maisonette'),
  listing: f('sale', 'stated', 'for sale'),
  price: f({ amount: 375000, period: 'total' }, 'stated', 'Guide price £375,000'),
  priceQualifier: f('Guide price', 'stated', 'Guide price'),
  addressLine: f('Lordship Lane', 'stated', 'Lordship Lane'),
  town: f('London', 'stated', 'London SE22'),
  postcode: null, // the model missed it: the rule reader fills it in
  type: f('flat', 'inferred', 'maisonette'),
  tenure: f('leasehold', 'stated', 'Leasehold'),
  leaseYears: f(72, 'stated', '72 years remaining'),
  beds: f(2, 'stated', '2 bedrooms'),
  baths: f(1, 'stated', '1 bathroom'),
  floorArea: f({ amount: 721, unit: 'sqft' }, 'stated', '721 sq ft'),
  era: f('pre-1919', 'inferred', 'Period features'),
  condition: f('poor', 'inferred', 'needs updating'),
  epc: f('C', 'stated', 'EPC rating C'), // invented: the quote isn't in the text
  councilTax: f('C', 'stated', 'Council tax band C'),
  serviceCharge: f({ amount: 1200, period: 'year' }, 'inferred', null), // invented figure
  saleMethod: f('modern method of auction', 'stated', 'modern method of auction'),
  features: ['Private garden', 'Period features'],
  redFlags: [
    { kind: 'stated', severity: 'high', title: 'Subsidence reported', detail: 'The listing mentions subsidence.', evidence: 'subsidence noted in survey' },
    { kind: 'stated', severity: 'medium', title: 'Needs updating', detail: 'Budget for refurbishment before moving in.', evidence: 'needs updating' },
    { kind: 'missing', severity: 'medium', title: 'EPC not stated', detail: 'Ask for the EPC.', evidence: null },
  ],
  questionsToAsk: ['What is the EPC rating, and can you send the certificate?', 'Is the garden private or shared'],
};

describe('AI import: check any listing', () => {
  it('is unavailable without an OpenAI key', async () => {
    const r = await client().post('/api/ai/import/extract', { text: PASTE });
    expect(r.status).toBe(503);
  });

  it('reads pasted text with the AI, merges with the rule reader and validates what it found', async () => {
    const visited: string[] = [];
    fakeHosts.set('www.rightmove.co.uk', (url) => { visited.push(url); return new Response('nope'); });
    const ai = mockOpenAI({ chat: () => reply.json(READING) });
    try {
      const r = await client().post('/api/ai/import/extract', { text: PASTE, url: 'https://www.rightmove.co.uk/properties/123456' });
      expect(r.status).toBe(200);
      const b = r.json;
      expect(b.engine).toBe('ai');
      // merged values
      expect(b.values).toMatchObject({ listing: 'sale', price: 375000, postcode: 'SE22 8JL', type: 'flat', tenure: 'leasehold', leaseYears: 72, beds: 2, baths: 1, floorArea: 67, councilTax: 'C', saleMethod: 'modern method of auction', sourceSite: 'rightmove.co.uk' });
      expect(b.values.epc).toBeUndefined(); // the quote wasn't in the text
      expect(b.values.serviceChargeAnnual).toBeUndefined(); // the figure wasn't in the text
      expect(b.fields.price).toEqual({ confidence: 'stated', evidence: 'Guide price £375,000', source: 'both' });
      expect(b.fields.postcode).toMatchObject({ source: 'rules', confidence: 'stated' });
      expect(b.fields.type).toMatchObject({ confidence: 'inferred', evidence: 'maisonette' });
      expect(b.fields.floorArea.source).toBe('both');
      expect(b.missing).toEqual([]);
      expect(b.values.features).toEqual(expect.arrayContaining(['Garden', 'Period features', 'Private garden']));
      // red flags: rules first by severity, AI flags only when they quote the text and add something new
      const ids = b.redFlags.map((x: { id: string }) => x.id);
      expect(ids).toEqual(expect.arrayContaining(['short-lease', 'auction', 'no-epc', 'service-charge', 'ground-rent']));
      expect(b.redFlags[0].severity).toBe('high');
      const titles = b.redFlags.map((x: { title: string }) => x.title).join(' | ');
      expect(titles).not.toMatch(/Subsidence/);
      expect(titles).not.toMatch(/EPC not stated/);
      expect(b.redFlags.find((x: { source: string }) => x.source === 'ai')).toMatchObject({ title: 'Needs updating', evidence: 'needs updating' });
      expect(b.redFlags.find((x: { id: string }) => x.id === 'short-lease').title).toMatch(/72 years/);
      // questions: rule questions plus the AI's, without duplicates
      expect(b.questionsToAsk.filter((x: string) => /EPC rating/.test(x))).toHaveLength(1);
      expect(b.questionsToAsk).toContain('Is the garden private or shared?');
      expect(b.questionsToAsk.length).toBeLessThanOrEqual(8);
      // the prompt: house rules, the text wrapped as untrusted data, fast model, strict schema
      const call = ai.calls('chat')[0].body;
      expect(call.model).toBe('gpt-5-mini');
      expect(call.messages[0].content).toMatch(/Streetkey’s AI, for the UK property market/);
      expect(call.messages[1].content).toMatch(/<<<listing\n/);
      expect(call.messages[1].content).toMatch(/rightmove\.co\.uk/);
      expect(call.response_format.json_schema.strict).toBe(true);
      // the link was never visited, and the same paste is answered from the cache
      expect(visited).toHaveLength(0);
      const again = await client().post('/api/ai/import/extract', { text: PASTE, url: 'https://www.rightmove.co.uk/properties/123456' });
      expect(again.json.values.price).toBe(375000);
      expect(ai.calls('chat')).toHaveLength(1);
    } finally { ai.restore(); fakeHosts.delete('www.rightmove.co.uk'); }
  });

  it('never shows figures that are not in the text, and converts weekly rents in code', async () => {
    const ai = mockOpenAI({
      chat: (body) => {
        const text = String(body.messages[1].content);
        if (/offers invited/.test(text)) return reply.json({ ...EMPTY, price: f({ amount: 350000, period: 'total' }, 'stated', 'offers invited'), beds: f(2, 'stated', '2 bedrooms'), leaseYears: f(105, 'inferred', '125 year lease from 2015') });
        return reply.json({
          ...EMPTY, listing: f('rent', 'stated', 'to rent'), price: f({ amount: 450, period: 'pw' }, 'stated', '£450 pw'), epc: f('F', 'stated', 'EPC: F'),
          type: f('flat', 'stated', 'flat'), beds: f(1, 'stated', '1 bedroom'), councilTax: f('B', 'stated', 'Council tax band B'),
          redFlags: [{ kind: 'stated', severity: 'high', title: 'Deposit of £9,999 requested', detail: 'A £9,999 deposit is far too high.', evidence: 'Deposit' }],
        });
      },
    });
    try {
      const sale = (await client().post('/api/ai/import/extract', { text: 'Lovely flat with a 125 year lease from 2015, offers invited. 2 bedrooms. London SE22 8JL.' })).json;
      expect(sale.values.price).toBeUndefined();
      expect(sale.values.leaseYears).toBeUndefined();
      expect(sale.missing).toContain('price');
      expect(sale.values.beds).toBe(2);

      const let_ = (await client().post('/api/ai/import/extract', { text: '1 bedroom flat to rent, £450 pw. EPC: F. Council tax band B. Admin fee £150. No DSS. Deposit £3,000. Manchester M14 5RQ.' })).json;
      expect(let_.values).toMatchObject({ listing: 'rent', price: 1950, epc: 'F' });
      const ids = let_.redFlags.map((x: { id: string }) => x.id);
      expect(ids).toEqual(expect.arrayContaining(['epc-let', 'tenant-fees', 'discriminatory', 'deposit-cap']));
      expect(JSON.stringify(let_.redFlags)).not.toMatch(/9,999/);
    } finally { ai.restore(); }
  });

  it('falls back to the rule reader when the AI fails, and validates input', async () => {
    const ai = mockOpenAI({ chat: () => ({ status: 500, error: { message: 'upstream exploded' } }) });
    try {
      const r = await client().post('/api/ai/import/extract', { text: `${PASTE}\nEPC rating D` });
      expect(r.status).toBe(200);
      expect(r.json.engine).toBe('rules');
      expect(r.json.note).toMatch(/built-in reader/);
      expect(r.json.values).toMatchObject({ price: 375000, postcode: 'SE22 8JL', epc: 'D', leaseYears: 72 });
      expect(r.json.redFlags.map((x: { id: string }) => x.id)).toContain('short-lease');
      expect(JSON.stringify(r.json)).not.toMatch(/exploded/);

      const tooLong = await client().post('/api/ai/import/extract', { text: 'x'.repeat(15_001) });
      expect(tooLong.status).toBe(400);
      expect(tooLong.json.error.fields.text).toMatch(/15,000/);
      expect((await client().post('/api/ai/import/extract', {})).status).toBe(400);
      expect((await client().post('/api/ai/import/extract', { text: 'too short' })).status).toBe(400);
    } finally { ai.restore(); }
  });

  it('is rate limited per visitor', async () => {
    const ai = mockOpenAI({ chat: () => reply.json(READING) });
    const prev = limits.multiplier; limits.multiplier = 1;
    try {
      const app = await getApp();
      const send = () => app.inject({ method: 'POST', url: '/api/ai/import/extract', payload: { text: PASTE }, remoteAddress: '10.20.30.40' });
      for (let i = 0; i < 6; i++) expect((await send()).statusCode).toBe(200);
      const blocked = await send();
      expect(blocked.statusCode).toBe(429);
    } finally { limits.multiplier = prev; ai.restore(); }
  });
});

/* ───────────────────────── Room redesign (background job) ───────────────────────── */
describe('AI room redesign job', () => {
  const photo = (fields: Record<string, string> = { room: 'kitchen', style: 'scandi', brief: 'Pale oak, sage green', consent: 'true' }) =>
    multipart([{ field: 'photo', name: 'kitchen.jpg', type: 'image/jpeg', data: jpegWithExif() }], fields);
  const send = async (cookie: string, m = photo()) => {
    const r = await (await getApp()).inject({ method: 'POST', url: '/api/ai/room-image', payload: m.payload, headers: { ...m.headers, ...(cookie ? { cookie } : {}) } });
    return { status: r.statusCode, json: r.json() };
  };

  it('answers 202 with a job, which finishes with a stored image; consent, owners only and the daily limit', async () => {
    const forms: FormData[] = [];
    const ai = mockOpenAI({ images: (form) => { forms.push(form); return TINY_PNG; } });
    const prevLimit = config.ai.dailyImagesPerUser;
    config.ai.dailyImagesPerUser = 2;
    try {
      expect((await send('')).status).toBe(401);
      const { c, user } = await signUp();
      const noConsent = await send(c.cookie, photo({ room: 'kitchen', style: 'scandi' }));
      expect(noConsent.status).toBe(400);
      expect(noConsent.json.error.fields.consent).toMatch(/AI provider/);

      const r = await send(c.cookie);
      expect(r.status).toBe(202);
      expect(r.json.jobId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.json.label).toMatch(/AI-generated concept/);
      expect(r.json.remainingToday).toBe(1);
      const polled = await c.get(`/api/ai/jobs/${r.json.jobId}`);
      expect(polled.status).toBe(200);
      expect(polled.json.job).toMatchObject({ kind: 'studio.room_image', status: 'done' });
      expect(polled.json.job.output.image).toMatchObject({ status: 'done', room: 'kitchen', style: 'Scandinavian' });
      expect(polled.json.job.output.image.url).toMatch(/^\/media\/ai\/result\/.+\.png$/);
      expect((await (await getApp()).inject({ method: 'GET', url: polled.json.job.output.image.url })).statusCode).toBe(200);
      // the prompt and the photo that were sent (location metadata stripped)
      expect(String(forms[0].get('prompt'))).toMatch(/Scandinavian/);
      expect(String(forms[0].get('prompt'))).toMatch(/Pale oak, sage green/);
      expect(String(forms[0].get('model'))).toMatch(/^gpt-image-/);
      const sent = Buffer.from(await (forms[0].get('image') as Blob).arrayBuffer());
      expect(sent.toString('latin1')).not.toMatch(/secret-location/);
      // consent recorded once
      expect(await q(`SELECT 1 FROM consents WHERE user_id = $1 AND purpose = 'ai_image_processing'`, [user.id])).toHaveLength(1);
      // someone else can't see the job
      const other = await signUp();
      expect((await other.c.get(`/api/ai/jobs/${r.json.jobId}`)).status).toBe(403);
      // daily limit
      expect((await send(c.cookie)).status).toBe(202);
      const third = await send(c.cookie);
      expect(third.status).toBe(429);
      expect(third.json.error.message).toMatch(/today’s 2 AI designs/);
      const hist = (await c.get('/api/ai/room-images')).json.items;
      expect(hist).toHaveLength(2);
      expect(hist.every((h: { status: string }) => h.status === 'done')).toBe(true);
    } finally { config.ai.dailyImagesPerUser = prevLimit; ai.restore(); }
  });

  it('marks the design as failed with a safe message when the AI declines, without using up the limit', async () => {
    const ai = mockOpenAI({ images: () => ({ status: 400, error: { message: 'Your request was rejected as a result of our safety system. sk-proj-SECRETKEY123' } }) });
    const prevLimit = config.ai.dailyImagesPerUser;
    config.ai.dailyImagesPerUser = 1;
    try {
      const { c } = await signUp();
      const r = await send(c.cookie);
      expect(r.status).toBe(202);
      const job = (await c.get(`/api/ai/jobs/${r.json.jobId}`)).json.job;
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/declined/);
      const hist = (await c.get('/api/ai/room-images')).json.items;
      expect(hist[0]).toMatchObject({ status: 'failed', url: null });
      expect(hist[0].error).toMatch(/declined/);
      expect(JSON.stringify(hist)).not.toMatch(/SECRETKEY/);
      // failed designs don't count towards the daily limit
      expect((await send(c.cookie)).status).toBe(202);
    } finally { config.ai.dailyImagesPerUser = prevLimit; ai.restore(); }
  });

  it('retries a transient provider failure in the job and then succeeds', async () => {
    let n = 0;
    const ai = mockOpenAI({ images: () => (++n <= 2 ? { status: 503, error: { message: 'overloaded' } } : TINY_PNG) });
    try {
      const { c } = await signUp();
      const r = await send(c.cookie);
      expect(r.status).toBe(202);
      const job = (await c.get(`/api/ai/jobs/${r.json.jobId}`)).json.job;
      expect(job.status).toBe('done');
      expect(n).toBe(3);
      const [row] = await q<{ attempts: number }>('SELECT attempts FROM ai_jobs WHERE id = $1', [r.json.jobId]);
      expect(row.attempts).toBe(2);
      expect((await c.get('/api/ai/room-images')).json.items[0].status).toBe('done');
    } finally { ai.restore(); }
  });

  it('closes out designs whose job failed without a result', async () => {
    const ai = mockOpenAI({ images: () => TINY_PNG });
    try {
      const { c, user } = await signUp();
      const [img] = await q<{ id: string }>(`INSERT INTO ai_images (user_id, room, style, prompt, model, status) VALUES ($1, 'kitchen', 'Modern', 'x', 'gpt-image-1', 'running') RETURNING id`, [user.id]);
      await q(`INSERT INTO ai_jobs (kind, user_id, subject, status, error) VALUES ('studio.room_image', $1, $2, 'failed', 'This AI task couldn’t start.')`, [user.id, `ai_image:${img.id}`]);
      const hist = (await c.get('/api/ai/room-images')).json.items;
      expect(hist[0]).toMatchObject({ id: img.id, status: 'failed', error: 'This AI task couldn’t start.' });
    } finally { ai.restore(); }
  });
});

/* ───────────────────────── Design brief ───────────────────────── */
describe('AI design brief', () => {
  const PLAN = {
    room: 'living', styleId: 'scandi', tier: 'luxury', budget: 5000,
    priorities: ['Light and calm', 'Light and calm', 'Storage'], keep: ['The oak floor'],
    materials: [{ item: 'Flooring', spec: 'Engineered oak (£65/m²)', why: 'Warm and hard-wearing, about £2,000 in total.' }, { item: 'Lighting', spec: 'Layered, dimmable', why: 'Softens the room in the evening.' }],
    notes: 'Keep the palette pale. Budget around £5,000 for this.',
  };

  it('grounds the plan: style from STYLES, tier fitted to the budget and every figure from the engine', async () => {
    const ai = mockOpenAI({ chat: () => reply.json(PLAN) });
    try {
      const r = await client().post('/api/ai/design/brief', { text: 'Redesign this living room for £5,000 and keep the oak floor', room: 'kitchen', postcode: 'E17 4QH', staged: true });
      expect(r.status).toBe(200);
      const b = r.json;
      const expected = ([...TIERS].reverse() as Tier[]).find((t) => designCost('living', t, DEFAULT_DIMS, 'E17 4QH', { furniture: true }).total <= 5000)!;
      expect(expected).toBeDefined();
      expect(expected).not.toBe('luxury'); // so the server had to lower the AI's choice
      expect(b).toMatchObject({ engine: 'ai', room: 'living', styleId: 'scandi', styleName: 'Scandinavian', budget: 5000, fitsBudget: true, tierAdjusted: true, tier: expected });
      const cost = designCost('living', expected, DEFAULT_DIMS, 'E17 4QH', { furniture: true });
      expect(b.cost).toMatchObject({ total: cost.total, materials: cost.materials, labour: cost.labour, vat: cost.vat, regionLabel: cost.regionLabel });
      expect(b.message).toContain(`£${cost.total.toLocaleString('en-GB')}`);
      expect(b.message).toMatch(/rather than luxury/);
      expect(b.priorities).toEqual(['Light and calm', 'Storage']);
      expect(b.keep).toEqual(['The oak floor']);
      expect(JSON.stringify([b.materials, b.notes, b.priorities])).not.toMatch(/£/);
      expect(b.materials[0]).toMatchObject({ item: 'Flooring', spec: 'Engineered oak' });
      // the model was given the engine's totals and the brief as untrusted data
      const call = ai.calls('chat')[0].body;
      expect(call.messages[1].content).toMatch(/totalIncVatByRoomAndTier/);
      expect(call.messages[1].content).toMatch(/<<<brief\n/);
      expect(call.response_format.json_schema.schema.properties.styleId.enum).toEqual(STYLES.map((s) => s.id));
    } finally { ai.restore(); }
  });

  it('ignores a budget the brief never stated', async () => {
    const ai = mockOpenAI({ chat: () => reply.json({ ...PLAN, room: 'kitchen', styleId: 'luxury', tier: 'luxury', budget: 20000 }) });
    try {
      const b = (await client().post('/api/ai/design/brief', { text: 'Make the kitchen feel properly luxurious', room: 'kitchen', postcode: 'M14 5RQ', dims: { width: 3.5, length: 3, height: 2.4 } })).json;
      expect(b).toMatchObject({ engine: 'ai', room: 'kitchen', styleId: 'luxury', tier: 'luxury', budget: null, fitsBudget: null, tierAdjusted: false });
      expect(b.cost.total).toBe(designCost('kitchen', 'luxury', { width: 3.5, length: 3, height: 2.4 }, 'M14 5RQ', { furniture: false }).total);
    } finally { ai.restore(); }
  });

  it('falls back to the rule parser when the model returns a style that does not exist', async () => {
    const ai = mockOpenAI({ chat: () => reply.json({ ...PLAN, styleId: 'bauhaus' }) });
    try {
      const b = (await client().post('/api/ai/design/brief', { text: 'Scandinavian bedroom for £3,500', postcode: 'E17 4QH' })).json;
      expect(b.engine).toBe('rules');
      expect(b.note).toMatch(/built-in/);
      expect(STYLES.map((s) => s.id)).toContain(b.styleId);
      expect(TIERS).toContain(b.tier);
      expect(b).toMatchObject({ room: 'bedroom', budget: 3500 });
      expect(b.cost.total).toBe(designCost('bedroom', b.tier, DEFAULT_DIMS, 'E17 4QH', { furniture: true }).total);
      if (b.fitsBudget) expect(b.cost.total).toBeLessThanOrEqual(3500);
    } finally { ai.restore(); }
  });

  it('validates input and needs AI to be on', async () => {
    expect((await client().post('/api/ai/design/brief', { text: 'Scandi bedroom' })).status).toBe(503);
    const ai = mockOpenAI({ chat: () => reply.json(PLAN) });
    try {
      expect((await client().post('/api/ai/design/brief', { text: '' })).status).toBe(400);
      expect((await client().post('/api/ai/design/brief', { text: 'x'.repeat(601) })).status).toBe(400);
      expect((await client().post('/api/ai/design/brief', { text: 'Scandi bedroom', budget: -5 })).status).toBe(400);
      expect((await client().post('/api/ai/design/brief', { text: 'Scandi bedroom', room: 'garage' })).status).toBe(400);
      expect((await client().post('/api/ai/design/brief', { text: 'Scandi bedroom', postcode: '<script>' })).status).toBe(400);
    } finally { ai.restore(); }
  });
});

/* ───────────────────────── Analyse this room ───────────────────────── */
describe('AI describe a room photo', () => {
  const form = (fields: Record<string, string> = { consent: 'true', room: 'kitchen' }, data = jpegWithExif(), type = 'image/jpeg') =>
    multipart([{ field: 'photo', name: 'room.jpg', type, data }], fields);
  const send = async (cookie: string, m = form()) => {
    const r = await (await getApp()).inject({ method: 'POST', url: '/api/ai/design/describe-photo', payload: m.payload, headers: { ...m.headers, ...(cookie ? { cookie } : {}) } });
    return { status: r.statusCode, json: r.json() };
  };
  const ANALYSIS = {
    isRoom: true, room: 'kitchen', condition: 'dated',
    keepWorthy: ['Original sash window', 'Original sash window', 'Good natural light'],
    problems: ['Dated pine units', 'Worn worktop (about £500 to replace)'],
    suggestedStyleIds: ['scandi', 'modern', 'scandi', 'traditional', 'luxury'], suggestedTier: 'standard',
    notes: 'Make the most of the light.',
  };

  it('needs sign-in, consent and a real image under 4 MB', async () => {
    const ai = mockOpenAI({ chat: () => reply.json(ANALYSIS) });
    try {
      expect((await send('')).status).toBe(401);
      const { c } = await signUp();
      expect((await send(c.cookie, form({ room: 'kitchen' }))).status).toBe(400);
      const notImage = await send(c.cookie, form({ consent: 'true' }, Buffer.from('hello, not an image'), 'image/jpeg'));
      expect(notImage.status).toBe(400);
      expect(notImage.json.error.fields.photo).toMatch(/JPEG, PNG or WebP/);
      const big = Buffer.concat([jpegWithExif(), Buffer.alloc(4 * 1024 * 1024 + 10, 1)]);
      const tooBig = await send(c.cookie, form({ consent: 'true' }, big));
      expect(tooBig.status).toBe(413);
      expect(tooBig.json.error.message).toMatch(/4 MB/);
      const none = multipart([], { consent: 'true' });
      expect((await send(c.cookie, none)).status).toBe(400);
      expect(ai.calls('chat')).toHaveLength(0);
    } finally { ai.restore(); }
  });

  it('describes the room with the vision model at low detail and tidies the answer', async () => {
    const ai = mockOpenAI({ chat: () => reply.json(ANALYSIS) });
    try {
      const { c } = await signUp();
      const r = await send(c.cookie);
      expect(r.status).toBe(200);
      expect(r.json.label).toMatch(/Not a survey/);
      expect(r.json.analysis).toMatchObject({ isRoom: true, room: 'kitchen', condition: 'dated', suggestedTier: 'standard', keepWorthy: ['Original sash window', 'Good natural light'], suggestedStyleIds: ['scandi', 'modern', 'traditional'] });
      expect(JSON.stringify(r.json.analysis.problems)).not.toMatch(/£/);
      const call = ai.calls('chat')[0].body;
      expect(call.model).toBe('gpt-5-mini');
      const img = call.messages[1].content.find((p: { type: string }) => p.type === 'image_url');
      expect(img.image_url.detail).toBe('low');
      expect(img.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
      expect(Buffer.from(img.image_url.url.split(',')[1], 'base64').toString('latin1')).not.toMatch(/secret-location/);
      expect(call.messages[0].content).toMatch(/Not a survey|not a survey/);
    } finally { ai.restore(); }
  });

  it('says so when the photo is not of a room', async () => {
    const ai = mockOpenAI({ chat: () => reply.json({ ...ANALYSIS, isRoom: false, room: 'other' }) });
    try {
      const { c } = await signUp();
      const r = await send(c.cookie, form({ consent: 'true' }, TINY_PNG, 'image/png'));
      expect(r.status).toBe(200);
      expect(r.json.analysis).toMatchObject({ isRoom: false, room: null, keepWorthy: [], problems: [], suggestedStyleIds: [] });
    } finally { ai.restore(); }
  });
});
