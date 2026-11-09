import { describe, expect, it } from 'vitest';
import { briefBudget, briefMentions, designCost, parseDesignBrief, STYLES, studioBudget, TIERS, type Tier } from '../../src/engine/design';
import { config } from '../src/config';
import { pool, q } from '../src/db';
import { limits } from '../src/services/ratelimit';
import { DEFAULT_DIMS, groundBrief } from '../src/ai/studio/brief';
import { lockImageAllowance } from '../src/ai/studio/roomImage';
import { mergeExtraction, type Extraction } from '../src/ai/importer/extract';
import { rulesOnlyResult, ruleFlags, tenureOf } from '../../src/lib/ai/importer';
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
/** A new account whose email address is confirmed (image generation and photo analysis need one). */
async function verifiedSignUp() {
  const s = await signUp();
  await q('UPDATE users SET email_verified_at = now() WHERE id = $1', [s.user.id]);
  return s;
}
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

/* ───────────── the safety net: quotes must support values, and the rules win disagreements ───────────── */
describe('AI import: merging the AI reading with the rule reader', () => {
  const ids = (r: { redFlags: { id: string }[] }) => r.redFlags.map((x) => x.id);
  const read = (over: Partial<Record<keyof Extraction, unknown>>) => ({ ...EMPTY, ...over }) as unknown as Extraction;

  it('drops values whose quote is in the text but does not support them, keeping the rule reader’s', () => {
    const text = 'Two bedroom flat for sale. Price £250,000. Leasehold, 95 years remaining. EPC rating: E. Council tax band C. 721 sq ft. Service charge £1,200 per annum. Ground rent £250 per annum. London SE22 8JL.';
    const r = mergeExtraction(read({
      epc: f('C', 'stated', 'Council tax band C'), // a council tax quote can't give an EPC
      floorArea: f({ amount: 721, unit: 'sqm' }, 'stated', '721 sq ft'), // wrong unit
      serviceCharge: f({ amount: 1200, period: 'month' }, 'stated', 'Service charge £1,200 per annum'), // wrong period
      price: f({ amount: 1200, period: 'total' }, 'stated', '£1,200'), // a service charge isn't the price
      leaseYears: f(250, 'stated', 'Ground rent £250'), // ground rent isn't a lease length
      saleMethod: f('auction', 'stated', null), // no quote at all
      tenure: f('leasehold', 'stated', 'Leasehold'),
    }), text, '');
    expect(r.values).toMatchObject({ listing: 'sale', price: 250000, epc: 'E', councilTax: 'C', floorArea: 67, serviceChargeAnnual: 1200, groundRentAnnual: 250, leaseYears: 95, tenure: 'leasehold' });
    expect(r.values.saleMethod).toBeUndefined();
    for (const k of ['price', 'epc', 'floorArea', 'serviceChargeAnnual', 'leaseYears'] as const) expect(r.fields[k]).toMatchObject({ source: 'rules' });
    expect(r.fields.tenure).toMatchObject({ source: 'both', confidence: 'stated', evidence: 'Leasehold' });
    expect(ids(r)).toContain('lease-under-100');
    expect(ids(r)).not.toContain('auction');
    expect(ids(r)).not.toContain('ground-rent');
    expect(JSON.stringify(r)).not.toMatch(/14,?400|"price":1200/);
  });

  it('keeps the rule value as “inferred” when both readers quote a different value, and shows the AI’s beside it', () => {
    const text = 'Two bedroom flat for sale. Guide price £375,000. Offers over £350,000 considered. Leasehold, 120 years remaining. London SE22 8JL.';
    const r = mergeExtraction(read({ price: f({ amount: 350000, period: 'total' }, 'stated', 'Offers over £350,000') }), text, '');
    expect(r.values.price).toBe(375000);
    // The rule reader's value is shown with the words it read it from, and the AI's reading beside it.
    expect(r.fields.price).toMatchObject({ confidence: 'inferred', source: 'rules', alt: { value: 350000, evidence: 'Offers over £350,000' } });
    expect(r.fields.price?.evidence).toMatch(/Guide price £375,000/);
  });

  it('accepts values that the quote really supports, converting units and periods in code', () => {
    const text = 'Flat for sale, leasehold. £325,000. 150 years left on the lease. EPC: C (potential B). 60 m². Service charge £300 quarterly. London SE22 8JL.';
    const r = mergeExtraction(read({
      price: f({ amount: 325000, period: 'total' }, 'stated', '£325,000'), epc: f('C', 'stated', 'EPC: C (potential B)'),
      leaseYears: f(150, 'stated', '150 years left on the lease'), floorArea: f({ amount: 60, unit: 'sqm' }, 'stated', '60 m²'),
      serviceCharge: f({ amount: 300, period: 'quarter' }, 'stated', 'Service charge £300 quarterly'),
    }), text, '');
    expect(r.values).toMatchObject({ price: 325000, epc: 'C', leaseYears: 150, floorArea: 60, serviceChargeAnnual: 1200 });
    expect(r.fields.epc).toMatchObject({ confidence: 'stated', evidence: 'EPC: C (potential B)' });
    // "potential B" is not the rating
    expect(mergeExtraction(read({ epc: f('B', 'stated', 'EPC: C (potential B)') }), text, '').values.epc).toBe('C');
  });

  it('needs a real, un-negated auction quote before raising the auction flag', () => {
    const negated = 'Three bedroom freehold house for sale. Guide price £300,000. Not subject to auction. London SE22 8JL.';
    const a = mergeExtraction(read({ saleMethod: f('auction', 'stated', 'auction') }), negated, '');
    expect(a.values.saleMethod).toBeUndefined();
    expect(ids(a)).not.toContain('auction');
    const real = 'Three bedroom freehold house for sale by auction. Guide price £300,000. London SE22 8JL.';
    expect(mergeExtraction(read({ saleMethod: f('auction', 'inferred', null) }), real, '').values.saleMethod).toBeUndefined();
    const ok = mergeExtraction(read({ saleMethod: f('auction', 'stated', 'for sale by auction') }), real, '');
    expect(ok.values.saleMethod).toBe('auction');
    expect(ids(ok)).toContain('auction');
  });

  it('keeps only features written in the text, never wording about who a home suits, and limits the AI’s own flags', () => {
    const text = 'Two bedroom leasehold flat to rent, £1,500 pcm. 90 years remaining. Private balcony. No admin fees. Bright, flooded with natural light. EPC C. Council tax band B. London SE22 8JL.';
    const r = mergeExtraction(read({
      features: ['Ideal for young professionals', 'Close to excellent schools', 'Private balcony', 'Roof terrace'],
      redFlags: [
        { kind: 'missing', severity: 'high', title: 'Planning permission missing', detail: 'The loft conversion is unlawful.', evidence: null },
        { kind: 'missing', severity: 'medium', title: 'Parking not mentioned', detail: 'There is definitely no parking, which breaches the rules.', evidence: null },
        { kind: 'stated', severity: 'high', title: 'Admin fees charged', detail: 'Admin fees are mentioned.', evidence: 'No admin fees' },
        { kind: 'stated', severity: 'low', title: 'Flood risk', detail: 'Flooding is mentioned.', evidence: 'flooded with natural light' },
        { kind: 'stated', severity: 'medium', title: 'Bright but small', detail: 'Perfect for couples.', evidence: 'Bright' },
      ],
      questionsToAsk: ['Is it near good schools for families?', 'Is there a lift to the flat?', 'Is the fee illegal?'],
    }), text, '');
    expect(r.values.features).toEqual(['Balcony', 'Private balcony']); // the rule reader's, plus the AI's that is written in the text
    const ai = r.redFlags.filter((x) => x.source === 'ai');
    expect(ai).toEqual([{ id: 'ai-gap-parking', severity: 'low', title: 'Parking not mentioned', detail: expect.stringMatching(/^Ask whether there is parking/), evidence: null, source: 'ai' }]);
    expect(ids(r)).not.toContain('tenant-fees');
    expect(ids(r)).not.toContain('flood');
    expect(r.questionsToAsk).toContain('Is there a lift to the flat?');
    expect(r.questionsToAsk.join(' ')).not.toMatch(/schools|families|illegal/);
  });
});

