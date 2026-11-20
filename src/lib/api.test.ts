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

describe('uploading a feed file by hand', () => {
  const sent = (mock: ReturnType<typeof answer>) => (mock.mock.calls as unknown as [string, RequestInit][])[0];
  it('sends the file as text exactly as it is (not JSON) and returns the result', async () => {
    const result = { accepted: 2, updated: 1, withdrawn: 0, rejected: [{ ref: 'A9', reason: 'Missing price' }], leftOut: { epc: 0, documents: 0, virtualTours: 0, notLinks: 0 }, format: 'BLM 3', note: 'Listings are live.' };
    const mock = answer(200, result);
    vi.stubGlobal('fetch', mock);
    const file = '#HEADER#\nVersion : 3\n#DEFINITION#\nAGENT_REF^~\n#DATA#\nA1^~\n#END#';
    expect(await api.orgs.uploadFeed('0b5c0f0e-1111-4222-8333-444455556666', file)).toEqual(result);
    const [url, init] = sent(mock);
    expect(url).toMatch(/\/api\/orgs\/0b5c0f0e-1111-4222-8333-444455556666\/feed-upload$/);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: file, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  });
  it('passes on the reason when the server refuses the file', async () => {
    vi.stubGlobal('fetch', answer(413, { error: { code: 'feed_too_large', message: 'That file is too large: the limit is 4.5 MB per upload.' } }));
    await expect(api.orgs.uploadFeed('org', 'x')).rejects.toMatchObject({ status: 413, code: 'feed_too_large', message: 'That file is too large: the limit is 4.5 MB per upload.' });
  });
  it('still sends everything else as JSON', async () => {
    const mock = answer(201, { key: 'skf_x', note: '' });
    vi.stubGlobal('fetch', mock);
    await api.orgs.createKey('org', 'Branch 1');
    expect(sent(mock)[1]).toMatchObject({ body: '{"label":"Branch 1"}', headers: { 'Content-Type': 'application/json' } });
  });
});
