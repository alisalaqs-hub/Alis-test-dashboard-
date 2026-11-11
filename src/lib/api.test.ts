import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

const answer = (status: number, body: unknown, type = 'application/json') => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } }));
afterEach(() => { vi.unstubAllGlobals(); });

describe('checking whether the back end is there', () => {
  it('accepts a healthy answer', async () => {
    vi.stubGlobal('fetch', answer(200, { ok: true, version: '1', features: { ai: false, aiImages: false, email: 'log', storage: 'local', moderation: true, runtime: 'node' } }));
    expect((await api.health())?.features.ai).toBe(false);
  });
  it('treats a back end that is starting up, or has no database, as not there', async () => {
    vi.stubGlobal('fetch', answer(503, { error: { code: 'starting', message: 'Streetkey is starting up or can’t reach its database.' } }));
    expect(await api.health()).toBeNull();
  });
  it('treats anything that is not a health answer as not there', async () => {
    vi.stubGlobal('fetch', answer(200, '<html>the site itself</html>', 'text/html'));
    expect(await api.health()).toBeNull();
    vi.stubGlobal('fetch', answer(200, { something: 'else' }));
    expect(await api.health()).toBeNull();
    vi.stubGlobal('fetch', answer(502, { errorType: 'Error', errorMessage: 'crashed' }));
    expect(await api.health()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    expect(await api.health()).toBeNull();
  });
});
