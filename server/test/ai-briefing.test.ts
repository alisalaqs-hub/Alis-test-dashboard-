import { describe, expect, it } from 'vitest';
import { figuresIn, Grounding, sentences } from '../src/ai/briefing/grounding';
import { CONSEQUENTIAL, groundBriefing } from '../src/ai/briefing/generate';
import { Snapshot } from '../src/ai/briefing/snapshot';
import { q } from '../src/db';
import { limits } from '../src/services/ratelimit';
import { client, LISTING, signUp } from './helpers';
import { mockOpenAI, reply } from './openai-mock';

/* ───────────── fixtures ───────────── */
const SNAP = {
  title: 'Northbank Estates · branch overview',
  scope: 'Demo branch of fictional listings',
  metrics: [{ label: 'Views (28d)', value: 4210 }, { label: 'Portfolio conversion', value: '1.4%' }],
  items: [
    { id: 'wal-001', label: 'Ashcombe Grove, Walthamstow', group: 'listing', fields: { price: 525000, views7d: 412, conversion: 0.0045, compsConversion: 0.012, daysOnMarket: 64, flag: 'Low conversion' }, notes: ['Reduced from £550,000'] },
    { id: 'cro-002', label: 'Birchfield Road, Croydon', group: 'listing', fields: { price: 450000, views7d: 180, conversion: 0.019, daysOnMarket: 21 } },
  ],
};

const BRIEFING = {
  headline: 'Ashcombe Grove needs attention: strong views, weak conversion.',
  summary: 'Ashcombe Grove converts at 0.45% against 1.2% for comparables. It has been on the market for 64 days. A £45k reduction would fix it.',
  priorities: [
    { title: 'Review Ashcombe Grove pricing with the vendor', why: 'Asking £525,000 after a reduction from £550,000, with conversion at 0.45%.', action: 'Share the comparable evidence with the vendor.', impact: 'high', relatedIds: ['wal-001', 'not-in-snapshot'] },
    { title: 'Cut Birchfield Road to £399,950', why: 'It would sell faster at that level.', action: 'Reduce the asking price.', impact: 'medium', relatedIds: ['cro-002'] },
    { title: 'Keep Birchfield Road as it is', why: 'It converts at 1.9%, ahead of the branch.', action: 'Keep the current marketing.', impact: 'low', relatedIds: ['cro-002'] },
  ],
  risks: ['Interest is falling at Ashcombe Grove.', 'Local values may fall 8% next year.'],
  opportunities: ['Birchfield Road converts at 1.9%, the best in the branch.'],
  questions: ['Has the vendor seen the latest viewing feedback?'],
};

type Body = { model: string; messages: { role: string; content: string }[]; response_format: { json_schema: { name: string; strict: boolean } }; max_completion_tokens: number };
const userJson = (body: Body) => { const c = body.messages.find((m) => m.role === 'user')!.content; return JSON.parse(c.slice(c.indexOf('{'), c.lastIndexOf('}') + 1)); };
const withTitle = (title: string) => ({ ...SNAP, title });

