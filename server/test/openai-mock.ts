/**
 * Fake OpenAI for tests. Each test describes how the "model" answers:
 *
 *   const ai = mockOpenAI({ chat: (body) => reply.json({ title: 'Bright terrace' }) })
 *   ... call the API ...
 *   expect(ai.calls('chat')[0].body.model).toBe('gpt-5-mini')
 *   ai.restore()
 *
 * Supports /models, /chat/completions (JSON, text and tool calls), /moderations,
 * /embeddings and /images/edits. Unhandled endpoints return a 500 so tests notice.
 */
import { config } from '../src/config';
import { resetAiCaches } from '../src/ai/core';
import { fakeHosts } from './setup';

export interface ChatMessage { content?: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; refusal?: string | null }
type ChatFn = (body: any, n: number) => ChatMessage | { status: number; error: { message: string; param?: string; code?: string } } | Promise<ChatMessage>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const reply = {
  json: (obj: unknown): ChatMessage => ({ content: JSON.stringify(obj) }),
  text: (t: string): ChatMessage => ({ content: t }),
  tools: (calls: { name: string; args: unknown }[]): ChatMessage => ({ content: null, tool_calls: calls.map((c, i) => ({ id: `call_${i}_${c.name}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }),
};

export const DEFAULT_MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-image-2', 'gpt-image-1', 'text-embedding-3-small', 'omni-moderation-latest'];

/** Deterministic pseudo-embedding: texts sharing words get similar vectors. */
export function fakeEmbedding(text: string, dims = 64) {
  const v = new Array(dims).fill(0);
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % dims] += 1; }
  return v;
}

export function mockOpenAI(o: {
  models?: string[];
  chat?: ChatFn;
  moderations?: (input: unknown[]) => { flagged: boolean; categories?: string[] };
  embeddings?: (texts: string[]) => number[][];
  images?: (form: FormData) => Buffer | { status: number; error: { message: string; param?: string } };
} = {}) {
  const log: { path: string; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let chatN = 0;
  config.ai.openaiKey = 'sk-test';
  config.ai.disabled = false;
  resetAiCaches();
  fakeHosts.set('api.openai.com', async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/v1/, '');
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : null;
    log.push({ path, body });
    if (path === '/models') return Response.json({ data: (o.models ?? DEFAULT_MODELS).map((id) => ({ id })) });
    if (path === '/chat/completions' && o.chat) {
      const r = await o.chat(body, chatN++);
      if ('status' in r && 'error' in r) return Response.json({ error: r.error }, { status: r.status });
      const msg = r as ChatMessage;
      return Response.json({ choices: [{ message: { content: msg.content ?? null, tool_calls: msg.tool_calls, refusal: msg.refusal ?? null }, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
    }
    if (path === '/moderations') {
      const r = o.moderations ? o.moderations(body.input) : { flagged: false };
      return Response.json({ results: [{ flagged: r.flagged, categories: Object.fromEntries((r.categories ?? []).map((c) => [c, true])), category_scores: {} }] });
    }
    if (path === '/embeddings') {
      const texts: string[] = Array.isArray(body.input) ? body.input : [body.input];
      const vecs = o.embeddings ? o.embeddings(texts) : texts.map((t) => fakeEmbedding(t));
      return Response.json({ data: vecs.map((embedding, index) => ({ embedding, index })), usage: { prompt_tokens: 10 * texts.length } });
    }
    if (path === '/images/edits' && o.images) {
      const r = o.images(body as FormData);
      if (Buffer.isBuffer(r)) return Response.json({ data: [{ b64_json: r.toString('base64') }] });
      return Response.json({ error: r.error }, { status: r.status });
    }
    return Response.json({ error: { message: `mock has no handler for ${path}` } }, { status: 500 });
  });
  return {
    calls: (kind?: 'chat' | 'moderations' | 'embeddings' | 'images' | 'models') => log.filter((c) => !kind || c.path === ({ chat: '/chat/completions', moderations: '/moderations', embeddings: '/embeddings', images: '/images/edits', models: '/models' } as const)[kind]),
    restore: () => { fakeHosts.delete('api.openai.com'); config.ai.openaiKey = ''; resetAiCaches(); },
  };
}

/** A 1×1 PNG, handy as an "AI image". */
export const TINY_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4be0000000049454e44ae426082', 'hex');
