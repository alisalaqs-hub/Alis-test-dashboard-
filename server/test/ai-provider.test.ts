/**
 * Running Streetkey's AI on a provider other than OpenAI (one that speaks the same API, such as a free plan):
 * the settings, what is and isn't called, the fallback for models without strict JSON output, and the pause
 * when the provider's allowance is used up.
 */
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { one, q } from '../src/db';
import { AiError, aiAvailable, aiCan, aiOffReason, aiProvider, chatJSON, chatText, editImage, embed, moderate, modelsInUse, refreshAiState, resetAiCaches, runWithTools } from '../src/ai/core';
import { S } from '../src/ai/schema';
import { outbox } from '../src/services/email';
import { client } from './helpers';
import { TINY_PNG } from './openai-mock';
import { fakeHosts } from './setup';

const HOST = 'api.freeai.test';
type Call = { path: string; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Chat = (body: any, n: number) => Response; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Points Streetkey at a stand-in provider that only has chat (as free plans do); everything else answers 404. */
function otherProvider(chat: Chat, models: Partial<typeof config.ai.models> = {}) {
  const saved = { key: config.ai.openaiKey, base: config.ai.openaiBase, models: { ...config.ai.models }, disabled: config.ai.disabled, name: config.ai.providerName, admin: config.adminEmail };
  const calls: Call[] = [];
  const auth: (string | null)[] = [];
  config.ai.openaiKey = 'free-plan-key';
  config.ai.openaiBase = `https://${HOST}/openai/v1`;
  config.ai.disabled = false;
  config.adminEmail = 'admin@example.com';
  Object.assign(config.ai.models, { main: 'open-model-large', fast: '', vision: '', image: '', embedding: '', moderation: '', ...models });
  resetAiCaches();
  let n = 0;
  fakeHosts.set(HOST, (url, init) => {
    const path = new URL(url).pathname.replace(/^\/openai\/v1/, '');
    const body = init?.body && !(init.body instanceof FormData) ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    auth.push(new Headers(init?.headers).get('authorization'));
    if (path === '/chat/completions') return chat(body, n++);
    return Response.json({ error: { message: `Unknown request URL: POST ${path}` } }, { status: 404 });
  });
  return {
    calls, auth,
    restore: async () => {
      fakeHosts.delete(HOST);
      Object.assign(config.ai, { openaiKey: saved.key, openaiBase: saved.base, disabled: saved.disabled, providerName: saved.name });
      Object.assign(config.ai.models, saved.models);
      config.adminEmail = saved.admin;
      await q(`DELETE FROM app_settings WHERE key = 'ai_paused_until'`);
      resetAiCaches();
      await refreshAiState(true);
    },
  };
}
const answer = (content: string, extra: Record<string, unknown> = {}) => Response.json({ choices: [{ message: { content, ...extra }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
const refuse = (status: number, message: string, headers: Record<string, string> = {}) => Response.json({ error: { message } }, { status, headers });
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e: AiError) => e);
const OUT = S.obj({ ok: S.bool() });
const ASK = [{ role: 'system' as const, content: 'You are a test.' }, { role: 'user' as const, content: 'hi' }];

describe('AI on another provider', () => {
  it('uses the one named model for both chat roles, with that provider’s key, and never asks for a model list', async () => {
    const p = otherProvider(() => answer('Hello'));
    try {
      expect(aiAvailable()).toBe(true);
      expect(aiProvider()).toBe(HOST);
      config.ai.providerName = 'FreeAI';
      expect(aiProvider()).toBe('FreeAI');
      expect(await chatText(ASK, { purpose: 'test.chat', role: 'fast' })).toBe('Hello');
      expect(await chatText(ASK, { purpose: 'test.chat', role: 'main' })).toBe('Hello');
      expect(p.calls.map((c) => c.path)).toEqual(['/chat/completions', '/chat/completions']);
      expect(p.calls.map((c) => c.body.model)).toEqual(['open-model-large', 'open-model-large']);
      expect(p.auth).toEqual(['Bearer free-plan-key', 'Bearer free-plan-key']);
      expect(await modelsInUse()).toEqual({ main: 'open-model-large', fast: 'open-model-large', vision: '', image: '', embedding: '', moderation: '' });
    } finally { await p.restore(); }
  });

  it('a separate fast model is used when one is named', async () => {
    const p = otherProvider(() => answer('Hello'), { fast: 'open-model-small' });
    try {
      await chatText(ASK, { purpose: 'test.chat', role: 'fast' });
      await chatText(ASK, { purpose: 'test.chat', role: 'main' });
      expect(p.calls.map((c) => c.body.model)).toEqual(['open-model-small', 'open-model-large']);
    } finally { await p.restore(); }
  });

  it('never calls what the provider doesn’t have: moderation, embeddings, room images and photo understanding', async () => {
    const p = otherProvider(() => answer('Hello'));
    try {
      expect([aiCan('main'), aiCan('fast'), aiCan('vision'), aiCan('image'), aiCan('embedding'), aiCan('moderation')]).toEqual([true, true, false, false, false, false]);
      // Each call starts only when it is awaited: started together, a later one could fail before anything was listening for it.
      for (const attempt of [
        () => moderate({ text: 'a lovely terrace' }, { purpose: 'trust.moderation' }),
        () => embed(['three bed house'], { purpose: 'search.rank' }),
        () => editImage(TINY_PNG, 'image/png', 'make it modern', { purpose: 'studio.room_image' }),
        () => chatText(ASK, { purpose: 'design.describe_photo', role: 'vision' }),
      ]) {
        const e = await failure(attempt());
        expect(e).toBeInstanceOf(AiError);
        expect(e.code).toBe('ai_unsupported');
        expect(e.status).toBe(503);
      }
      expect(p.calls).toHaveLength(0);
      // The site says so up front: AI is on, room images are not offered.
      const c = client();
      expect((await c.get('/api/ai/status')).json).toMatchObject({ enabled: true, imagesEnabled: false });
      expect((await c.get('/api/health')).json.features).toMatchObject({ ai: true, aiImages: false });
    } finally { await p.restore(); }
  });

  it('photo understanding is used once a vision model is named', async () => {
    const p = otherProvider(() => answer('A bright kitchen'), { vision: 'open-model-vision' });
    try {
      expect(aiCan('vision')).toBe(true);
      expect(await chatText(ASK, { purpose: 'design.describe_photo', role: 'vision' })).toBe('A bright kitchen');
      expect(p.calls[0].body.model).toBe('open-model-vision');
    } finally { await p.restore(); }
  });

  it('is switched off, not broken, when no model is named', async () => {
    const p = otherProvider(() => answer('Hello'), { main: '' });
    try {
      expect(aiAvailable()).toBe(false);
      expect(aiOffReason()).toBe('no_key');
      expect((await client().get('/api/ai/status')).json).toMatchObject({ enabled: false, reason: 'no_key' });
      expect(p.calls).toHaveLength(0);
    } finally { await p.restore(); }
  });

  it('asks for a plain JSON object when the model has no strict JSON schema, reads a wrapped answer, and remembers', async () => {
    const p = otherProvider((body) => (body.response_format?.type === 'json_schema'
      ? refuse(400, 'This model does not support response format `json_schema`.')
      : answer('Here you go:\n```json\n{ "ok": true }\n```')));
    try {
      expect(await chatJSON(ASK, OUT, 'check', { purpose: 'test.chat' })).toEqual({ ok: true });
      expect(p.calls.map((c) => c.body.response_format.type)).toEqual(['json_schema', 'json_object']);
      // The schema travels in the instructions instead, added to the existing system message.
      const second = p.calls[1].body.messages;
      expect(second).toHaveLength(2);
      expect(second[0].role).toBe('system');
      expect(second[0].content).toContain('You are a test.');
      expect(second[0].content).toContain('"ok"');
      // Next time it goes straight to the form the model accepts.
      expect(await chatJSON(ASK, OUT, 'check', { purpose: 'test.chat' })).toEqual({ ok: true });
      expect(p.calls).toHaveLength(3);
      expect(p.calls[2].body.response_format.type).toBe('json_object');
    } finally { await p.restore(); }
  });

  it('still refuses an answer that doesn’t match the schema', async () => {
    const p = otherProvider((body) => (body.response_format?.type === 'json_schema' ? refuse(400, 'json_schema is not supported') : answer('{ "ok": "yes" }')));
    try {
      const e = await failure(chatJSON(ASK, OUT, 'check', { purpose: 'test.chat' }));
      expect(e.code).toBe('ai_bad_output');
    } finally { await p.restore(); }
  });

  it('drops the strict flag on tools for a provider that doesn’t know it, and keeps the tools', async () => {
    const p = otherProvider((body) => (body.tools?.some((t: { function: object }) => 'strict' in t.function)
      ? refuse(400, "tools[0].function: property 'strict' is unsupported")
      : answer('The home is in E17.')));
    try {
      const tool = { name: 'lookup', description: 'Looks a home up', parameters: S.obj({ ref: S.str() }), run: () => ({ postcode: 'E17' }) };
      const r = await runWithTools(ASK, [tool], { purpose: 'assistant.chat' });
      expect(r.content).toBe('The home is in E17.');
      expect(p.calls).toHaveLength(2);
      expect(p.calls[1].body.tools).toHaveLength(1);
      expect(p.calls[1].body.tools[0].function.name).toBe('lookup');
      expect('strict' in p.calls[1].body.tools[0].function).toBe(false);
    } finally { await p.restore(); }
  });

  it('pauses until the allowance resets when the daily limit is reached, without the out-of-credit email', async () => {
    const mailsBefore = outbox.filter((m) => m.template === 'ai_quota').length;
    const p = otherProvider(() => refuse(429, 'Rate limit reached for model `open-model-large` on requests per day (RPD): Limit 1000, Used 1000.', { 'retry-after': '1200' }));
    try {
      const e = await failure(chatText(ASK, { purpose: 'test.chat' }));
      expect(e.code).toBe('ai_quota');
      expect(e.userMessage).toBe('Streetkey AI is temporarily unavailable. The rest of the site works as normal.');
      expect(p.calls).toHaveLength(1); // not retried: it won't clear in a few seconds
      expect(aiAvailable()).toBe(false);
      expect(aiOffReason()).toBe('paused');
      const stored = JSON.parse((await one<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'ai_paused_until'`))!.value);
      expect(stored.reason).toBe('limit');
      const minutes = (Date.parse(stored.until) - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(19);
      expect(minutes).toBeLessThanOrEqual(20);
      // While paused nothing more is sent, and the site reports AI as resting.
      await failure(chatText(ASK, { purpose: 'test.chat' }));
      expect(p.calls).toHaveLength(1);
      expect((await client().get('/api/ai/status')).json).toMatchObject({ enabled: false, reason: 'paused' });
      expect(outbox.filter((m) => m.template === 'ai_quota')).toHaveLength(mailsBefore);
    } finally { await p.restore(); }
    expect(aiOffReason()).not.toBe('paused');
  });

  it('treats “quota” wording from another provider as its allowance, not as OpenAI running out of credit', async () => {
    const mailsBefore = outbox.filter((m) => m.template === 'ai_quota').length;
    const p = otherProvider(() => refuse(429, 'You exceeded your current quota, please check your plan and billing details.'));
    try {
      const e = await failure(chatText(ASK, { purpose: 'test.chat' }));
      expect(e.code).toBe('ai_quota');
      const stored = JSON.parse((await one<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'ai_paused_until'`))!.value);
      expect(stored.reason).toBe('limit');
      expect(outbox.filter((m) => m.template === 'ai_quota')).toHaveLength(mailsBefore);
    } finally { await p.restore(); }
  });

  it('simply tries again after a brief per-minute limit', async () => {
    const p = otherProvider((_body, n) => (n === 0 ? refuse(429, 'Rate limit reached on tokens per minute (TPM). Please try again in 2s.', { 'retry-after': '2' }) : answer('Hello')));
    try {
      expect(await chatText(ASK, { purpose: 'test.chat' })).toBe('Hello');
      expect(p.calls).toHaveLength(2);
      expect(aiAvailable()).toBe(true);
    } finally { await p.restore(); }
  });
});
