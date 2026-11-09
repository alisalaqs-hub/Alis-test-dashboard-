/**
 * Rate limiting that works across every server instance (serverless included):
 * fixed-window counters in PostgreSQL. One upsert per checked request.
 *
 *   app.post('/api/auth/login', { preHandler: limit('login', 10, 60) }, ...)
 *   await enforce(req, 'ai.chat', 30, 3600, 'user')
 */
import { createHash } from 'node:crypto';
import net from 'node:net';
import type { FastifyRequest } from 'fastify';
import { config } from '../config';
import { one } from '../db';
import { HttpError } from './http';

/** Tests raise limits (RATE_LIMIT_MULTIPLIER) so suites can sign up many accounts quickly. */
export const limits = { multiplier: Number(process.env.RATE_LIMIT_MULTIPLIER || (config.isTest ? 1000 : 1)) };

export async function hit(key: string, max: number, windowSec: number) {
  const r = await one<{ count: number; reset: number }>(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count, ceil(extract(epoch FROM window_start) + $2 - extract(epoch FROM now()))::int AS reset`, [key, windowSec]);
  const cap = Math.max(1, Math.round(max * limits.multiplier));
  return { ok: r!.count <= cap, remaining: Math.max(0, cap - r!.count), resetSec: Math.max(1, r!.reset) };
}

export type LimitBy = 'ip' | 'user' | 'user-or-ip';
/**
 * The key for a visitor's network. IPv4 addresses are used as they are (IPv4-mapped IPv6 is unwrapped);
 * IPv6 addresses are cut to their /64, because one home or server usually controls a whole /64 and could
 * otherwise rotate addresses to get round every limit.
 */
export function ipKey(ip: string | undefined | null): string {
  let v = String(ip ?? '').trim().toLowerCase().replace(/%.*$/, '');
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) v = mapped[1];
  if (net.isIPv4(v)) return `ip:${v}`;
  if (net.isIPv6(v)) return `ip6:${expandV6(v).slice(0, 4).join(':')}::/64`;
  return `ip:${v || 'unknown'}`;
}
function expandV6(v: string): string[] {
  const [head, tail = ''] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = v.includes('::') && tail ? tail.split(':') : [];
  // An embedded IPv4 tail (e.g. 64:ff9b::1.2.3.4) counts as two groups.
  const last = (v.includes('::') ? t : h).at(-1) ?? '';
  if (net.isIPv4(last)) {
    const [a, b, c, d] = last.split('.').map(Number);
    const groups = [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
    if (v.includes('::')) t.splice(-1, 1, ...groups); else h.splice(-1, 1, ...groups);
  }
  const fill = v.includes('::') ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map((g) => g.replace(/^0+(?=.)/, ''));
}
/** A visitor's network as a stable, non-reversible id (for usage records). */
export const anonId = (ip: string | undefined | null) => `ip:${createHash('sha256').update(ipKey(ip)).digest('hex').slice(0, 24)}`;

const who = (req: FastifyRequest, by: LimitBy) => (by === 'ip' ? ipKey(req.ip) : by === 'user' ? `u:${req.user?.id ?? ipKey(req.ip)}` : req.user ? `u:${req.user.id}` : ipKey(req.ip));

/** Throws 429 (code 'rate_limited' unless another is given, with retryAfter in seconds) once the limit is used up. */
export async function enforce(req: FastifyRequest, name: string, max: number, windowSec: number, by: LimitBy = 'ip', message?: string, code = 'rate_limited') {
  const r = await hit(`${name}:${who(req, by)}`, max, windowSec);
  if (!r.ok) {
    const mins = Math.ceil(r.resetSec / 60);
    throw new HttpError(429, message ?? (windowSec >= 3600 ? `You’ve reached the limit for now. Please try again in about ${mins >= 60 ? `${Math.ceil(mins / 60)} hour${mins >= 120 ? 's' : ''}` : `${mins} minutes`}.` : 'Too many attempts. Please wait a minute and try again.'), code, { retryAfter: String(r.resetSec) });
  }
  return r;
}

/** Route option: { preHandler: limit('login', 10, 60) } */
export const limit = (name: string, max: number, windowSec = 60, by: LimitBy = 'ip') => async (req: FastifyRequest) => { await enforce(req, name, max, windowSec, by); };
