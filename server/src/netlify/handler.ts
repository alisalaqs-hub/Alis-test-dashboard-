/**
 * Runs the Streetkey Fastify app inside a Netlify Function (web-standard Request/Response).
 * The app is built once per warm instance; migrations run once per cold start.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { ensureMigrated } from '../migrate';

let appPromise: Promise<FastifyInstance> | null = null;
export function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      await ensureMigrated();
      const app = await buildApp();
      await app.ready();
      return app;
    })().catch((e) => { appPromise = null; throw e; });
  }
  return appPromise;
}

const HOP = new Set(['connection', 'transfer-encoding', 'keep-alive', 'content-length']);

export async function handleApi(req: Request, ip: string): Promise<Response> {
  let app: FastifyInstance;
  try { app = await getApp(); } catch (e) {
    console.error('[streetkey] startup failed:', (e as Error).message);
    return Response.json({ error: { code: 'starting', message: 'Streetkey is starting up or can’t reach its database. Please try again in a moment.' } }, { status: 503 });
  }
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  headers.host = url.host;
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const payload = hasBody ? Buffer.from(await req.arrayBuffer()) : undefined;
  const res = await app.inject({
    method: req.method as 'GET', url: url.pathname + url.search, headers, payload, remoteAddress: ip || '0.0.0.0',
  });
  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v == null || HOP.has(k.toLowerCase())) continue;
    if (Array.isArray(v)) v.forEach((x) => out.append(k, String(x))); else out.set(k, String(v));
  }
  return new Response(req.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304 ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out });
}