describe('AI import: the built-in reader on its own', () => {
  const extra = (text: string) => rulesOnlyResult(text).redFlags.map((x) => x.id)
    .filter((x) => !['no-epc', 'tenure-missing', 'council-tax', 'floor-area', 'service-charge', 'ground-rent', 'lease-unknown'].includes(x));

  it('does not raise flags on negated or look-alike wording', () => {
    for (const t of [
      'Flat to rent £1,200 pcm. No admin fees. London SE22 8JL.',
      'Flat to rent £1,200 pcm. No admin, referencing or check-out fees. London SE22 8JL.',
      'Flat to rent £1,200 pcm. Admin fees: none. London SE22 8JL.',
      'House for sale £300,000. Not subject to auction. London SE22 8JL.',
      'House for sale £300,000. Flooded with natural light. Light-flooded kitchen. Floods of natural light. London SE22 8JL.',
      'Freehold detached house for sale £600,000. Contemporary timber cladding to the rear extension. London SE22 8JL.',
      'House for sale £300,000. Free of Japanese knotweed. Timber-framed windows. Probate granted. London SE22 8JL.',
    ]) expect(extra(t), t).toEqual([]);
  });

  it('still raises them when the wording really says so', () => {
    expect(extra('Flat to rent £1,200 pcm. Admin fee £150. London SE22 8JL.')).toContain('tenant-fees');
    expect(extra('House for sale £300,000. For sale by auction. London SE22 8JL.')).toContain('auction');
    expect(extra('House for sale £300,000. No onward chain, cash buyers only. London SE22 8JL.')).toContain('cash-only');
    expect(extra('House for sale £300,000. The cellar flooded in 2019. London SE22 8JL.')).toContain('flood');
    expect(extra('Leasehold flat for sale £300,000. 120 years remaining. Cladding on the building. London SE22 8JL.')).toContain('cladding');
    expect(extra('Freehold house for sale £600,000. EWS1 form available for the cladding. London SE22 8JL.')).toContain('cladding');
  });

  it('reads the sale price, not a monthly charge, and keeps each charge’s period', () => {
    const r = rulesOnlyResult('Two bedroom flat for sale. Price £250,000. Leasehold, 95 years remaining. Service charge £100 per month. Ground rent £250 per annum. London SE22 8JL.');
    expect(r.values).toMatchObject({ listing: 'sale', price: 250000, serviceChargeAnnual: 1200, groundRentAnnual: 250, leaseYears: 95 });
    expect(r.redFlags.map((x) => x.id)).not.toContain('ground-rent');
    expect(r.redFlags.map((x) => x.id)).not.toContain('service-charge');
    expect(r.questionsToAsk.join(' ')).not.toMatch(/ground rent/i);
    const q = rulesOnlyResult('Flat for sale. £250,000. Leasehold, 110 years left. Service charge: £300 quarterly. Ground rent: £125 half yearly. London SE22 8JL.');
    expect(q.values).toMatchObject({ listing: 'sale', price: 250000, serviceChargeAnnual: 1200, groundRentAnnual: 250 });
    // the ground rent stays "stated" in the text even if it was cleared on the page
    const cleared = rulesOnlyResult('Leasehold flat for sale. £250,000. 110 years left. Ground rent £250 pa. London SE22 8JL.');
    expect(cleared.redFlags.map((x) => x.id)).not.toContain('ground-rent');
  });
});