/* ───────────── unit: grounding ───────────── */
describe('figure grounding', () => {
  it('reads £ and % figures in the forms people write them', () => {
    const f = figuresIn('Asking £525k (was £550,000); range £500–550k; GDV £1.45m; build £2,650 m²; 12% and 1.2–1.5%; 20 per cent');
    expect(f.filter((x) => x.kind === 'money').map((x) => x.value)).toEqual([525000, 550000, 500000, 550000, 1450000, 2650]);
    expect(f.filter((x) => x.kind === 'percent').map((x) => x.value)).toEqual([12, 1.2, 1.5, 20]);
  });

  it('accepts rounding and formatting of snapshot figures but not new figures or prohibited claims', () => {
    const g = new Grounding({ items: [{ fields: { price: 525000, rate: 0.012, gdv: 1450000, note: 'Arrears £1,250 · 9 days' } }], metrics: [{ label: 'Occupancy', value: '81%' }] });
    for (const ok of ['£525,000 asking', 'about £525k', '£0.53m', 'conversion 1.2%', '£1,250 in arrears', '81% occupancy', 'GDV of £1.45m', 'No figures at all.']) expect(g.ok(ok), ok).toBe(true);
    for (const bad of ['£999,999 invented', 'roughly £2m', 'down 12%', 'a £45k cut', 'This is guaranteed to sell.', 'It is a valuation of the home.']) expect(g.ok(bad), bad).toBe(false);
    expect(g.prose('Views fell. Asking is £525k. A £45k cut would help. Occupancy is 81%.')).toBe('Views fell. Asking is £525k. Occupancy is 81%.');
    expect(g.report.dropped).toBe(1);
    expect(sentences('Price is £1.45m, e.g. the top. Next one!')).toEqual(['Price is £1.45m, e.g. the top.', 'Next one!']);
  });

  it('drops invented figures from briefings, sentence by sentence in prose and item by item in lists', () => {
    const s = Snapshot.parse(SNAP);
    const b = groundBriefing('agent', s, BRIEFING as never, 'dashboard');
    expect(b.summary).toBe('Ashcombe Grove converts at 0.45% against 1.2% for comparables. It has been on the market for 64 days.');
    expect(b.priorities.map((p) => p.title)).toEqual(['Review Ashcombe Grove pricing with the vendor', 'Keep Birchfield Road as it is']);
    expect(b.priorities[0].relatedIds).toEqual(['wal-001']);
    expect(b.risks).toEqual(['Interest is falling at Ashcombe Grove.']);
    expect(b.opportunities).toHaveLength(1);
    expect(b.grounding.dropped).toBe(3);
  });

  it('treats anything that reaches outside Streetkey as consequential', () => {
    for (const t of ['Email the vendor a weekly report', 'Book a Gas Safe engineer', 'Publish the revised description', 'Reduce the asking price', 'Send viewing request']) expect(CONSEQUENTIAL.test(t), t).toBe(true);
    for (const t of ['Generate an investment pack', 'Summarise compliance dates for review', 'Compare the contractor quote line by line']) expect(CONSEQUENTIAL.test(t), t).toBe(false);
  });
});

