/** Core hardening: SSRF-safe external photos, IPv6 rate-limit keys, AI quota pause and per-person token caps, model-list cache, migrations. */
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { one, q } from '../src/db';
import { AiError, aiAvailable, aiOffReason, chatJSON, refreshAiState, withActor } from '../src/ai/core';
import { S } from '../src/ai/schema';
import { ipKey, anonId } from '../src/services/ratelimit';
import { fetchExternalImage, fetchableExternal, getFile, isBlockedAddress, safeExternalUrl } from '../src/services/storage';
import { client, signUp } from './helpers';
import { outbox } from '../src/services/email';
import { mockOpenAI, reply, TINY_PNG } from './openai-mock';
import { fakeHosts } from './setup';

const PNG = TINY_PNG;
const img = () => new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } });

describe('external photo fetching (SSRF guard)', () => {
  it('only accepts https URLs on public host names', () => {
    expect(safeExternalUrl('https://images.agency.example.co.uk/p/1.jpg')).not.toBeNull();
    for (const bad of ['http://images.example.com/1.jpg', 'https://localhost/x', 'https://127.0.0.1/x', 'https://2130706433/x', 'https://0x7f000001/x', 'https://[::1]/x',
      'https://169.254.169.254/latest/meta-data', 'https://intranet/x', 'https://db.internal/x', 'https://printer.local/x', 'https://nas.home.arpa/x',
      'https://user:pw@example.com/x', 'https://example.com:8443/x', 'file:///etc/passwd', 'not a url']) {
      expect(safeExternalUrl(bad), bad).toBeNull();
    }
    expect(fetchableExternal('listings/a.jpg')).toBe(true);
    expect(fetchableExternal('ext:https://169.254.169.254/x')).toBe(false);
  });

  it('blocks private, loopback, link-local, CGNAT, ULA and mapped addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', 'ff02::1', 'not-an-ip']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2a00:1450:4009:80b::200e', '2606:4700::1111']) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it('follows at most 3 redirects, re-checking each one, and refuses non-images', async () => {
    const hops: string[] = [];
    fakeHosts.set('a.example.com', (url) => { hops.push(url); return new Response(null, { status: 302, headers: { location: 'https://b.example.com/2.jpg' } }); });
    fakeHosts.set('b.example.com', (url) => { hops.push(url); return img(); });
    fakeHosts.set('evil.example.com', () => new Response(null, { status: 301, headers: { location: 'https://169.254.169.254/latest/meta-data' } }));
    fakeHosts.set('loop.example.com', () => new Response(null, { status: 302, headers: { location: 'https://loop.example.com/again' } }));
    fakeHosts.set('html.example.com', () => new Response('<html>', { headers: { 'content-type': 'text/html' } }));
    try {
      expect((await fetchExternalImage('https://a.example.com/1.jpg'))?.equals(PNG)).toBe(true);
      expect(hops).toEqual(['https://a.example.com/1.jpg', 'https://b.example.com/2.jpg']);
      expect(await fetchExternalImage('https://evil.example.com/x.jpg')).toBeNull();
      expect(await fetchExternalImage('https://loop.example.com/x.jpg')).toBeNull();
      expect(await fetchExternalImage('https://html.example.com/x.jpg')).toBeNull();
      // getFile enforces the same rules, so no caller can skip them
      expect(await getFile('ext:https://evil.example.com/x.jpg')).toBeNull();
      expect(await getFile('ext:http://b.example.com/2.jpg')).toBeNull();
      expect((await getFile('ext:https://b.example.com/2.jpg'))?.length).toBe(PNG.length);
    } finally { for (const h of ['a', 'b', 'evil', 'loop', 'html']) fakeHosts.delete(`${h}.example.com`); }
  });
});

