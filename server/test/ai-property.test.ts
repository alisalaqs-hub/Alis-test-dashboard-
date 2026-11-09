import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT, estimateRefurb, type RefurbInput } from '../../src/engine/refurb';
import { analyse, DEFAULT_INVESTMENT, scenario, type InvestmentInput } from '../../src/engine/investment';
import { getProperty } from '../../src/data/properties';
import {
  applyPhotoScope, CONDITIONS, homeModel, money, pc, PHOTO_ELEMENTS, photoDetailsKey, planOptions, ruleVerdict, VERDICTS,
  type HomeFacts, type PhotoItem, type PhotoObservation, type RefurbPhotoFacts, type RefurbPhotosResult,
} from '../../src/lib/ai/property';
import type { Condition } from '../../src/engine/refurb';
import { q } from '../src/db';
import { getFile } from '../src/services/storage';
import { isAllowed, isPercentAllowed, moneyMentions, percentMentions, scrubList, scrubText } from '../src/ai/property/figures';
import { investPack, ruleAssumptions } from '../src/ai/property/invest';
import { mapObservations, overallCondition } from '../src/ai/property/photos';
import { client, jpegWithExif, multipart, signUp } from './helpers';
import { mockOpenAI, reply } from './openai-mock';

type Client = ReturnType<typeof client>;

const FACTS: RefurbPhotoFacts = {
  postcode: 'E17 4QH', propertyType: 'terraced', floorArea: 92, bedrooms: 3, bathrooms: 1, storeys: 2, era: 'pre-1919',
  access: 'restricted', spec: 'standard', vat: 'standard', includeProfessionalFees: true,
  planned: { structuralOpenings: 1, extensionArea: 0, loftArea: 0, ensuites: 0, solidWallInsulation: false, groundworksArea: 0, fitOut: 'none', officeToResiArea: 0 },
};

function upload(c: Client, files: { name: string; type: string; data: Buffer }[], fields: Record<string, string> = { consent: 'true', facts: JSON.stringify(FACTS) }) {
  const m = multipart(files.map((f) => ({ field: 'photos', ...f })), fields);
  return c.raw('POST', '/api/ai/refurb/from-photos', m.payload, m.headers);
}
const photos = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `room-${i + 1}.jpg`, type: 'image/jpeg', data: jpegWithExif() }));

/** Images in a chat request, and their detail setting. */
const imagesIn = (body: any) => (body.messages[1].content as any[]).filter((p) => p.type === 'image_url'); // eslint-disable-line @typescript-eslint/no-explicit-any

/** What the "vision model" sees: first call gets photos 1–4, second gets photos 5–6. */
const FIRST_FOUR = {
  photos: [
    { photo: 1, isProperty: true, room: 'Kitchen', condition: 'poor', confidence: 'high', items: [
      { element: 'kitchen units', observation: 'Dated units with damaged doors; a new kitchen would cost £8,000.', likelyAction: 'replace' },
      { element: 'flooring', observation: 'Lifting vinyl', likelyAction: 'replace' },
      { element: 'wiring', observation: 'Old round-pin sockets visible', likelyAction: 'investigate' },
    ] },
    { photo: 2, isProperty: true, room: 'Bathroom', condition: 'poor', confidence: 'medium', items: [
      { element: 'bathroom suite', observation: 'Cracked bath and old suite', likelyAction: 'replace' },
      { element: 'damp signs', observation: 'Black mould on the ceiling', likelyAction: 'investigate' },
    ] },
    { photo: 3, isProperty: true, room: 'Front elevation', condition: 'fair', confidence: 'medium', items: [
      { element: 'windows', observation: 'Modern uPVC double glazing', likelyAction: 'keep' },
      { element: 'roof covering', observation: 'A few slipped slates', likelyAction: 'refresh' },
      { element: 'external walls', observation: 'Pointing worn in places', likelyAction: 'refresh' },
    ] },
    { photo: 4, isProperty: true, room: 'Living room', condition: 'fair', confidence: 'high', items: [
      { element: 'plaster', observation: 'Cracked ceiling plaster', likelyAction: 'refresh' },
      { element: 'decoration', observation: 'Tired paintwork', likelyAction: 'refresh' },
      { element: 'heating', observation: 'Old steel radiators', likelyAction: 'replace' },
    ] },
  ],
  surveyorQuestions: ['Is the mould from condensation or a leak?', 'Will the roof cost more than £5,000?'],
};
const LAST_TWO = {
  photos: [
    { photo: 1, isProperty: true, room: 'Bedroom', condition: 'fair', confidence: 'medium', items: [
      { element: 'flooring', observation: 'Worn carpet', likelyAction: 'refresh' },
      { element: 'decoration', observation: 'Scuffed walls', likelyAction: 'refresh' },
    ] },
    { photo: 2, isProperty: false, room: 'Cat', condition: 'fair', confidence: 'low', items: [] },
  ],
  surveyorQuestions: [],
};

