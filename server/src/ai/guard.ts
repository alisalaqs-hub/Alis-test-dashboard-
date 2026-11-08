/**
 * Every AI endpoint starts with aiGuard(): checks AI is switched on, applies per-feature
 * and daily limits (per account, or per IP for anonymous features) and returns who is asking.
 */
import type { FastifyRequest } from 'fastify';
import { config } from '../config';
import { HttpError, requireUser } from '../services/http';
import { enforce } from '../services/ratelimit';
import { aiAvailable } from './core';

export interface GuardOpts { auth?: boolean; perMinute?: number; perHour?: number }

export async function aiGuard(req: FastifyRequest, purpose: string, o: GuardOpts = {}) {
  if (!aiAvailable()) throw new HttpError(503, config.ai.disabled ? 'Streetkey AI is switched off on this site.' : 'Streetkey AI isn’t set up on this server yet.', 'ai_unavailable');
  const user = o.auth ? requireUser(req) : req.user;
  await enforce(req, `ai.${purpose}.m`, o.perMinute ?? 12, 60, 'user-or-ip', 'You’re going a bit fast for the AI. Please wait a moment and try again.');
  if (o.perHour) await enforce(req, `ai.${purpose}.h`, o.perHour, 3600, 'user-or-ip');
  await enforce(req, 'ai.daily', user ? config.ai.dailyRequestsPerUser : config.ai.dailyRequestsPerIp, 86_400, 'user-or-ip',
    user ? 'You’ve reached today’s AI limit. It resets within 24 hours.' : 'You’ve reached today’s AI limit for visitors. Create a free account for more.');
  return { userId: user?.id ?? null, user: user ?? null };
}