/* ───────────── POST /api/ai/briefing ───────────── */
describe('AI dashboard briefings', () => {
  it('needs AI to be switched on (the dashboards keep their rule-based views)', async () => {
    const r = await client().post('/api/ai/briefing', { kind: 'agent', snapshot: SNAP });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('ai_unavailable');
  });

  it('validates and bounds the snapshot before any AI call', async () => {
    const ai = mockOpenAI({ chat: () => reply.json(BRIEFING) });
    try {
      const c = client();
      const item = (i: number) => ({ id: `u${i}`, label: `Unit ${i}`, fields: { rent: 1000 + i } });
      const bad: [string, unknown][] = [
        ['items', { kind: 'agent', snapshot: { items: Array.from({ length: 61 }, (_, i) => item(i)) } }],
        ['snapshot.items.0.label', { kind: 'agent', snapshot: { items: [{ id: 'a', label: 'x'.repeat(121) }] } }],
        ['snapshot.items.0.fields', { kind: 'landlord', snapshot: { items: [{ id: 'a', label: 'A', fields: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, i])) }] } }],
        ['snapshot.items.0.fields.nested', { kind: 'landlord', snapshot: { items: [{ id: 'a', label: 'A', fields: { nested: { deep: 1 } } }] } }],
        ['snapshot.items.0.fields.note', { kind: 'developer', snapshot: { items: [{ id: 'a', label: 'A', fields: { note: 'y'.repeat(161) } }] } }],
        ['snapshot', { kind: 'agent', snapshot: { ...SNAP, script: '<b>extra</b>' } }],
        ['snapshot.items.0.id', { kind: 'agent', snapshot: { items: [{ id: 'bad id!', label: 'A' }] } }],
        ['snapshot.items.1.id', { kind: 'agent', snapshot: { items: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] } }],
        ['snapshot.items', { kind: 'agent', snapshot: { items: [] } }],
        ['snapshot', { kind: 'agent' }],
        ['kind', { kind: 'investor', snapshot: SNAP }],
        ['snapshot.metrics', { kind: 'agent', snapshot: { ...SNAP, metrics: Array.from({ length: 25 }, (_, i) => ({ label: `m${i}`, value: i })) } }],
        ['snapshot._', { kind: 'agent', snapshot: { items: Array.from({ length: 60 }, (_, i) => ({ ...item(i), notes: Array.from({ length: 5 }, () => 'n'.repeat(200)) })) } }],
      ];
      for (const [field, body] of bad) {
        const r = await c.post('/api/ai/briefing', body);
        expect(r.status, field).toBe(400);
        expect(Object.keys(r.json.error.fields ?? {}).some((k) => k === field || k.startsWith(field) || field.startsWith(k)), `${field}: ${JSON.stringify(r.json.error.fields)}`).toBe(true);
      }
      // 60 items is fine
      const ok = await c.post('/api/ai/briefing', { kind: 'landlord', snapshot: { items: Array.from({ length: 60 }, (_, i) => item(i)) } });
      expect(ok.status).toBe(200);
      expect(ai.calls('chat')).toHaveLength(1);
    } finally { ai.restore(); }
  });

  it('writes a grounded briefing: invented £ and % figures are dropped, unknown ids removed', async () => {
    const ai = mockOpenAI({ chat: () => reply.json(BRIEFING) });
    try {
      const r = await client().post('/api/ai/briefing', { kind: 'agent', snapshot: withTitle('Grounding test') });
      expect(r.status).toBe(200);
      const b = r.json.briefing;
      expect(r.json.cached).toBe(false);
      expect(b.kind).toBe('agent');
      expect(b.source).toBe('dashboard');
      expect(b.summary).not.toMatch(/£45k/);
      expect(b.summary).toMatch(/0\.45%/);
      expect(b.priorities).toHaveLength(2);
      expect(JSON.stringify(b)).not.toMatch(/399,950|8% next year/);
      expect(b.priorities[0]).toMatchObject({ impact: 'high', relatedIds: ['wal-001'] });
      expect(b.grounding).toMatchObject({ dropped: 3 });

      const body = ai.calls('chat')[0].body as Body;
      expect(body.model).toBe('gpt-5'); // role 'main'
      expect(body.response_format.json_schema).toMatchObject({ name: 'dashboard_briefing', strict: true });
      expect(body.max_completion_tokens).toBeLessThanOrEqual(2000);
      expect(body.messages[0].content).toMatch(/^You are Streetkey’s AI/);
      expect(body.messages[0].content).toMatch(/estate agency branch manager/);
      expect(body.messages[1].content).toMatch(/<<<snapshot/);
      expect(userJson(body).items[0].id).toBe('wal-001');

      // The job is visible to the visitor who asked (anonymous jobs are addressed by their id).
      const job = await client().get(`/api/ai/jobs/${r.json.jobId}`);
      expect(job.json.job).toMatchObject({ status: 'done', kind: 'ai.briefing' });
      const usage = await q<{ purpose: string }>(`SELECT purpose FROM ai_usage WHERE purpose = 'briefing.agent'`);
      expect(usage.length).toBeGreaterThanOrEqual(1);
    } finally { ai.restore(); }
  });

  it('caches by snapshot for an hour', async () => {
    const ai = mockOpenAI({ chat: () => reply.json(BRIEFING) });
    try {
      const c = client();
      const first = await c.post('/api/ai/briefing', { kind: 'agent', snapshot: withTitle('Cache test') });
      expect(first.json.cached).toBe(false);
      // Same content with keys in a different order is the same snapshot.
      const reordered = { items: SNAP.items, metrics: SNAP.metrics, scope: SNAP.scope, title: 'Cache test' };
      const second = await client().post('/api/ai/briefing', { kind: 'agent', snapshot: reordered });
      expect(second.status).toBe(200);
      expect(second.json.cached).toBe(true);
      expect(second.json.briefing.headline).toBe(first.json.briefing.headline);
      expect(ai.calls('chat')).toHaveLength(1);
      // Different kind or different figures: a new briefing.
      await c.post('/api/ai/briefing', { kind: 'landlord', snapshot: withTitle('Cache test') });
      await c.post('/api/ai/briefing', { kind: 'agent', snapshot: { ...withTitle('Cache test'), metrics: [{ label: 'Views (28d)', value: 4211 }] } });
      expect(ai.calls('chat')).toHaveLength(3);
      const row = await q<{ ttl: number }>(`SELECT extract(epoch FROM expires_at - now())::int AS ttl FROM ai_cache WHERE key LIKE 'briefing:%' ORDER BY expires_at DESC LIMIT 1`);
      expect(row[0].ttl).toBeGreaterThan(3500);
      expect(row[0].ttl).toBeLessThanOrEqual(3600);
    } finally { ai.restore(); }
  });

  it('reports AI failures without breaking (the page falls back to its rules)', async () => {
    const ai = mockOpenAI({ chat: () => reply.json({ headline: 1 }) });
    try {
      const r = await client().post('/api/ai/briefing', { kind: 'developer', snapshot: withTitle('Failure test') });
      expect(r.status).toBe(502);
      expect(r.json.error.message).toMatch(/unexpected|try again/i);
      expect(await q(`SELECT 1 FROM ai_cache WHERE key LIKE 'briefing:v1:developer:%'`)).toHaveLength(0);
    } finally { ai.restore(); }
  });
});