describe('renovation estimate from photos', () => {
  it('maps the vision observations into the cost engine and prices them with estimateRefurb', async () => {
    const ai = mockOpenAI({ chat: (body) => reply.json(imagesIn(body).length === 4 ? FIRST_FOUR : LAST_TWO) });
    try {
      const { c, user } = await signUp();
      const r = await upload(c, photos(6));
      expect(r.status).toBe(202);
      expect(r.json.jobId).toMatch(/^[0-9a-f-]{36}$/);

      const polled = await c.get(`/api/ai/jobs/${r.json.jobId}`);
      expect(polled.json.job.status).toBe('done');
      const out = polled.json.job.output as RefurbPhotosResult;

      // Vision: role 'vision' model, high detail, at most 4 photos per call (6 photos → 4 + 2), strict JSON schema.
      const chats = ai.calls('chat');
      expect(chats).toHaveLength(2);
      expect(chats.map((x) => imagesIn(x.body).length).sort()).toEqual([2, 4]);
      for (const x of chats) {
        expect(x.body.model).toBe('gpt-5-mini');
        expect(x.body.response_format.json_schema.strict).toBe(true);
        expect(imagesIn(x.body).every((p: { image_url: { detail: string } }) => p.image_url.detail === 'high')).toBe(true);
      }
      // Location metadata never leaves the server.
      const sent = Buffer.from(imagesIn(chats[0].body)[0].image_url.url.split(',')[1], 'base64');
      expect(sent.includes(Buffer.from('secret-location'))).toBe(false);

      // The mapping, in code.
      expect(out.overall).toMatchObject({ condition: 'fair', photosUsed: 5, photosSent: 6 });
      const s = out.scope.scope;
      expect(out.scope).toMatchObject({ postcode: 'E17 4QH', propertyType: 'terraced', floorArea: 92, bedrooms: 3, bathrooms: 1, era: 'pre-1919', condition: 'fair', access: 'restricted', spec: 'standard' });
      expect(s).toMatchObject({
        kitchen: true, windows: false, roof: 'repair', rewire: false, heating: 'full', replaster: 'skim', damp: true, flooring: true,
        external: true, stripOut: true, decoration: true, structuralOpenings: 1, extensionArea: 0, loftArea: 0, insulation: true,
      });
      // The estimate is exactly the engine's estimate of the mapped scope.
      expect(out.estimate).toEqual(estimateRefurb(out.scope));
      expect(out.estimate.total).toBeGreaterThan(0);

      // How each item was decided, and honest notes.
      expect(out.basis.find((b) => b.item === 'Kitchen')).toMatchObject({ source: 'photos', value: 'New kitchen' });
      // Old sockets flagged on a home in fair condition: the fair-condition electrics allowance is kept (never less), pending an EICR.
      expect(out.basis.find((b) => b.item === 'Electrics')).toMatchObject({ source: 'photos', value: 'Upgrades and safety remedials' });
      expect(out.basis.find((b) => b.item === 'Electrics')!.note).toMatch(/EICR/);
      expect(out.basis.find((b) => b.item === 'Loft insulation')).toMatchObject({ source: 'assumed' });
      expect(out.basis.find((b) => b.item === 'Your plans')).toMatchObject({ source: 'yours' });
      expect(out.observations).toHaveLength(6);
      expect(out.observations[5]).toMatchObject({ photo: 6, isProperty: false, items: [] });
      expect(out.observations[0].items[0].observation).not.toMatch(/£/); // money never shown from the vision model
      expect(out.caveats.join(' ')).toMatch(/not a survey/);
      expect(out.caveats.join(' ')).toMatch(/didn’t appear to show the property/);
      expect(out.questionsForSurveyor.some((x) => /EICR/.test(x))).toBe(true);
      expect(out.questionsForSurveyor).toContain('Is the mould from condensation or a leak?');
      expect(out.questionsForSurveyor.join(' ')).not.toMatch(/£/);

      // Photos are deleted once analysed; consent is recorded; other people can't read the job.
      const job = await q<{ input: { photos: { key: string }[] } }>('SELECT input FROM ai_jobs WHERE id = $1', [r.json.jobId]);
      expect(job[0].input.photos).toHaveLength(6);
      for (const p of job[0].input.photos) { expect(p.key.startsWith('ai/refurb/')).toBe(true); expect(await getFile(p.key)).toBeNull(); }
      expect((await q(`SELECT 1 FROM consents WHERE user_id = $1 AND purpose = 'ai_image_processing'`, [user.id])).length).toBe(1);
      const other = await signUp();
      expect((await other.c.get(`/api/ai/jobs/${r.json.jobId}`)).status).toBe(403);
      expect((await client().get(`/api/ai/jobs/${r.json.jobId}`)).status).toBe(403);
    } finally { ai.restore(); }
  });

  it('needs a signed-in user, consent, and real photos within the limits', async () => {
    const ai = mockOpenAI({ chat: () => reply.json(LAST_TWO) });
    try {
      expect((await upload(client(), photos(1))).status).toBe(401);
      const { c } = await signUp();
      const noConsent = await upload(c, photos(1), { facts: JSON.stringify(FACTS) });
      expect(noConsent.status).toBe(400);
      expect(noConsent.json.error.code).toBe('consent_required');
      const notImage = await upload(c, [{ name: 'notes.txt', type: 'image/jpeg', data: Buffer.from('not really a photo') }]);
      expect(notImage.status).toBe(400);
      expect(notImage.json.error.code).toBe('bad_photo');
      const tooMany = await upload(c, photos(9));
      expect(tooMany.status).toBe(413);
      expect(tooMany.json.error.code).toBe('too_many');
      const big = Buffer.concat([jpegWithExif(), Buffer.alloc(2 * 1024 * 1024 + 10)]);
      const tooBig = await upload(c, [{ name: 'huge.jpg', type: 'image/jpeg', data: big }]);
      expect(tooBig.status).toBe(413);
      expect(tooBig.json.error.message).toMatch(/2 MB/);
      // All the photos together must fit in one request the host will accept.
      const chunky = () => ({ name: 'chunky.jpg', type: 'image/jpeg', data: Buffer.concat([jpegWithExif(), Buffer.alloc(1.6 * 1024 * 1024)]) });
      const tooMuch = await upload(c, [chunky(), chunky(), chunky()]);
      expect(tooMuch.status).toBe(413);
      expect(tooMuch.json.error.code).toBe('too_large');
      expect(tooMuch.json.error.message).toMatch(/more than 4\.5 MB/);
      expect((await upload(c, [])).json.error.code).toBe('no_photos');
      const badFacts = await upload(c, photos(1), { consent: 'true', facts: JSON.stringify({ ...FACTS, floorArea: -5 }) });
      expect(badFacts.status).toBe(400);
      expect(badFacts.json.error.fields.floorArea).toBeTruthy();
      expect(ai.calls('chat')).toHaveLength(0);
    } finally { ai.restore(); }
    // AI switched off: the endpoint says so (the estimator keeps working without it).
    const { c } = await signUp();
    expect((await upload(c, photos(1))).status).toBe(503);
  });

  it('fails the job with a helpful message when no photo shows a property', async () => {
    const ai = mockOpenAI({ chat: () => reply.json({ photos: [{ photo: 1, isProperty: false, room: 'Dog', condition: 'fair', confidence: 'low', items: [] }], surveyorQuestions: [] }) });
    try {
      const { c } = await signUp();
      const r = await upload(c, photos(1));
      expect(r.status).toBe(202);
      const job = (await c.get(`/api/ai/jobs/${r.json.jobId}`)).json.job;
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/couldn’t see a room or building/);
      const row = await q<{ input: { photos: { key: string }[] } }>('SELECT input FROM ai_jobs WHERE id = $1', [r.json.jobId]);
      expect(await getFile(row[0].input.photos[0].key)).toBeNull();
    } finally { ai.restore(); }
  });

  it('falls back to condition-based defaults for anything not photographed, and keeps the person’s plans', () => {
    const obs: PhotoObservation[] = [{ photo: 1, analysed: true, isProperty: true, room: 'Kitchen', condition: 'derelict', confidence: 'high', items: [{ element: 'kitchen units', observation: 'Gutted', likelyAction: 'replace' }] }];
    expect(overallCondition(obs)).toBe('derelict');
    expect(overallCondition([...obs, { ...obs[0], condition: 'good' }, { ...obs[0], condition: 'good' }])).toBe('poor'); // never more than one step better than the worst photo
    const { scope, basis } = mapObservations(obs, { ...FACTS, planned: { ...FACTS.planned, loftArea: 25, structuralOpenings: 0 } });
    expect(scope.condition).toBe('derelict');
    expect(scope.scope).toMatchObject({ kitchen: true, rewire: true, heating: 'full', replaster: 'full', windows: true, loftArea: 25, structuralOpenings: 0 });
    expect(scope.bathrooms).toBe(1); // not photographed, derelict: assume the bathroom is refitted
    expect(basis.filter((b) => b.source === 'assumed').map((b) => b.item)).toEqual(expect.arrayContaining(['Electrics', 'Heating', 'Windows & external doors', 'Bathrooms to refit']));
    const flat = mapObservations([{ ...obs[0], condition: 'fair', items: [{ element: 'roof covering', observation: 'Old', likelyAction: 'replace' }] }], { ...FACTS, propertyType: 'flat' });
    expect(flat.scope.scope.roof).toBe('none'); // a flat's roof is the freeholder's
  });

  it('treats “investigate” as keeping the condition-based allowance, never as no work', () => {
    const facts: RefurbPhotoFacts = { ...FACTS, planned: { ...FACTS.planned, structuralOpenings: 0 } };
    const photo = (condition: Condition, items: PhotoItem[]): PhotoObservation[] => [{ photo: 1, analysed: true, isProperty: true, room: 'Hall', condition, confidence: 'high', items }];
    const total = (m: ReturnType<typeof mapObservations>) => estimateRefurb(m.scope).total;

    // A poor pre-1919 terrace with old sockets and an old boiler flagged: the rewire and heating allowances stay.
    const flagged = mapObservations(photo('poor', [
      { element: 'wiring', observation: 'Old round-pin sockets', likelyAction: 'investigate' },
      { element: 'boiler', observation: 'Very old floor-standing boiler', likelyAction: 'investigate' },
    ]), facts);
    const unphotographed = mapObservations(photo('poor', []), facts);
    expect(flagged.scope.scope).toMatchObject({ rewire: true, heating: 'full' });
    expect(total(flagged)).toBeGreaterThanOrEqual(total(unphotographed));
    expect(flagged.basis.find((b) => b.item === 'Electrics')!.note).toMatch(/Allowance kept until a professional inspects it/);
    expect(flagged.basis.find((b) => b.item === 'Heating')!.note).toMatch(/Allowance kept/);

    // Plaster flagged on a derelict home keeps the full re-plaster (not a cheaper skim); kitchen and windows keep theirs.
    const derelict = mapObservations(photo('derelict', [
      { element: 'plaster', observation: 'Cracked, possibly blown', likelyAction: 'investigate' },
      { element: 'kitchen units', observation: 'Water damage to the base units', likelyAction: 'investigate' },
      { element: 'windows', observation: 'Possible rot to the sashes', likelyAction: 'investigate' },
    ]), facts);
    expect(derelict.scope.scope).toMatchObject({ replaster: 'full', kitchen: true, windows: true });
    // A flagged boiler with radiators seen to be fine: a new boiler at least, even in good condition.
    expect(mapObservations(photo('good', [{ element: 'boiler', observation: 'Old boiler', likelyAction: 'investigate' }, { element: 'heating', observation: 'Modern radiators', likelyAction: 'keep' }]), facts).scope.scope.heating).toBe('boiler');

    // Any element flagged, alone or all together, in any condition: never cheaper than not photographing it.
    for (const condition of CONDITIONS) for (const propertyType of ['terraced', 'flat'] as const) {
      const f = { ...facts, propertyType };
      const none = total(mapObservations(photo(condition, []), f));
      const all = PHOTO_ELEMENTS.map((element): PhotoItem => ({ element, observation: 'Possible defect', likelyAction: 'investigate' }));
      expect(total(mapObservations(photo(condition, all), f))).toBeGreaterThanOrEqual(none);
      for (const item of all) expect(total(mapObservations(photo(condition, [item]), f)), `${condition} ${propertyType} ${item.element}`).toBeGreaterThanOrEqual(none);
    }
  });

  it('applies only the photo-derived parts of the scope to the estimator', () => {
    const before: RefurbInput = { ...DEFAULT_INPUT, condition: 'good', bathrooms: 2, scope: { ...DEFAULT_INPUT.scope, rewire: false, kitchen: false, heating: 'none' } };
    const photoScope: RefurbInput = { ...DEFAULT_INPUT, postcode: 'M14 5RB', floorArea: 60, spec: 'budget', vat: 'reduced-empty-2yrs', condition: 'poor', bathrooms: 1,
      scope: { ...DEFAULT_INPUT.scope, rewire: true, kitchen: true, heating: 'full', extensionArea: 0, loftArea: 0, structuralOpenings: 0 } };
    // The person changed their details and plans after analysing: those survive applying the photo scope.
    const current: RefurbInput = { ...before, postcode: 'E17 4QH', floorArea: 110, spec: 'premium', vat: 'standard', scope: { ...before.scope, extensionArea: 20, loftArea: 25, structuralOpenings: 2 } };
    const applied = applyPhotoScope(current, photoScope);
    expect(applied).toMatchObject({ postcode: 'E17 4QH', floorArea: 110, spec: 'premium', vat: 'standard', condition: 'poor', bathrooms: 1 });
    expect(applied.scope).toMatchObject({ rewire: true, kitchen: true, heating: 'full', extensionArea: 20, loftArea: 25, structuralOpenings: 2 });
    // Undo puts back only what the photos changed.
    expect(applyPhotoScope({ ...applied, floorArea: 120 }, current)).toEqual({ ...current, floorArea: 120 });
    // The stale check looks at the property details, not the scope the photos set.
    expect(photoDetailsKey(applied)).toBe(photoDetailsKey(current));
    expect(photoDetailsKey({ ...current, era: '2000+' })).not.toBe(photoDetailsKey(current));
  });
});