/* ───────────── labelled facts, age and condition, and the AI's own flags ───────────── */
describe('AI import: labelled facts, quotes, age and condition, and the AI’s own flags', () => {
  const read = (over: Partial<Record<keyof Extraction, unknown>>) => ({ ...EMPTY, ...over }) as unknown as Extraction;
  // Laid out as Rightmove pages copy: key features, a facts row and labelled tenure.
  const RIGHTMOVE = `2 bedroom flat for sale
Flat 12, Marlowe Court, Forest Road, London E17 6JF
Guide Price £325,000

KEY FEATURES
- Two double bedrooms
- Share of freehold option not available
- EPC Rating: D

PROPERTY TYPE: Flat   BEDROOMS: x2   BATHROOMS: x1   SIZE: 721 sq ft

Tenure: Leasehold. Length of lease: 68 years remaining
Service charge: £2,400 per annum
Ground rent: £350 per annum (doubling every 10 years)
Council Tax Band: C

A bright second floor apartment flooded with natural light.`;

  it('reads labelled tenure and room counts, quotes what it read and flags the short lease', () => {
    const r = rulesOnlyResult(RIGHTMOVE);
    expect(r.values).toMatchObject({ tenure: 'leasehold', beds: 2, baths: 1, leaseYears: 68, serviceChargeAnnual: 2400, groundRentAnnual: 350, epc: 'D', councilTax: 'C' });
    expect(r.fields.tenure).toEqual({ confidence: 'stated', evidence: 'Tenure: Leasehold. Length of lease: 68 years remaining', source: 'rules' });
    expect(r.fields.baths).toMatchObject({ confidence: 'stated', evidence: expect.stringContaining('BATHROOMS: x1') });
    // every value marked "stated" carries the words it was read from
    for (const [k, info] of Object.entries(r.fields)) if (info?.confidence === 'stated') expect(info.evidence, k).toBeTruthy();
    expect(r.fields.listing?.confidence).toBe('inferred');
    expect(r.redFlags.find((x) => x.id === 'short-lease')).toMatchObject({ severity: 'high' });
    // the count on the line after its label, or straight after "×"; room sizes aren't counts
    expect(rulesOnlyResult('Flat for sale £300,000\nBEDROOMS\n×3\nBATHROOMS\n×2').values).toMatchObject({ beds: 3, baths: 2 });
    expect(rulesOnlyResult('Flat for sale £300,000. BEDROOMS ×2 BATHROOMS ×1').values).toMatchObject({ beds: 2, baths: 1 });
    expect(rulesOnlyResult('Flat for sale £300,000. Bedroom 1: 3.5m x 3.0m. Bedroom 2: 2.9m x 2.5m.').values.beds).toBeUndefined();
  });

  it('reads tenure from its label and ignores negated or cancelled mentions', () => {
    expect(tenureOf('Share of freehold option not available. Tenure: Leasehold')?.value).toBe('leasehold');
    expect(tenureOf('Share of freehold option not available. Leasehold flat.')?.value).toBe('leasehold');
    expect(tenureOf('Leasehold with a share of the freehold')?.value).toBe('share-of-freehold');
    expect(tenureOf('Not freehold. Leasehold.')?.value).toBe('leasehold');
    expect(tenureOf('Tenure: Freehold')?.value).toBe('freehold');
    expect(tenureOf('Lovely garden')).toBeNull();
  });

  it('applies the lease checks to a share of freehold once the lease length is known', () => {
    expect(ruleFlags({ tenure: 'share-of-freehold', leaseYears: 68 }, '').map((x) => x.id)).toContain('short-lease');
    expect(ruleFlags({ tenure: 'share-of-freehold', leaseYears: 90 }, '').map((x) => x.id)).toContain('lease-under-100');
    expect(ruleFlags({ tenure: 'share-of-freehold' }, '').map((x) => x.id)).not.toContain('lease-unknown');
  });

  it('keeps the labelled reading when the AI quotes a cancelled mention or disagrees with a label', () => {
    const r = mergeExtraction(read({ tenure: f('share-of-freehold', 'stated', 'Share of freehold option not available') }), RIGHTMOVE, '');
    expect(r.values.tenure).toBe('leasehold');
    expect(r.fields.tenure).toMatchObject({ source: 'rules', confidence: 'stated', evidence: expect.stringMatching(/^Tenure: Leasehold/) });
    expect(r.redFlags.map((x) => x.id)).toContain('short-lease');
    expect(r.fields.baths).toMatchObject({ source: 'rules', confidence: 'stated' }); // the AI found none: the rule reader's, with its quote
    const text = 'Three bedroom house for sale £400,000. Freehold. London E17 6JF.\nBEDROOMS: 2 (the third is now a study)';
    const beds = mergeExtraction(read({ beds: f(3, 'stated', 'Three bedroom house') }), text, '');
    expect(beds.values.beds).toBe(2);
    expect(beds.fields.beds).toMatchObject({ confidence: 'inferred', source: 'rules', alt: { value: 3, evidence: 'Three bedroom house' } });
  });

  it('drops an age or condition the AI can’t quote a clue for, and keeps the ones it can as inferred', () => {
    const text = 'Three bedroom terraced house for sale. £450,000. Freehold. London E17 6JF. Lovely garden. Requires modernisation throughout.';
    const none = mergeExtraction(read({ era: f('pre-1919', 'stated', 'Lovely garden'), condition: f('good', 'inferred', null) }), text, '');
    expect(none.values.era).toBeUndefined();
    expect(none.found).not.toContain('age');
    expect(none.values.condition).toBe('poor'); // the rule reader's, from the wording
    expect(none.fields.condition).toMatchObject({ source: 'rules', confidence: 'inferred', evidence: expect.stringMatching(/Requires modernisation/) });
    const victorian = 'Victorian three bedroom terraced house for sale. £450,000. Freehold. London E17 6JF. Beautifully presented.';
    const ok = mergeExtraction(read({ era: f('pre-1919', 'stated', 'Victorian three bedroom'), condition: f('good', 'stated', 'Beautifully presented') }), victorian, '');
    expect(ok.values).toMatchObject({ era: 'pre-1919', condition: 'good' });
    expect(ok.fields.era).toMatchObject({ confidence: 'inferred', evidence: 'Victorian three bedroom' });
    expect(ok.fields.condition?.confidence).toBe('inferred');
    // a quote that says otherwise doesn't support it: the rule reader's reading stays
    expect(mergeExtraction(read({ condition: f('derelict', 'stated', 'Beautifully presented') }), victorian, '').values.condition).toBe('good');
    expect(mergeExtraction(read({ era: f('2000+', 'stated', 'Victorian three bedroom') }), victorian, '').values.era).toBe('pre-1919');
    // no clue anywhere: no age or condition at all (the estimate uses its defaults)
    const plain = mergeExtraction(read({ era: f('1945-1979', 'inferred', null), condition: f('fair', 'inferred', 'Freehold') }), 'Three bedroom house for sale. £450,000. Freehold. London E17 6JF.', '');
    expect(plain.values.era).toBeUndefined();
    expect(plain.values.condition).toBeUndefined();
  });

  it('keeps the AI’s quoted flags only when the title is about the quote and names a concern', () => {
    const text = 'Bright three-bedroom terrace with a south-facing garden. Freehold. £500,000. London E17 6JF. EPC C. Council tax band D. 95 sq m. The boiler is 25 years old. There is a shared driveway with the neighbour.';
    const r = mergeExtraction(read({ redFlags: [
      { kind: 'stated', severity: 'high', title: 'Bright three-bedroom terrace with a south-facing garden', detail: 'Worth a look.', evidence: 'The boiler is 25 years old' },
      { kind: 'stated', severity: 'high', title: 'South-facing garden', detail: 'A lovely garden.', evidence: 'south-facing garden' },
      { kind: 'stated', severity: 'high', title: 'Old boiler may need replacing', detail: 'Ask when it was last serviced.', evidence: 'The boiler is 25 years old' },
      { kind: 'stated', severity: 'medium', title: 'Shared driveway', detail: 'Ask who maintains it.', evidence: 'shared driveway with the neighbour' },
    ] }), text, '');
    const ai = r.redFlags.filter((x) => x.source === 'ai');
    expect(ai.map((x) => x.title)).toEqual(['Old boiler may need replacing', 'Shared driveway']);
    expect(ai.map((x) => x.severity)).toEqual(['medium', 'medium']); // not one of the rules' topics: at most medium
  });

  it('reads a flag title for polarity: positive features quoted from the listing are never “things to check”', () => {
    const text = 'Three bedroom terraced house for sale. £450,000. Freehold. London E17 6JF. EPC C. Council tax band D. 95 sq m. Recently refurbished kitchen. Modernised throughout. No onward chain. Newly fitted bathroom. Close to the railway station. Spacious shared garden. No admin fees. Updated electrics in 2024. Low risk of flooding. No work needed. Long lease. Not overlooked. '
      + 'The roof needs some repairs. Shared driveway with the neighbour. Backs onto the railway line. Damp in the cellar. Lease length not stated. Lift not working.';
    const kept = (title: string, evidence = title) => mergeExtraction(read({ redFlags: [{ kind: 'stated', severity: 'high', title, detail: 'Worth knowing.', evidence }] }), text, '').redFlags.filter((x) => x.source === 'ai');
    const positives: [string, string?][] = [
      ['Recently refurbished kitchen'], ['Modernised throughout'], ['No onward chain'], ['Newly fitted bathroom'], ['Close to the railway station'],
      ['Spacious shared garden'], ['No admin fees'], ['Updated electrics', 'Updated electrics in 2024'], ['Low risk of flooding'], ['No work needed'], ['Long lease'], ['Not overlooked'],
    ];
    for (const [title, evidence] of positives) expect(kept(title, evidence), title).toEqual([]);
    const concerns = ['Roof needs some repairs', 'Shared driveway', 'Backs onto the railway line', 'Damp in the cellar', 'Lease length not stated', 'Lift not working'];
    const quotes: Record<string, string> = { 'Roof needs some repairs': 'The roof needs some repairs', 'Shared driveway': 'Shared driveway with the neighbour' };
    for (const title of concerns) expect(kept(title, quotes[title] ?? title).map((x) => [x.title, x.severity]), title).toEqual([[title, 'medium']]);
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
      const { c, user } = await verifiedSignUp();
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
      // daily limit, with when the next design can be made
      expect((await send(c.cookie)).status).toBe(202);
      const third = await (await getApp()).inject({ method: 'POST', url: '/api/ai/room-image', payload: photo().payload, headers: { ...photo().headers, cookie: c.cookie } });
      expect(third.statusCode).toBe(429);
      const err = third.json().error;
      expect(err).toMatchObject({ code: 'quota' });
      expect(err.message).toMatch(/today’s 2 AI designs\. You can create another in about \d+ hours?/);
      expect(Number(err.fields.retryAfter)).toBeGreaterThan(23 * 3600);
      expect(third.headers['retry-after']).toBe(err.fields.retryAfter);
      const hist = (await c.get('/api/ai/room-images')).json.items;
      expect(hist).toHaveLength(2);
      expect(hist.every((h: { status: string }) => h.status === 'done')).toBe(true);
    } finally { config.ai.dailyImagesPerUser = prevLimit; ai.restore(); }
  });

  it('needs a confirmed email address before redesigning or analysing a photo', async () => {
    const ai = mockOpenAI({ images: () => TINY_PNG, chat: () => reply.json({}) });
    try {
      const { c, user } = await signUp();
      const r = await send(c.cookie);
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe('verify_email');
      expect(r.json.error.message).toMatch(/Confirm your email address/);
      const m = multipart([{ field: 'photo', name: 'room.jpg', type: 'image/jpeg', data: jpegWithExif() }], { consent: 'true' });
      const d = await (await getApp()).inject({ method: 'POST', url: '/api/ai/design/describe-photo', payload: m.payload, headers: { ...m.headers, cookie: c.cookie } });
      expect(d.statusCode).toBe(403);
      expect(d.json().error.code).toBe('verify_email');
      expect(await q('SELECT 1 FROM ai_images WHERE user_id = $1', [user.id])).toHaveLength(0);
      expect(ai.calls('images')).toHaveLength(0);
      expect(ai.calls('chat')).toHaveLength(0);
    } finally { ai.restore(); }
  });

  it('re-checks the daily limit under a lock once the upload is in, so parallel uploads can’t all pass it', async () => {
    const ai = mockOpenAI({ images: () => TINY_PNG });
    const prevLimit = config.ai.dailyImagesPerUser;
    config.ai.dailyImagesPerUser = 1;
    const holder = await pool.connect();
    try {
      const { c, user } = await verifiedSignUp();
      // Another upload from this person is between its check and its insert, holding the lock.
      await holder.query('BEGIN');
      await lockImageAllowance(user.id, holder);
      let settled = false;
      const pending = send(c.cookie).then((r) => { settled = true; return r; });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // the fast check before the upload passed; now it waits for the lock
      await holder.query(`INSERT INTO ai_images (user_id, room, style, prompt, model, status) VALUES ($1, 'kitchen', 'Modern', 'x', 'gpt-image-1', 'running')`, [user.id]);
      await holder.query('COMMIT');
      const r = await pending;
      expect(r.status).toBe(429);
      expect(r.json.error.code).toBe('quota');
      expect(await q('SELECT 1 FROM ai_images WHERE user_id = $1', [user.id])).toHaveLength(1);
      expect(ai.calls('images')).toHaveLength(0);

      // End to end: several uploads at once never go over the limit.
      config.ai.dailyImagesPerUser = 2;
      const other = await verifiedSignUp();
      const codes = (await Promise.all(Array.from({ length: 4 }, () => send(other.c.cookie)))).map((x) => x.status).sort();
      expect(codes).toEqual([202, 202, 429, 429]);
      expect(await q(`SELECT 1 FROM ai_images WHERE user_id = $1 AND status <> 'failed'`, [other.user.id])).toHaveLength(2);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
      config.ai.dailyImagesPerUser = prevLimit; ai.restore();
    }
  });

  it('stops new designs once the whole site has reached its daily cap, and says when to try again', async () => {
    const ai = mockOpenAI({ images: () => TINY_PNG });
    const prevSite = config.ai.dailyImagesSite;
    try {
      const { c, user } = await verifiedSignUp();
      await q(`INSERT INTO ai_images (user_id, room, style, prompt, model, status) VALUES ($1, 'kitchen', 'Modern', 'x', 'gpt-image-1', 'done')`, [(await signUp()).user.id]);
      const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int n FROM ai_images WHERE status <> 'failed' AND created_at > now() - interval '24 hours'`);
      config.ai.dailyImagesSite = n;
      const r = await send(c.cookie);
      expect(r.status).toBe(429);
      expect(r.json.error.code).toBe('site_quota');
      expect(r.json.error.message).toMatch(/limit for today across the whole site/);
      expect(Number(r.json.error.fields.retryAfter)).toBeGreaterThan(0);
      expect(await q('SELECT 1 FROM ai_images WHERE user_id = $1', [user.id])).toHaveLength(0);
      expect(ai.calls('images')).toHaveLength(0);
      config.ai.dailyImagesSite = n + 1;
      expect((await send(c.cookie)).status).toBe(202);
      config.ai.dailyImagesSite = 0; // 0 switches the site-wide cap off
      expect((await send(c.cookie)).status).toBe(202);
    } finally { config.ai.dailyImagesSite = prevSite; ai.restore(); }
  });

  it('marks the design as failed with a safe message when the AI declines, without using up the limit', async () => {
    const ai = mockOpenAI({ images: () => ({ status: 400, error: { message: 'Your request was rejected as a result of our safety system. sk-proj-SECRETKEY123' } }) });
    const prevLimit = config.ai.dailyImagesPerUser;
    config.ai.dailyImagesPerUser = 1;
    try {
      const { c } = await verifiedSignUp();
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
      const { c } = await verifiedSignUp();
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

  it('closes out designs that have been running for more than 30 minutes, and leaves recent ones alone', async () => {
    const { c, user } = await signUp();
    const [old] = await q<{ id: string }>(`INSERT INTO ai_images (user_id, room, style, prompt, model, status, created_at) VALUES ($1, 'kitchen', 'Modern', 'x', 'gpt-image-1', 'running', now() - interval '31 minutes') RETURNING id`, [user.id]);
    const [recent] = await q<{ id: string }>(`INSERT INTO ai_images (user_id, room, style, prompt, model, status, created_at) VALUES ($1, 'kitchen', 'Modern', 'x', 'gpt-image-1', 'running', now() - interval '5 minutes') RETURNING id`, [user.id]);
    const other = await signUp();
    const [theirs] = await q<{ id: string }>(`INSERT INTO ai_images (user_id, room, style, prompt, model, status, created_at) VALUES ($1, 'kitchen', 'Modern', 'x', 'gpt-image-1', 'running', now() - interval '31 minutes') RETURNING id`, [other.user.id]);
    const hist = (await c.get('/api/ai/room-images')).json.items;
    expect(hist.find((h: { id: string }) => h.id === old.id)).toMatchObject({ status: 'failed', error: 'This design didn’t finish. Please try again.' });
    expect(hist.find((h: { id: string }) => h.id === recent.id)).toMatchObject({ status: 'running', error: null });
    expect(hist.find((h: { id: string }) => h.id === theirs.id)).toBeUndefined();
    // only your own designs are touched
    expect((await q<{ status: string }>('SELECT status FROM ai_images WHERE id = $1', [theirs.id]))[0].status).toBe('running');
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

  it('follows the room and style the brief names when the AI reads others', async () => {
    const ai = mockOpenAI({ chat: () => reply.json({ ...PLAN, room: 'kitchen', styleId: 'modern', tier: 'standard', budget: 3500 }) });
    try {
      const b = (await client().post('/api/ai/design/brief', { text: 'Scandinavian bedroom for £3,500, keep the wooden floor', room: 'kitchen', postcode: 'E17 4QH' })).json;
      expect(b).toMatchObject({ engine: 'ai', room: 'bedroom', styleId: 'scandi', styleName: 'Scandinavian', budget: 3500 });
      expect(b.note).toMatch(/suggested a kitchen, Modern, but your brief asks for a bedroom, Scandinavian/);
      // the model's materials and notes were for another room and style: the catalogue's are used
      expect(b.materials.length).toBeGreaterThan(0);
      expect(b.materials.every((m: { why: string }) => /cost catalogue/.test(m.why))).toBe(true);
      expect(b.notes).toBe('');
      expect(b.cost.total).toBe(designCost('bedroom', b.tier, DEFAULT_DIMS, 'E17 4QH', { furniture: true }).total);
    } finally { ai.restore(); }
    // A brief that names no room or style: the model's reading is used.
    const plan = (o: Record<string, unknown>) => ({ ...PLAN, ...o }) as unknown as Parameters<typeof groundBrief>[0];
    const free = groundBrief(plan({ room: 'bedroom', styleId: 'industrial', tier: 'standard', budget: null }), { text: 'Something warm and cosy with lots of texture', room: 'living' });
    expect(free).toMatchObject({ room: 'bedroom', styleId: 'industrial', note: null });
    // A brief naming two rooms: the model may choose either of them.
    expect(groundBrief(plan({ room: 'living', budget: null }), { text: 'Open-plan kitchen and living space, Scandinavian' }).room).toBe('living');
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

describe('Design brief reader (built-in rules)', () => {
  it('reads a budget without swallowing punctuation or the next word', () => {
    expect(briefBudget('Scandinavian bedroom for £3,500, keep the wooden floor')).toBe(3500); // not £3,500,000
    expect(briefBudget('Kitchen for £5k')).toBe(5000);
    expect(briefBudget('£5k kitchen')).toBe(5000);
    expect(briefBudget('£8,000 kitchen')).toBe(8000);
    expect(briefBudget('£5 kitchen refresh')).toBeUndefined(); // the "k" of kitchen isn't thousands, and £5 isn't a budget
    expect(briefBudget('£3,500.')).toBe(3500);
    expect(briefBudget('£4,250.50 for the bathroom')).toBe(4251);
    expect(briefBudget('A budget of 4500 for the bathroom')).toBe(4500);
    expect(briefBudget('Around 6k pounds')).toBe(6000);
    expect(briefBudget('2 bedrooms, no budget yet')).toBeUndefined();
    expect(parseDesignBrief('Scandinavian bedroom for £3,500, keep the wooden floor')).toEqual({ room: 'bedroom', budget: 3500, style: 'scandi' });
  });

  it('names rooms and styles only as whole words, first mentioned first', () => {
    expect(briefMentions('New bedside lamps and a toilet roll holder')).toEqual({ rooms: [], styles: [] });
    expect(briefMentions('Modernise the bathroom').styles).toEqual([]);
    expect(briefMentions('Bedroom with an en-suite bathroom').rooms).toEqual(['bedroom', 'bathroom']);
    expect(briefMentions('Living room with a sofa bed').rooms[0]).toBe('living');
    expect(briefMentions('Scandinavian with a modern twist').styles).toEqual(['scandi', 'modern']);
    expect(parseDesignBrief('Modernise this rental flat bathroom for £4,000')).toEqual({ room: 'bathroom', budget: 4000, style: 'rental' });
  });

  it('keeps the studio’s budget designer within its range', () => {
    expect(studioBudget(3_500_000)).toEqual({ value: 40_000, clamped: true });
    expect(studioBudget(500)).toEqual({ value: 1500, clamped: true });
    expect(studioBudget(3500)).toEqual({ value: 3500, clamped: false });
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
      const { c } = await verifiedSignUp();
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
      const { c } = await verifiedSignUp();
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

  it('answers with a safe message when the vision model fails, without caching the failure', async () => {
    let fail = true;
    const ai = mockOpenAI({ chat: () => (fail ? { status: 500, error: { message: 'upstream exploded sk-proj-SECRETKEY123' } } : reply.json(ANALYSIS)) });
    try {
      const { c } = await verifiedSignUp();
      const bathroom = () => form({ consent: 'true', room: 'bathroom' }); // a photo and hint not cached by earlier tests
      const r = await send(c.cookie, bathroom());
      expect(r.status).toBe(502);
      expect(r.json.error.message).toBe('The AI service had a problem. Please try again.');
      expect(JSON.stringify(r.json)).not.toMatch(/exploded|SECRETKEY/);
      fail = false;
      const again = await send(c.cookie, bathroom());
      expect(again.status).toBe(200);
      expect(again.json.analysis.isRoom).toBe(true);
    } finally { ai.restore(); }
  });

  it('says so when the photo is not of a room', async () => {
    const ai = mockOpenAI({ chat: () => reply.json({ ...ANALYSIS, isRoom: false, room: 'other' }) });
    try {
      const { c } = await verifiedSignUp();
      const r = await send(c.cookie, form({ consent: 'true' }, TINY_PNG, 'image/png'));
      expect(r.status).toBe(200);
      expect(r.json.analysis).toMatchObject({ isRoom: false, room: null, keepWorthy: [], problems: [], suggestedStyleIds: [] });
    } finally { ai.restore(); }
  });
});