/* ───────────── kind: my-agency ───────────── */
describe('my-agency briefing (live data)', () => {
  async function agencyWithListings() {
    const agent = await signUp({ accountType: 'agent', name: 'Agent' });
    const org = await agent.c.post('/api/orgs', { name: 'Lea Valley Homes', kind: 'agency', redressScheme: 'The Property Ombudsman' });
    expect(org.status).toBe(201);
    const mk = async (over: Record<string, unknown> = {}) => {
      const r = await agent.c.post('/api/listings', { ...LISTING, ...over });
      expect(r.status).toBe(201);
      return r.json.listing.ref as string;
    };
    const live = await mk();
    const draft = await mk({ title: 'Draft flat', addressLine: '2 Draft Lane' });
    await q(`UPDATE listings SET status = 'live', published_at = now() - interval '12 days' WHERE ref = $1`, [live]);
    const id = (await q<{ id: string }>('SELECT id FROM listings WHERE ref = $1', [live]))[0].id;
    await q(`INSERT INTO engagement_events (listing_id, session_id, name, occurred_at) SELECT $1, 's' || g, 'listing_view', now() - interval '2 days' FROM generate_series(1, 5) g`, [id]);
    await q(`INSERT INTO engagement_events (listing_id, session_id, name, occurred_at) SELECT $1, 'p' || g, 'listing_view', now() - interval '40 days' FROM generate_series(1, 3) g`, [id]);
    await q(`INSERT INTO enquiries (listing_id, name, email, kind, status) VALUES ($1, 'Buyer One', 'one@example.com', 'viewing', 'new'), ($1, 'Buyer Two', 'two@example.com', 'question', 'replied')`, [id]);
    await q(`INSERT INTO enquiries (listing_id, name, email, kind, status, filtered) VALUES ($1, 'Spam', 'spam@example.com', 'question', 'new', true)`, [id]);
    await q(`INSERT INTO audit_log (action, subject, detail) VALUES ('listing.updated', $1, '{"fields":["price"],"priceFrom":550000,"priceTo":525000}')`, [`listing:${live}`]);
    return { agent, orgId: org.json.id as string, live, draft, id };
  }

  it('requires sign-in and agency membership', async () => {
    const ai = mockOpenAI({ chat: () => reply.json(BRIEFING) });
    try {
      expect((await client().post('/api/ai/briefing', { kind: 'my-agency' })).status).toBe(401);
      const buyer = await signUp();
      expect((await buyer.c.post('/api/ai/briefing', { kind: 'my-agency' })).status).toBe(403);
      // Belonging to a non-agency organisation isn't enough.
      const landlord = await signUp({ accountType: 'landlord' });
      await landlord.c.post('/api/orgs', { name: 'Hill Lettings Ltd', kind: 'landlord' });
      expect((await landlord.c.post('/api/ai/briefing', { kind: 'my-agency' })).status).toBe(403);
      // An agency with nothing live yet gets a clear message, not an AI call.
      const empty = await signUp({ accountType: 'agent' });
      await empty.c.post('/api/orgs', { name: 'New Agency', kind: 'agency' });
      const r = await empty.c.post('/api/ai/briefing', { kind: 'my-agency' });
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('no_live_listings');
      expect(ai.calls('chat')).toHaveLength(0);
    } finally { ai.restore(); }
  });

  it('builds the snapshot on the server from the agency’s live listings and ignores the browser’s', async () => {
    const { agent, live, draft, id } = await agencyWithListings();
    // Another agency's live listing must never appear.
    const other = await signUp({ accountType: 'agent' });
    await other.c.post('/api/orgs', { name: 'Other Agency', kind: 'agency' });
    const otherRef = (await other.c.post('/api/listings', { ...LISTING, title: 'Other agency home', addressLine: '9 Other Street' })).json.listing.ref;
    await q(`UPDATE listings SET status = 'live', published_at = now() WHERE ref = $1`, [otherRef]);
    const buyer = await signUp();
    await q('INSERT INTO saved_listings (user_id, listing_key) VALUES ($1, $2)', [buyer.user.id, live]);

    const live1 = { ...BRIEFING, priorities: [{ title: 'Answer the new viewing request', why: 'Asking £525,000, reduced from £550,000; one enquiry is unanswered.', action: 'Reply today.', impact: 'high', relatedIds: [live, 'wal-001'] }] };
    const ai = mockOpenAI({ chat: () => reply.json(live1) });
    try {
      const forged = { items: [{ id: 'forged-1', label: 'Forged listing', fields: { views30d: 99999 } }] };
      const r = await agent.c.post('/api/ai/briefing', { kind: 'my-agency', snapshot: forged });
      expect(r.status).toBe(200);
      const b = r.json.briefing;
      expect(b).toMatchObject({ kind: 'my-agency', source: 'live' });
      expect(b.priorities).toHaveLength(1);
      expect(b.priorities[0].relatedIds).toEqual([live]);

      const body = ai.calls('chat')[0].body as Body;
      expect(body.messages[0].content).toMatch(/own live Streetkey listings/);
      const snap = userJson(body);
      expect(JSON.stringify(snap)).not.toMatch(/forged|99999/);
      expect(snap.items.map((i: { id: string }) => i.id)).toEqual([live]); // not the draft, not the other agency
      expect(JSON.stringify(snap)).not.toContain(draft);
      expect(JSON.stringify(snap)).not.toContain(otherRef);
      expect(snap.items[0].fields).toMatchObject({
        price: 525000, views30d: 5, viewsPrior30d: 3, saves: 1, enquiries30d: 2, enquiriesTotal: 2, unansweredEnquiries: 1,
        priceChanges: 1, previousPrice: 550000, daysLive: 12, photos: 0,
      });
      const { areaRangeLow, areaRangeHigh, priceVsArea } = snap.items[0].fields;
      expect(areaRangeLow).toBeGreaterThan(0);
      expect(areaRangeHigh).toBeGreaterThan(areaRangeLow);
      expect(priceVsArea).toMatch(/area range/);
      expect(snap.metrics).toEqual(expect.arrayContaining([{ label: 'Live listings', value: 1 }, { label: 'Unanswered enquiries', value: 1 }]));
      expect(JSON.stringify(snap)).not.toMatch(/one@example\.com|Buyer One/); // no enquirer personal data

      // Cached while nothing changes; new activity means a fresh briefing.
      expect((await agent.c.post('/api/ai/briefing', { kind: 'my-agency' })).json.cached).toBe(true);
      await q(`INSERT INTO engagement_events (listing_id, session_id, name) VALUES ($1, 'new', 'listing_view')`, [id]);
      const again = await agent.c.post('/api/ai/briefing', { kind: 'my-agency' });
      expect(again.json.cached).toBe(false);
      expect(userJson(ai.calls('chat')[1].body as Body).items[0].fields.views30d).toBe(6);

      // Another member of the same agency may brief on it; the job belongs to whoever asked.
      expect((await client().get(`/api/ai/jobs/${again.json.jobId}`)).status).toBe(403);
      expect((await agent.c.get(`/api/ai/jobs/${again.json.jobId}`)).json.job.status).toBe('done');
    } finally { ai.restore(); }
  });
});