describe('explaining an estimate', () => {
  const input: RefurbInput = { ...DEFAULT_INPUT, postcode: 'M14 5RB', floorArea: 104 };

  it('recomputes the estimate from the input and strips £ figures the engine didn’t produce', async () => {
    const e = estimateRefurb(input);
    const top = e.byTrade[0];
    const allowance = '£1.5k–£8k'; // from the engine's hidden-defect register (pre-1919, so asbestos is listed)
    const ai = mockOpenAI({ chat: () => reply.json({
      summary: `The estimate is ${money(e.total)} including VAT. It will add £250,000 to the value of your home. Get three quotes before you commit.`,
      biggestCosts: [`${top.trade} is the biggest cost at ${money(top.total)}.`, 'Roofing will be £123,456.'],
      waysToSave: ['Choosing a budget kitchen saves £7,777,777.'],
      risks: [`Asbestos removal could add ${allowance}.`],
      nextSteps: ['Get three quotes against the exported scope.'],
    }) });
    try {
      const r = await client().post('/api/ai/refurb/explain', { input, estimate: { total: 1, low: 1, high: 2 } });
      expect(r.status).toBe(200);
      const x = r.json.explanation;
      expect(x.estimate).toEqual({ total: e.total, low: e.low, high: e.high, confidence: e.confidence });
      expect(x.summary).toContain(money(e.total));
      expect(x.summary).not.toMatch(/250,000/);
      expect(x.summary).toMatch(/three quotes/);
      expect(x.biggestCosts).toEqual([`${top.trade} is the biggest cost at ${money(top.total)}.`]);
      expect(x.waysToSave).toEqual([]);
      expect(x.risks).toHaveLength(1);
      expect(x.removedClaims).toBe(3);
      expect(x.disclaimer).toMatch(/Not a quote, survey or valuation/);

      // The model saw the recomputed figures, never the client's.
      const chats = ai.calls('chat');
      expect(chats).toHaveLength(1);
      expect(chats[0].body.model).toBe('gpt-5-mini'); // role 'fast'
      const prompt = chats[0].body.messages[1].content as string;
      expect(prompt).toContain(`"totalIncVat":${e.total}`);
      expect(chats[0].body.messages[0].content).toMatch(/Never add, subtract or combine figures/);

      // Same input again: answered from the cache.
      expect((await client().post('/api/ai/refurb/explain', { input })).json.explanation.summary).toBe(x.summary);
      expect(ai.calls('chat')).toHaveLength(1);

      // Validation.
      expect((await client().post('/api/ai/refurb/explain', { input: { ...input, floorArea: -1 } })).status).toBe(400);
      expect((await client().post('/api/ai/refurb/explain', { input: { ...input, scope: { ...input.scope, heating: 'nuclear' } } })).status).toBe(400);
    } finally { ai.restore(); }
  });

  it('says when AI is unavailable', async () => {
    const r = await client().post('/api/ai/refurb/explain', { input });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('ai_unavailable');
  });
});

