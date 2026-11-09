/**
 * Every AI endpoint starts with aiGuard(): checks AI is switched on, applies per-feature
 * and daily limits (per account, or per IP for anonymous features) and returns who is asking.
 */
import type { FastifyRequest } from 'fastify';
import { config } from '../config';
import { HttpError, requireUser } from '../services/http';
import { anonId, enforce } from '../services/ratelimit';
import { aiAvailable, aiOffReason, refreshAiState, setActor } from './core';

/**
 * countDaily:false for cheap, cached read endpoints (e.g. similar homes) so browsing never uses up the daily allowance.
 * verified:true for expensive features (image generation, photo analysis): the account's email must be confirmed.
 */
export interface GuardOpts { auth?: boolean; verified?: boolean; perMinute?: number; perHour?: number; countDaily?: boolean }

export const AI_OFF_MESSAGE: Record<Exclude<ReturnType<typeof aiOffReason>, null>, string> = {
  disabled: 'Streetkey AI is switched off on this site.',
  no_key: 'Streetkey AI isn’t set up on this server yet.',
  paused: 'Streetkey AI is temporarily unavailable. The rest of the site works as normal.',
  budget: 'Streetkey AI is paused for a few hours (daily limit reached). The rest of the site works as normal.',
};

/** Throws 503 'ai_unavailable' unless AI can be used right now. */
export async function requireAi() {
  await refreshAiState();
  if (!aiAvailable()) throw new HttpError(503, AI_OFF_MESSAGE[aiOffReason() ?? 'disabled'], 'ai_unavailable');
}

export async function aiGuard(req: FastifyRequest, purpose: string, o: GuardOpts = {}) {
  await requireAi();
  const user = o.auth || o.verified ? requireUser(req) : req.user;
  if (o.verified && user && !user.email_verified_at) throw new HttpError(403, 'Confirm your email address to use this feature. We’ve sent you a link (check your spam folder too).', 'verify_email');
  // Every AI call made while handling this request is charged to this person (or visitor network).
  setActor(user ? `u:${user.id}` : anonId(req.ip));
  await enforce(req, `ai.${purpose}.m`, o.perMinute ?? 12, 60, 'user-or-ip', 'You’re going a bit fast for the AI. Please wait a moment and try again.');
  if (o.perHour) await enforce(req, `ai.${purpose}.h`, o.perHour, 3600, 'user-or-ip');
  if (o.countDaily !== false) await enforce(req, 'ai.daily', user ? config.ai.dailyRequestsPerUser : config.ai.dailyRequestsPerIp, 86_400, 'user-or-ip',
    user ? 'You’ve reached today’s AI limit. It resets within 24 hours.' : 'You’ve reached today’s AI limit for visitors. Create a free account for more.');
  return { userId: user?.id ?? null, user: user ?? null };
}
