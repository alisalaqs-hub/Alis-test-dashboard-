import { afterAll, beforeAll } from 'vitest';
import { pool } from '../src/db';
import { migrate } from '../src/migrate';

/** Outbound HTTP is faked in tests: postcodes.io answers from a tiny table; tests can add handlers. */
type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response;
export const fakeHosts = new Map<string, Handler>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).host;
  const h = fakeHosts.get(host);
  if (h) return h(url, init);
  if (host === 'api.postcodes.io') {
    if (init?.method === 'POST') {
      const { postcodes } = JSON.parse(String(init.body)) as { postcodes: string[] };
      return Response.json({ result: postcodes.map((p) => ({ query: p, result: { latitude: 51.58, longitude: -0.02, outcode: p.split(' ')[0] } })) });
    }
    const pc = decodeURIComponent(url.split('/').pop() ?? '');
    return Response.json({ result: { latitude: 51.5843, longitude: -0.0197, outcode: pc.split(' ')[0] } });
  }
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) return realFetch(input, init);
  throw new Error(`Unexpected outbound request in tests: ${url}`);
}) as typeof fetch;

beforeAll(async () => {
  // Fresh schema for every test file.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
});
afterAll(async () => { await pool.end(); });