describe('investment verdict', () => {
  it('grounds the verdict in recomputed numbers and never lets it be more optimistic than the rules', async () => {
    const inputs: InvestmentInput = { ...DEFAULT_INVESTMENT, strategy: 'btl', monthlyRent: 1_400 };
    const r = analyse(scenario(inputs, 'base'));
    const rule = ruleVerdict('btl', r, analyse(scenario(inputs, 'downside')));
    expect(r.monthlyCashflow).toBeLessThan(0);
    expect(rule.verdict).toBe('weak');
    const ai = mockOpenAI({ chat: () => reply.json({
      verdict: 'strong', headline: 'A brilliant deal that makes £5,000 a month.',
      strengths: ['Demand for rentals is high in the area.'],
      risks: [`Cash flow is ${money(r.monthlyCashflow)} a month before tax.`, 'Prices will rise by 50%, giving £200,000 profit.'],
      whatMustBeTrue: [`Rent of ${money(1_400)} a month is achieved.`],
      questionsToAsk: ['What rent have similar homes let for recently?'],
      stressTestReading: 'The stress test fails at the stressed rate.',
    }) });
    try {
      const res = await client().post('/api/ai/invest/explain', { propertyId: 'wal-001', strategy: 'btl', inputs: { ...inputs, strategy: 'flip' }, scenario: 'base', result: { monthlyCashflow: 99_999 } });
      expect(res.status).toBe(200);
      const v = res.json.verdict;
      expect(v.verdict).toBe('weak');
      expect(v.verdictCapped).toBe(true);
      expect(v.ruleVerdict).toBe('weak');
      expect(v.strategy).toBe('btl'); // the strategy field wins over inputs.strategy
      expect(v.numbers.monthlyCashflow).toBe(Math.round(r.monthlyCashflow));
      expect(v.numbers.icrPass).toBe(r.icrPass);
      expect(v.headline).toContain(money(r.monthlyCashflow)); // capped: Streetkey's own headline
      // Capped: the over-optimistic answer's strengths, assumptions and stress-test reading aren't used.
      expect(v.strengths).toEqual([]);
      expect(JSON.stringify(v)).not.toMatch(/Demand for rentals/);
      expect(v.whatMustBeTrue).toEqual(ruleAssumptions(inputs, scenario(inputs, 'base')));
      expect(v.whatMustBeTrue[0]).toContain(money(1_400));
      expect(v.stressTestReading).toMatch(/^The lender stress test (passes|fails)/);
      // Its risks and questions are kept (after the figure checks).
      expect(v.risks).toEqual([`Cash flow is ${money(r.monthlyCashflow)} a month before tax.`]);
      expect(v.questionsToAsk).toEqual(['What rent have similar homes let for recently?']);
      expect(v.removedClaims).toBe(1); // the made-up £200,000 profit; the replaced headline isn't counted
      expect(v.disclaimer).toMatch(/Not financial/);

      const chat = ai.calls('chat')[0].body;
      expect(chat.model).toBe('gpt-5'); // role 'main'
      const prompt = chat.messages[1].content as string;
      expect(prompt).toContain(`"monthlyCashflow":${Math.round(r.monthlyCashflow)}`);
      expect(prompt).toContain('"RULE_RATING":"weak"');
      expect(prompt).not.toContain('99999');
      expect(prompt).toContain(`<<<listing title\n${getProperty('wal-001')!.title}\n>>>`);
      expect(chat.messages[0].content).toMatch(/never a more optimistic one/);
      expect(chat.messages[0].content).toMatch(/Do not make claims about local demand/);
    } finally { ai.restore(); }
  });

  it('removes percentages and bare amounts the engine didn’t compute', async () => {
    const inputs: InvestmentInput = { ...DEFAULT_INVESTMENT, strategy: 'btl', monthlyRent: 3_400, refurbCost: 10_000 };
    const r = analyse(scenario(inputs, 'base'));
    const rule = ruleVerdict('btl', r, analyse(scenario(inputs, 'downside')));
    const { allowedPct } = investPack(inputs, 'base', null);
    const madeUp = 17.3;
    expect(allowedPct.some((a) => Math.abs(a - madeUp) < 0.5)).toBe(false); // guard: genuinely not a computed figure
    expect(allowedPct).toEqual(expect.arrayContaining([Number(pc(r.netYield).replace('%', ''))]));
    const ai = mockOpenAI({ chat: () => reply.json({
      verdict: rule.verdict, headline: `Cash flow of ${money(r.monthlyCashflow)} a month, a net yield of ${pc(r.netYield)}.`,
      strengths: [`The net yield is ${pc(r.netYield)} on these assumptions.`, `A net yield of ${madeUp}% beats most alternatives.`, 'Rents could reach 4,250 a month.'],
      risks: [`The gross yield is ${pc(r.grossYield)}, so costs matter.`, 'A refurb overrun of 8k would hurt.'],
      whatMustBeTrue: [`Rent of ${money(3_400)} a month is achieved.`],
      questionsToAsk: ['What rent have similar homes let for recently?'],
      stressTestReading: `Rent covers the stressed interest ${pc(r.icr, 0)} against ${pc(r.icrRequired, 0)} required. At a ${madeUp}% stress rate it would fail.`,
    }) });
    try {
      const res = await client().post('/api/ai/invest/explain', { strategy: 'btl', inputs, scenario: 'base' });
      expect(res.status).toBe(200);
      const v = res.json.verdict;
      expect(v.verdictCapped).toBe(false);
      expect(v.headline).toContain(pc(r.netYield));
      expect(v.strengths).toEqual([`The net yield is ${pc(r.netYield)} on these assumptions.`]);
      expect(v.risks).toEqual([`The gross yield is ${pc(r.grossYield)}, so costs matter.`]);
      expect(v.whatMustBeTrue).toEqual([`Rent of ${money(3_400)} a month is achieved.`]);
      expect(v.stressTestReading).toBe(`Rent covers the stressed interest ${pc(r.icr, 0)} against ${pc(r.icrRequired, 0)} required.`);
      expect(v.removedClaims).toBe(4);
    } finally { ai.restore(); }
  });

  it('keeps a more cautious AI verdict and checks inputs', async () => {
    const inputs: InvestmentInput = { ...DEFAULT_INVESTMENT, strategy: 'flip', price: 300_000, gdv: 520_000, refurbCost: 40_000 };
    const f = analyse(scenario(inputs, 'optimistic'));
    const rule = ruleVerdict('flip', f, analyse(scenario(inputs, 'downside'))).verdict;
    const cautious = VERDICTS[Math.max(0, VERDICTS.indexOf(rule) - 1)];
    const ai = mockOpenAI({ chat: () => reply.json({ verdict: cautious, headline: `Profit of ${money(f.flipProfit)} if the sale price holds.`, strengths: [], risks: [], whatMustBeTrue: [], questionsToAsk: [], stressTestReading: 'Profit falls as refurb costs overrun.' }) });
    try {
      const res = await client().post('/api/ai/invest/explain', { strategy: 'flip', inputs, scenario: 'optimistic' });
      expect(res.status).toBe(200);
      expect(res.json.verdict).toMatchObject({ verdict: cautious, ruleVerdict: rule, verdictCapped: false, scenario: 'optimistic', removedClaims: 0 });
      expect(res.json.verdict.headline).toBe(`Profit of ${money(f.flipProfit)} if the sale price holds.`);
      expect(res.json.verdict.numbers.flipProfit).toBe(Math.round(f.flipProfit));
      expect((await client().post('/api/ai/invest/explain', { strategy: 'btl', inputs: { ...inputs, depositPct: 3 } })).status).toBe(400);
      expect((await client().post('/api/ai/invest/explain', { strategy: 'crypto', inputs })).status).toBe(400);
    } finally { ai.restore(); }
  });
});

