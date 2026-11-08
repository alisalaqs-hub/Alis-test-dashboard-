/**
 * Rate limiting that works across every server instance (serverless included):
 * fixed-window counters in PostgreSQL. One upsert per checked request.
 *
 *   app.post('/api/auth/login', { preHandler: limit('login', 10, 60) }, ...)
 *   await enforce(req, 'ai.chat', 30, 3600, 'user')
 */
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
const who = (req: FastifyRequest, by: LimitBy) => (by === 'ip' ? `ip:${req.ip}` : by === 'user' ? `u:${req.user?.id ?? `ip:${req.ip}`}` : req.user ? `u:${req.user.id}` : `ip:${req.ip}`);

export async function enforce(req: FastifyRequest, name: string, max: number, windowSec: number, by: LimitBy = 'ip', message?: string) {
  const r = await hit(`${name}:${who(req, by)}`, max, windowSec);
  if (!r.ok) {
    const mins = Math.ceil(r.resetSec / 60);
    throw new HttpError(429, message ?? (windowSec >= 3600 ? `You’ve reached the limit for now. Please try again in about ${mins >= 60 ? `${Math.ceil(mins / 60)} hour${mins >= 120 ? 's' : ''}` : `${mins} minutes`}.` : 'Too many attempts. Please wait a minute and try again.'), 'rate_limited', { retryAfter: String(r.resetSec) });
  }
  return r;
}

/** Route option: { preHandler: limit('login', 10, 60) } */
export const limit = (name: string, max: number, windowSec = 60, by: LimitBy = 'ip') => async (req: FastifyRequest) => { await enforce(req, name, max, windowSec, by); };
