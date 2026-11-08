import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app';
import { q } from '../src/db';
import { outbox } from '../src/services/email';

let app: FastifyInstance | null = null;
export async function getApp() { if (!app) { app = await buildApp(); await app.ready(); } return app; }

/** A browser-like client: keeps its session cookie between requests. */
export function client() {
  let cookie = '';
  const call = async (method: InjectOptions['method'], url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const a = await getApp();
    const r = await a.inject({ method, url, payload: payload as InjectOptions['payload'], headers: { ...(cookie ? { cookie } : {}), ...headers } });
    const set = r.headers['set-cookie'];
    for (const c of ([] as string[]).concat(set ?? [])) {
      const [pair] = c.split(';');
      if (pair.startsWith('sk_session=')) cookie = pair.endsWith('=') ? '' : pair;
    }
    let json: any = null; try { json = r.json(); } catch { /* not JSON */ }
    return { status: r.statusCode, json, headers: r.headers, body: r.body };
  };
  return {
    get: (u: string, h?: Record<string, string>) => call('GET', u, undefined, h),
    post: (u: string, p?: unknown, h?: Record<string, string>) => call('POST', u, p, h),
    patch: (u: string, p?: unknown) => call('PATCH', u, p),
    put: (u: string, p?: unknown) => call('PUT', u, p),
    del: (u: string, p?: unknown) => call('DELETE', u, p),
    raw: call,
    get cookie() { return cookie; },
  };
}

export const PASSWORD = 'correct horse battery staple';
let n = 0;
export async function signUp(opts: { accountType?: string; name?: string } = {}) {
  const c = client();
  const email = `user${++n}-${Date.now()}@example.com`;
  const r = await c.post('/api/auth/register', { email, password: PASSWORD, name: opts.name ?? `User ${n}`, accountType: opts.accountType ?? 'buyer', acceptTerms: true });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.json)}`);
  return { c, email, user: r.json.user };
}

export async function makeAdmin(email: string) { await q(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]); }
export const lastMail = (to?: string) => [...outbox].reverse().find((m) => !to || m.to === to);
export const tokenIn = (text: string) => text.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? '';

/** Multipart body builder for uploads. */
export function multipart(files: { field: string; name: string; type: string; data: Buffer }[], fields: Record<string, string> = {}) {
  const boundary = '----sktest' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(f.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** A tiny valid JPEG with an EXIF (APP1) segment carrying fake GPS text. */
export function jpegWithExif() {
  const soi = Buffer.from([0xff, 0xd8]);
  const exifPayload = Buffer.from('Exif\0\0GPS 51.5007N 0.1246W secret-location');
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(exifPayload.length + 2) >> 8, (exifPayload.length + 2) & 0xff]), exifPayload]);
  const app0Payload = Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1');
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), Buffer.from([0, app0Payload.length + 2]), app0Payload]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0x56, 0xff, 0xd9]);
  return Buffer.concat([soi, app0, app1, sos]);
}

export const LISTING = {
  channel: 'sale', title: '3-bed Victorian terrace with garden', addressLine: '14 Elm Road', town: 'London', postcode: 'E17 4QH',
  type: 'terraced', tenure: 'freehold', beds: 3, baths: 1, floorArea: 92, era: 'pre-1919', condition: 'fair', price: 525000,
  epc: 'D', councilTax: 'C', features: ['Garden', 'Period features'], description: 'A bright family home close to Walthamstow Central.', ownershipDeclared: true,
};