describe('rate-limit keys', () => {
  it('uses the address for IPv4 (unwrapping mapped IPv6) and the /64 for IPv6', () => {
    expect(ipKey('203.0.113.9')).toBe('ip:203.0.113.9');
    expect(ipKey('::ffff:203.0.113.9')).toBe('ip:203.0.113.9');
    expect(ipKey('2001:db8:1:2:aaaa::1')).toBe('ip6:2001:db8:1:2::/64');
    expect(ipKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('ip6:2001:db8:1:2::/64');
    expect(ipKey('2001:db8::1')).toBe('ip6:2001:db8:0:0::/64');
    expect(ipKey('fe80::1%eth0')).toBe('ip6:fe80:0:0:0::/64');
    expect(ipKey(undefined)).toBe('ip:unknown');
    expect(anonId('2001:db8:1:2::5')).toBe(anonId('2001:db8:1:2:ffff::9'));
    expect(anonId('2001:db8:1:2::5')).not.toBe(anonId('2001:db8:1:3::5'));
    expect(anonId('203.0.113.9')).not.toContain('203');
  });
});

const OUT = S.obj({ ok: S.bool() });

describe('AI budget, per-person caps and the out-of-credit pause', () => {
  it('pauses AI everywhere when OpenAI says the account has no credit, and tells the admin once', async () => {
    let calls = 0;
    const ai = mockOpenAI({ chat: () => { calls++; return { status: 429, error: { message: 'You exceeded your current quota, please check your plan and billing details.', code: 'insufficient_quota' } }; } });
    const before = config.adminEmail;
    config.adminEmail = 'admin@example.com';
    try {
      const err = (await chatJSON([{ role: 'user', content: 'hi' }], OUT, 'x', { purpose: 'test.chat' }).catch((e: AiError) => e)) as AiError;
      expect(err.code).toBe('ai_quota');
      expect(err.userMessage).not.toMatch(/credit|billing/i); // the public message stays generic
      expect(calls).toBe(1);                                   // quota errors aren't retried
      expect(aiAvailable()).toBe(false);
      expect(aiOffReason()).toBe('paused');
      const again = (await chatJSON([{ role: 'user', content: 'hi' }], OUT, 'x', { purpose: 'test.chat' }).catch((e: AiError) => e)) as AiError;
      expect(again.code).toBe('ai_quota');
      expect(calls).toBe(1);                                   // paused: no further calls to OpenAI
      const stored = await one<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'ai_paused_until'`);
      expect(JSON.parse(stored!.value).reason).toBe('quota');
      expect(outbox.filter((m) => m.template === 'ai_quota')).toHaveLength(1); // once per pause
      const c = client();
      const status = await c.get('/api/ai/status');
      expect(status.json).toMatchObject({ enabled: false, reason: 'paused' });
    } finally {
      ai.restore();
      config.adminEmail = before;
      await q(`DELETE FROM app_settings WHERE key = 'ai_paused_until'`);
      await refreshAiState(true);
    }
    expect(aiOffReason()).not.toBe('paused');
  });

  it('caps tokens per person, but not safety checks', async () => {
    const ai = mockOpenAI({ chat: () => reply.json({ ok: true }) }); // the mock reports 150 tokens per call
    const saved = config.ai.dailyTokensPerUser;
    config.ai.dailyTokensPerUser = 250;
    try {
      const { user } = await signUp();
      const actor = `u:${user.id}`;
      const run = (purpose: string) => withActor(actor, () => chatJSON([{ role: 'user', content: 'hi' }], OUT, 'x', { purpose, userId: user.id })).then(() => 'ok', (e) => e.code);
      expect(await run('listing.describe')).toBe('ok');   // 150 tokens
      expect(await run('listing.describe')).toBe('ok');   // 300 (checked before the call: 150 < 250)
      expect(await run('listing.describe')).toBe('ai_user_limit');
      expect(await run('trust.review')).toBe('ok');       // safety work isn't capped per person
      const rows = await q<{ actor: string }>(`SELECT actor FROM ai_usage WHERE user_id = $1`, [user.id]);
      expect(rows.length).toBe(3);
      expect(rows.every((r) => r.actor === actor)).toBe(true);
    } finally { ai.restore(); config.ai.dailyTokensPerUser = saved; }
  });

  it('keeps a reserve of the daily budget for safety checks', async () => {
    const ai = mockOpenAI({ chat: () => reply.json({ ok: true }) });
    const saved = config.ai.dailyTokenBudget;
    await q(`INSERT INTO ai_usage (purpose, model, input_tokens, output_tokens) VALUES ('test.seed', 'x', 2000, 0)`);
    try {
      const used = Number((await one<{ n: number }>(`SELECT coalesce(sum(input_tokens + output_tokens), 0)::bigint n FROM ai_usage WHERE at > now() - interval '24 hours'`))!.n);
      config.ai.dailyTokenBudget = Math.ceil((used + 100) / 0.9); // ordinary features stop at 85%, so we're already past it
      await refreshAiState(true);
      const ordinary = (await chatJSON([{ role: 'user', content: 'hi' }], OUT, 'x', { purpose: 'search.intent' }).catch((e: AiError) => e)) as AiError;
      expect(ordinary.code).toBe('ai_budget');
      expect(aiOffReason()).toBe('budget');
      await expect(chatJSON([{ role: 'user', content: 'hi' }], OUT, 'x', { purpose: 'trust.review' })).resolves.toEqual({ ok: true });
    } finally { ai.restore(); config.ai.dailyTokenBudget = saved; await refreshAiState(true); }
  });

  it('records a paid call whose output is thrown away as a failure', async () => {
    const ai = mockOpenAI({ chat: () => reply.json({ wrong: 1 }) });
    try {
      const e = (await chatJSON([{ role: 'user', content: 'hi' }], OUT, 'x', { purpose: 'test.badshape' }).catch((x: AiError) => x)) as AiError;
      expect(e.code).toBe('ai_bad_output');
      const row = await one<{ ok: boolean; error_code: string }>(`SELECT ok, error_code FROM ai_usage WHERE purpose = 'test.badshape' ORDER BY id DESC LIMIT 1`);
      expect(row).toMatchObject({ ok: false, error_code: 'ai_bad_output' });
    } finally { ai.restore(); }
  });
});

describe('account deletion (right to erasure)', () => {
  it('removes design-studio photos and AI results, AI jobs and draft listing photos', async () => {
    const { putFile, getFile: read } = await import('../src/services/storage');
    const { PASSWORD } = await import('./helpers');
    const s = await signUp();
    const src = await putFile(`ai/source/${s.user.id}-room.png`, TINY_PNG, 'image/png');
    const res = await putFile(`ai/results/${s.user.id}-room.png`, TINY_PNG, 'image/png');
    await q(`INSERT INTO ai_images (user_id, room, style, brief, prompt, model, status, source_key, result_key, result_url) VALUES ($1, 'kitchen', 'modern', 'my kitchen', 'p', 'gpt-image-2', 'done', $2, $3, $4)`, [s.user.id, src.key, res.key, res.url]);
    await q(`INSERT INTO ai_jobs (kind, user_id, input) VALUES ('studio.room_image', $1, '{"brief":"my kitchen"}')`, [s.user.id]);
    const draft = await s.c.post('/api/listings', { channel: 'sale', title: 'Draft home' }).catch(() => null);
    expect((await s.c.del('/api/me', { password: PASSWORD })).status).toBe(200);
    expect(await q('SELECT 1 FROM ai_images WHERE user_id = $1', [s.user.id])).toHaveLength(0);
    expect(await q('SELECT 1 FROM ai_jobs WHERE user_id = $1', [s.user.id])).toHaveLength(0);
    expect(await read(src.key)).toBeNull();
    expect(await read(res.key)).toBeNull();
    if (draft?.status === 201) expect(await q('SELECT 1 FROM listings WHERE owner_user_id = $1 AND status = $2', [s.user.id, 'draft'])).toHaveLength(0);
  });
});
