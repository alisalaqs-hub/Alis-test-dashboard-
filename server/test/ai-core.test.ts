import { describe, expect, it } from 'vitest';
import { chatJSON, editImage, modelFor, runWithTools, AiError } from '../src/ai/core';
import { S, type Infer } from '../src/ai/schema';
import { enqueue, registerJob, getJob } from '../src/ai/jobs';
import { config } from '../src/config';
import { q } from '../src/db';
import { hit, limits } from '../src/services/ratelimit';
import { client, signUp } from './helpers';
import { mockOpenAI, reply, TINY_PNG } from './openai-mock';

const Out = S.obj({ title: S.str(), rooms: S.arr(S.str()), price: S.nullable(S.num()), kind: S.enum(['sale', 'rent'] as const) });
type OutT = Infer<typeof Out>;

describe('AI core', () => {
  it('auto-selects the newest models the account can use, unless overridden', async () => {
    const ai = mockOpenAI({ models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-5', 'gpt-5.2', 'gpt-5.2-mini', 'gpt-5-mini', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2.5-sunburst', 'text-embedding-3-small', 'omni-moderation-latest'] });
    try {
      expect(await modelFor('main')).toBe('gpt-5.2');
      expect(await modelFor('fast')).toBe('gpt-5.2-mini');
      expect(await modelFor('image')).toBe('gpt-image-2');
      expect(await modelFor('embedding')).toBe('text-embedding-3-small');
      config.ai.models.main = 'gpt-4.1';
      expect(await modelFor('main')).toBe('gpt-4.1');
    } finally { config.ai.models.main = ''; ai.restore(); }
  });

  it('returns typed JSON, and drops parameters a model rejects', async () => {
    const ai = mockOpenAI({ chat: (_body, n) => n === 0 ? { status: 400, error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", param: 'reasoning_effort' } } : reply.json({ title: 'Bright terrace', rooms: ['Kitchen'], price: null, kind: 'sale' }) });
    try {
      const v = await chatJSON<OutT>([{ role: 'user', content: 'x' }], Out, 'listing', { purpose: 'test' });
      expect(v).toEqual({ title: 'Bright terrace', rooms: ['Kitchen'], price: null, kind: 'sale' });
      const chats = ai.calls('chat');
      expect(chats).toHaveLength(2);
      expect(chats[0].body.reasoning_effort).toBe('low');
      expect(chats[1].body.reasoning_effort).toBeUndefined();
      expect(chats[1].body.response_format.json_schema.strict).toBe(true);
      const usage = await q<{ purpose: string }>(`SELECT purpose FROM ai_usage WHERE purpose = 'test'`);
      expect(usage.length).toBeGreaterThanOrEqual(1);
    } finally { ai.restore(); }
  });

  it('rejects answers that do not match the schema', async () => {
    const ai = mockOpenAI({ chat: () => reply.json({ title: 1 }) });
    try {
      await expect(chatJSON([{ role: 'user', content: 'x' }], Out, 'listing', { purpose: 'test' })).rejects.toBeInstanceOf(AiError);
    } finally { ai.restore(); }
  });

  it('runs tools and feeds results back until the model answers', async () => {
    const ai = mockOpenAI({ chat: (body, n) => n === 0 ? reply.tools([{ name: 'stamp_duty', args: { price: 300000 } }]) : reply.text(`Duty is ${JSON.parse(body.messages.at(-1).content).total}`) });
    try {
      const r = await runWithTools([{ role: 'user', content: 'stamp duty on 300k?' }], [{
        name: 'stamp_duty', description: 'SDLT', parameters: S.obj({ price: S.num() }), run: (a: { price: number }) => ({ total: a.price / 100 }),
      }], { purpose: 'test' });
      expect(r.content).toBe('Duty is 3000');
      expect(r.traces[0]).toMatchObject({ name: 'stamp_duty', ok: true });
      expect(ai.calls('chat')[0].body.tools[0].function.strict).toBe(true);
    } finally { ai.restore(); }
  });

  it('stops when the daily token budget is used up', async () => {
    const ai = mockOpenAI({ chat: () => reply.text('hi') });
    const cap = config.ai.dailyTokenBudget;
    try {
      config.ai.dailyTokenBudget = 10;
      await q(`INSERT INTO ai_usage (purpose, model, input_tokens) VALUES ('test', 'x', 1000)`);
      await expect(chatJSON([{ role: 'user', content: 'x' }], Out, 'x', { purpose: 'test' })).rejects.toMatchObject({ code: 'ai_budget' });
    } finally { config.ai.dailyTokenBudget = cap; ai.restore(); }
  });

  it('omits input_fidelity for newer image models and keeps keys out of errors', async () => {
    const forms: FormData[] = [];
    const ai = mockOpenAI({ images: (f) => { forms.push(f); return TINY_PNG; } });
    try {
      const out = await editImage(TINY_PNG, 'image/png', 'make it scandi', { purpose: 'test' });
      expect(out.equals(TINY_PNG)).toBe(true);
      expect(forms[0].get('model')).toBe('gpt-image-2');
      expect(forms[0].get('input_fidelity')).toBeNull();
    } finally { ai.restore(); }
    const bad = mockOpenAI({ images: () => ({ status: 401, error: { message: 'Incorrect API key provided: sk-proj-abcdefgh1234. You can find…' } }) });
    try {
      const e = await editImage(TINY_PNG, 'image/png', 'x', { purpose: 'test' }).catch((x) => x);
      expect(e).toBeInstanceOf(AiError);
      expect(e.message).not.toMatch(/abcdefgh/);
      expect(e.code).toBe('ai_key');
    } finally { bad.restore(); }
  });
});

describe('jobs and limits', () => {
  it('queues, runs and reports jobs; retries transient failures; owners only', async () => {
    let n = 0;
    registerJob('test.echo', async (job, ctx) => { await ctx.progress('half way'); return { echo: job.input.say }; });
    registerJob('test.flaky', async () => { if (n++ === 0) throw new AiError('x', 'busy', 503, 'ai_busy'); return { ok: true }; }, { maxAttempts: 2 });
    registerJob('test.broken', async () => { throw new AiError('x', 'The AI declined this request.', 422, 'ai_refused'); });
    const { c, user } = await signUp();
    const done = await enqueue('test.echo', { say: 'hello' }, { userId: user.id });
    expect(done.status).toBe('done');
    const polled = await c.get(`/api/ai/jobs/${done.id}`);
    expect(polled.json.job).toMatchObject({ status: 'done', output: { echo: 'hello' } });
    expect((await client().get(`/api/ai/jobs/${done.id}`)).status).toBe(403);
    const flaky = await enqueue('test.flaky', {}, { userId: user.id });
    expect((await getJob(flaky.id))!.status).toBe('done');
    const broken = await enqueue('test.broken', {}, { userId: user.id });
    const b = (await c.get(`/api/ai/jobs/${broken.id}`)).json.job;
    expect(b).toMatchObject({ status: 'failed', error: 'The AI declined this request.' });
  });

  it('counts rate limits across instances in the database', async () => {
    const prev = limits.multiplier; limits.multiplier = 1;
    try {
      const key = `test:${Math.random()}`;
      expect((await hit(key, 2, 60)).ok).toBe(true);
      expect((await hit(key, 2, 60)).ok).toBe(true);
      const third = await hit(key, 2, 60);
      expect(third.ok).toBe(false);
      expect(third.resetSec).toBeGreaterThan(0);
      // login is limited per IP
      const c = client();
      let last = 0;
      for (let i = 0; i < 12; i++) last = (await c.post('/api/auth/login', { email: 'x@example.com', password: 'nope nope nope' })).status;
      expect(last).toBe(429);
    } finally { limits.multiplier = prev; }
  });

  it('reports AI as unavailable without a key', async () => {
    const r = await client().get('/api/health');
    expect(r.json.features.ai).toBe(false);
    expect((await client().get('/api/ai/status')).json.enabled).toBe(false);
  });
});