/* ───────────── POST /api/ai/automation/run ───────────── */
describe('AI automation proposals', () => {
  const PROPOSALS = {
    proposals: [
      { title: 'Book a Gas Safe engineer for U3', detail: 'Ask two verified engineers for slots before the certificate lapses.', consequential: false, rationale: 'The U3 gas safety certificate is due in 11 days.' },
      { title: 'Prepare a compliance summary for U2 and U3', detail: 'A one-page list of upcoming dates for your review.', consequential: false, rationale: 'The U2 EICR is due in 22 days.' },
      { title: 'Spend £5,000 on a new boiler for U4', detail: 'Order a replacement boiler.', consequential: true, rationale: 'Boilers fail.' },
    ],
  };

  it('validates the agent id against Streetkey’s agents', async () => {
    const ai = mockOpenAI({ chat: () => reply.json(PROPOSALS) });
    try {
      for (const agent of ['ceo', '', 'landlord; drop table', 'LANDLORD']) {
        const r = await client().post('/api/ai/automation/run', { agent });
        expect(r.status, agent).toBe(400);
        expect(r.json.error.fields.agent).toBeTruthy();
      }
      expect((await client().post('/api/ai/automation/run', {})).status).toBe(400);
      expect((await client().post('/api/ai/automation/run', { agent: 'landlord', context: { items: Array.from({ length: 61 }, (_, i) => ({ id: `x${i}`, label: 'x' })) } })).status).toBe(400);
      expect(ai.calls('chat')).toHaveLength(0);
    } finally { ai.restore(); }
    expect((await client().post('/api/ai/automation/run', { agent: 'landlord' })).status).toBe(503);
  });

  it('proposes grounded actions; consequential ones always need approval; visitors get demo data only', async () => {
    const ai = mockOpenAI({ chat: () => reply.json(PROPOSALS) });
    try {
      const context = { title: 'My units', items: [{ id: 'U9', label: 'Private context unit', fields: { rent: 1400 } }] };
      const r = await client().post('/api/ai/automation/run', { agent: 'landlord', context });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ agent: 'landlord', basis: 'demo', cached: false });
      expect(r.json.findings).toContain('Gas safety certificate for U3 due in 11 days');
      const ps = r.json.proposals;
      expect(ps.map((p: { title: string }) => p.title)).toEqual(['Book a Gas Safe engineer for U3', 'Prepare a compliance summary for U2 and U3']);
      expect(ps[0].consequential).toBe(true); // "Book" reaches outside Streetkey: upgraded despite the model
      expect(ps[1].consequential).toBe(false);
      expect(ps.every((p: { id: string; agent: string }) => p.id.startsWith('ai-landlord-') && p.agent === 'landlord')).toBe(true);
      expect(new Set(ps.map((p: { id: string }) => p.id)).size).toBe(ps.length);
      expect(r.json.grounding.dropped).toBe(1);

      const body = ai.calls('chat')[0].body as Body;
      expect(body.model).toBe('gpt-5-mini'); // role 'fast'
      expect(body.response_format.json_schema).toMatchObject({ name: 'agent_proposals', strict: true });
      expect(body.messages[0].content).toMatch(/^You are Streetkey’s AI/);
      expect(body.messages[0].content).toMatch(/never execute anything/);
      expect(body.messages[1].content).toMatch(/<<<agent_run/);
      expect(body.messages[1].content).not.toMatch(/Private context unit/); // anonymous: context ignored

      // Same run again: served from the cache with fresh ids.
      const again = await client().post('/api/ai/automation/run', { agent: 'landlord' });
      expect(again.json.cached).toBe(true);
      expect(ai.calls('chat')).toHaveLength(1);

      // Signed in: their context snapshot is used too.
      const { c } = await signUp({ accountType: 'landlord' });
      const mine = await c.post('/api/ai/automation/run', { agent: 'landlord', context });
      expect(mine.json.basis).toBe('demo+context');
      const userBody = ai.calls('chat')[1].body as Body;
      expect(userJson(userBody).userContext.items[0].label).toBe('Private context unit');
    } finally { ai.restore(); }
  });

  it('runs every Streetkey agent’s deterministic tools on the server', async () => {
    const ai = mockOpenAI({ chat: () => reply.json({ proposals: [{ title: 'Generate a summary pack', detail: 'For your review.', consequential: false, rationale: 'From the findings.' }] }) });
    try {
      for (const agent of ['buyer', 'seller', 'estate-agent', 'landlord', 'investor', 'developer', 'contractor', 'manager']) {
        const r = await client().post('/api/ai/automation/run', { agent });
        expect(r.status, agent).toBe(200);
        expect(r.json.toolsCalled.length, agent).toBeGreaterThan(0);
        expect(r.json.proposals).toHaveLength(1);
      }
    } finally { ai.restore(); }
  });
});

/* ───────────── limits (last: changes the shared limiter) ───────────── */
describe('AI briefing limits', () => {
  it('rate-limits briefings per visitor', async () => {
    const ai = mockOpenAI({ chat: () => reply.json(BRIEFING) });
    const prev = limits.multiplier;
    try {
      limits.multiplier = 1;
      const statuses: number[] = [];
      // 6 a minute: 14 requests overflow even if they straddle a minute boundary.
      for (let i = 0; i < 14; i++) statuses.push((await client().post('/api/ai/briefing', { kind: 'agent', snapshot: withTitle('Limit test') })).status);
      expect(statuses).toContain(429);
      expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(12);
    } finally { limits.multiplier = prev; ai.restore(); }
  });
});