describe('my home plan', () => {
  const home: HomeFacts = { postcode: 'E17 4QH', type: 'terraced', beds: 3, area: 92, era: 'pre-1919', condition: 'fair', epc: 'E' };

  it('attaches the engines’ costs and values to the steps the AI chose', async () => {
    const m = homeModel(home);
    const options = planOptions(m, ['add-value', 'cut-bills'], 30_000);
    const loft = options.find((o) => o.id === 'loft')!;
    const epc1 = options.find((o) => o.id === 'epc-1')!;
    expect(loft.cost).toBe(m.loft!.cost);
    expect(loft.valueImpact).toBe(m.loft!.valueUplift);
    expect(epc1.cost).toBe(m.epc.steps[0].cost);
    const ai = mockOpenAI({ chat: () => reply.json({
      summary: `Start with the cheap energy measures, then consider the loft at ${money(loft.cost!)}.`,
      steps: [
        { optionId: 'loft', title: 'Convert the loft for £1,000,000', why: `A loft adds space; it costs about ${money(loft.cost!)}.`, effort: 'high', order: 2 },
        { optionId: 'epc-1', title: 'Insulate the loft', why: 'It cuts bills by £9,999 a year.', effort: 'low', order: 1 },
        { optionId: null, title: 'Get three quotes', why: 'Compare like with like.', effort: 'low', order: 3 },
        { optionId: 'loft', title: 'Loft again', why: 'Duplicate.', effort: 'high', order: 4 },
      ],
      quickWins: ['Draught-proof external doors.'],
      avoid: ['Spending £77,777 on a swimming pool.'],
    }) });
    try {
      const r = await client().post('/api/ai/my-home/plan', { home, goals: ['add-value', 'cut-bills', 'add-value'], budget: 30_000 });
      expect(r.status).toBe(200);
      const plan = r.json.plan;
      expect(plan.goals).toEqual(['add-value', 'cut-bills']);
      expect(plan.steps.map((s: { optionId: string | null }) => s.optionId)).toEqual(['epc-1', 'loft', null]);
      expect(plan.steps[0]).toMatchObject({ order: 1, title: 'Insulate the loft', cost: epc1.cost, billsSaving: epc1.billsSaving, why: epc1.detail });
      expect(plan.steps[1]).toMatchObject({ order: 2, title: loft.title, cost: loft.cost, valueImpact: loft.valueImpact, withinBudget: loft.withinBudget });
      expect(plan.steps[2]).toMatchObject({ order: 3, cost: null, valueImpact: null });
      expect(plan.avoid).toEqual([]);
      expect(plan.quickWins).toEqual(['Draught-proof external doors.']);
      expect(plan.removedClaims).toBe(3);
      expect(plan.figures.value).toEqual(m.value);
      // The model could only pick from the costed options (strict enum), and was given the engines' figures.
      const chat = ai.calls('chat')[0].body;
      const ids = chat.response_format.json_schema.schema.properties.steps.items.properties.optionId.anyOf[0].enum;
      expect(ids).toEqual(expect.arrayContaining(['loft', 'epc-1']));
      expect(chat.messages[1].content).toContain(`"cost":${loft.cost}`);
    } finally { ai.restore(); }
  });

  it('validates goals and budget', async () => {
    const ai = mockOpenAI({ chat: () => reply.json({ summary: 'x', steps: [], quickWins: [], avoid: [] }) });
    try {
      expect((await client().post('/api/ai/my-home/plan', { home, goals: [] })).status).toBe(400);
      expect((await client().post('/api/ai/my-home/plan', { home, goals: ['get-rich'] })).status).toBe(400);
      expect((await client().post('/api/ai/my-home/plan', { home, goals: ['sell-soon'], budget: -10 })).status).toBe(400);
      expect((await client().post('/api/ai/my-home/plan', { home: { ...home, type: 'commercial' }, goals: ['sell-soon'] })).status).toBe(400);
      // With no usable steps from the model, Streetkey's own ordering is used.
      const r = await client().post('/api/ai/my-home/plan', { home: { ...home, condition: 'poor' }, goals: ['sell-soon'] });
      expect(r.status).toBe(200);
      expect(r.json.plan.steps.length).toBeGreaterThan(0);
      expect(r.json.plan.steps[0].optionId).toBeTruthy();
      expect(ai.calls('chat')).toHaveLength(1);
      // Nothing costed to plan with (a flat wanting more space): answered without calling the AI.
      const none = await client().post('/api/ai/my-home/plan', { home: { ...home, type: 'flat' }, goals: ['more-space'] });
      expect(none.status).toBe(200);
      expect(none.json.plan.steps).toEqual([]);
      expect(none.json.plan.summary).toMatch(/no costed options/);
      expect(ai.calls('chat')).toHaveLength(1);
    } finally { ai.restore(); }
  });
});

