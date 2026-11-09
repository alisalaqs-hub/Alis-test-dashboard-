/**
 * Who may use AI, and what it costs them. Two steps, so a request only uses the AI allowance once it is
 * valid and the model is really going to be called:
 *
 *   const { userId } = await aiAccess(req, { auth: true });   // AI switched on? signed in? Charges nothing.
 *   …parse the body, check ownership, look in the cache…
 *   await aiCharge(req, 'listing.describe', { perMinute: 6, perHour: 40 });   // per-minute, per-hour and daily limits
 *
 * aiGuard() does both at once, for endpoints where everything after it reaches the model.
 * Limits are per account, or per visitor network for anonymous features.
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
export type AccessOpts = Pick<GuardOpts, 'auth' | 'verified'>;
export type ChargeOpts = Pick<GuardOpts, 'perMinute' | 'perHour' | 'countDaily'>;

export const AI_OFF_MESSAGE: Record<Exclude<ReturnType<typeof aiOffReason>, null>, string> = {
  disabled: 'Streetkey AI is switched off on this site.',
  no_key: 'Streetkey AI isn’t set up on this server yet.',
  paused: 'Streetkey AI is temporarily unavailable. The rest of the site works as normal.',
  budget: 'Streetkey AI is paused for a few hours (daily limit reached). The rest of the site works as normal.',
};

/** The daily AI allowance has its own error code, so the website can tell it apart from the short per-minute limit. */
export const DAILY_LIMIT_CODE = 'daily_limit';

/** Throws 503 'ai_unavailable' unless AI can be used right now. */
export async function requireAi() {
  await refreshAiState();
  if (!aiAvailable()) throw new HttpError(503, AI_OFF_MESSAGE[aiOffReason() ?? 'disabled'], 'ai_unavailable');
}

/**
 * Checks AI is on, and (auth / verified) that the person is signed in with a confirmed email. Every AI call made
 * while handling this request is charged to this person (or visitor network). Uses none of the AI allowance.
 */
export async function aiAccess(req: FastifyRequest, o: AccessOpts = {}) {
  await requireAi();
  const user = o.auth || o.verified ? requireUser(req) : req.user;
  if (o.verified && user && !user.email_verified_at) throw new HttpError(403, 'Confirm your email address to use this feature. We’ve sent you a link (check your spam folder too).', 'verify_email');
  setActor(user ? `u:${user.id}` : anonId(req.ip));
  return { userId: user?.id ?? null, user: user ?? null };
}

/**
 * One request to the daily AI allowance shared by every AI feature (per account, or per visitor network).
 * 429 'daily_limit' when it is used up.
 */
export async function chargeDailyAi(req: FastifyRequest) {
  const signedIn = !!req.user;
  await enforce(req, 'ai.daily', signedIn ? config.ai.dailyRequestsPerUser : config.ai.dailyRequestsPerIp, 86_400, 'user-or-ip',
    signedIn ? 'You’ve reached today’s AI limit. It resets within 24 hours.' : 'You’ve reached today’s AI limit for visitors. Create a free account for more.',
    DAILY_LIMIT_CODE);
}

/** Charges a request that is about to call the model: the feature's per-minute and per-hour limits, then the daily allowance. */
export async function aiCharge(req: FastifyRequest, purpose: string, o: ChargeOpts = {}) {
  await enforce(req, `ai.${purpose}.m`, o.perMinute ?? 12, 60, 'user-or-ip', 'You’re going a bit fast for the AI. Please wait a moment and try again.');
  if (o.perHour) await enforce(req, `ai.${purpose}.h`, o.perHour, 3600, 'user-or-ip');
  if (o.countDaily !== false) await chargeDailyAi(req);
}

/** aiAccess and aiCharge together: for endpoints where everything after the guard reaches the model. */
export async function aiGuard(req: FastifyRequest, purpose: string, o: GuardOpts = {}) {
  const who = await aiAccess(req, o);
  await aiCharge(req, purpose, o);
  return who;
}