describe('money checks', () => {
  it('reads £ amounts however they are written', () => {
    const v = (s: string) => moneyMentions(s).map((m) => m.value);
    expect(v('£12.5k and £1.2m')).toEqual([12_500, 1_200_000]);
    expect(v('between £12–14k')).toEqual([12_000, 14_000]);
    expect(v('£12,000 to £14,000')).toEqual([12_000, 14_000]);
    expect(v('about 12,000 pounds')).toEqual([12_000]);
    expect(v('rates rose 20% in 2026')).toEqual([]);
    expect(isAllowed(moneyMentions('£47k')[0], [46_800])).toBe(true);
    expect(isAllowed(moneyMentions('£52,000')[0], [46_800])).toBe(false);
  });
  it('reads amounts written without a £ sign, but not measurements, counts or years', () => {
    const v = (s: string) => moneyMentions(s).map((m) => m.value);
    expect(v('A kitchen costs 8k to 12k.')).toEqual([8_000, 12_000]);
    expect(v('between 8–12k')).toEqual([8_000, 12_000]);
    expect(v('Expect around 12,000 to 15,000 for the roof.')).toEqual([12_000, 15_000]);
    expect(v('Roughly 9 grand.')).toEqual([9_000]);
    expect(v('About 15000 for the windows, 12 thousand for the rest.')).toEqual([15_000, 12_000]);
    expect(v('Worth 1.2m once done.')).toEqual([1_200_000]);
    expect(v('£ 12,000 here, 12,000 pounds there')).toEqual([12_000, 12_000]); // counted once each
    expect(v('Saves 1,200 a year.')).toEqual([1_200]);
    for (const s of ['about 1,200 m² of plaster', '2,500 kWh a year', 'built in the 1930s', 'a pre-1919 terrace from 1905', 'a 3m-deep extension, max 4m high',
      'a 6m × 4m room', '1,500 sq ft', '12 listings in E17', 'the 2,000 homes nearby', 'rates rose 20% in 2026']) expect(v(s), s).toEqual([]);
  });
  it('reads percentages and checks them against the computed ones', () => {
    const v = (s: string) => percentMentions(s).map((m) => m.value);
    expect(v('a net yield of 4.1% and 5 per cent')).toEqual([4.1, 5]);
    expect(v('lenders look for 15–20%')).toEqual([15, 20]);
    expect(v('cash on cash of −3.2%')).toEqual([3.2]);
    const ok = (s: string, allowed: number[]) => percentMentions(s).every((m) => isPercentAllowed(m, allowed));
    expect(ok('4.1%', [4.12])).toBe(true);
    expect(ok('4%', [4.4])).toBe(true); // rounded as written
    expect(ok('9%', [4.1])).toBe(false);
    expect(ok('4.4%', [4.1])).toBe(false); // more than 0.15 points out
    expect(scrubText('Net yield is 4.1%. A net yield of 9% is great. Gross 6%.', [], 900, [4.1, 6.2])).toEqual({ text: 'Net yield is 4.1%. Gross 6%.', removed: 1 });
    expect(scrubText('Net yield is 9%.', [])).toEqual({ text: 'Net yield is 9%.', removed: 0 }); // percentages are only checked when asked
  });
  it('removes only the statements with unsupported amounts', () => {
    expect(scrubText('Total £46,800. Value rises £90,000. Get quotes.', [46_800])).toEqual({ text: 'Total £46,800. Get quotes.', removed: 1 });
    expect(scrubList(['Kitchen £7,550', 'Windows £123,456', 'kitchen £7,550', 'Ask for quotes'], [7_550])).toEqual({ items: ['Kitchen £7,550', 'Ask for quotes'], removed: 1 });
    expect(scrubText('A kitchen costs 8k to 12k. Roughly 9 grand for the roof. Get quotes.', [])).toEqual({ text: 'Get quotes.', removed: 2 });
    expect(scrubList(['Expect around 12,000 to 15,000 for the roof.', 'Roof 7.5k'], [7_550])).toEqual({ items: ['Roof 7.5k'], removed: 1 });
  });
});
