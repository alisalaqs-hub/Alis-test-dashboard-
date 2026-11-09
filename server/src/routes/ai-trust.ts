/**
 * AI trust & safety for listings: every submitted listing gets an automated check (moderation,
 * code-computed scam and material-information signals, then an AI review) that admins see in
 * the review queue, riskiest first. Optional auto-approval for clearly low-risk listings
 * (AI_AUTO_APPROVE_LOW_RISK); AI never rejects a listing. Admin endpoints only.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one } from '../db';
import { aiAvailable } from '../ai/core';
import { aiGuard } from '../ai/guard';
import { on } from '../ai/hooks';
import { enqueue, jobDTO, registerJob } from '../ai/jobs';
import { reviewListing } from '../ai/trust/review';
import { activeJob, AUTO_APPROVE_MAX_SCORE, autoApproveEnabled, jobSubject, lastFailedCheck, latestReview, pendingQueue, recentAutoApproved, TRUST_JOB } from '../ai/trust/store';
import { audit, notFound, parse, requireAdmin } from '../services/http';
import { enforce, hit } from '../services/ratelimit';

const JobInput = z.object({ listingId: z.uuid(), trigger: z.enum(['submitted', 'admin']).default('submitted') });
const RefParams = z.object({ ref: z.string().trim().min(3).max(40).regex(/^[a-z0-9-]+$/i, 'That isn’t a listing reference.') });

/** Automatic reviews per listing and per lister each day (a submit/withdraw loop can't run up AI costs). */
const DAILY_REVIEWS_PER_LISTING = 6;
const DAILY_REVIEWS_PER_LISTER = 40;
const JOB_ATTEMPTS = 2;

export async function aiTrustRoutes(app: FastifyInstance) {
  registerJob(TRUST_JOB, async (job, ctx) => {
    const input = JobInput.parse(job.input);
    // On the last attempt an AI fault falls back to a rules-only review instead of failing (job.attempts counts this one).
    return reviewListing(input.listingId, { trigger: input.trigger, userId: job.user_id, progress: ctx.progress, finalAttempt: job.attempts >= JOB_ATTEMPTS });
  }, { maxAttempts: JOB_ATTEMPTS, leaseSec: 900 });

  on('listingSubmitted', async ({ listingId, ref, userId }) => {
    if (!aiAvailable()) return; // AI off: listings simply wait for a person, as before
    if (!(await hit(`ai.trust.listing:${listingId}`, DAILY_REVIEWS_PER_LISTING, 86_400)).ok) return;
    if (userId && !(await hit(`ai.trust.lister:${userId}`, DAILY_REVIEWS_PER_LISTER, 86_400)).ok) return;
    // System job (no owner): only admins can see it. Deduped so a listing is never reviewed twice at once.
    await enqueue(TRUST_JOB, { listingId, trigger: 'submitted' }, { userId: null, subject: jobSubject(ref), dedupe: true });
  });

  const readLimit = (req: Parameters<typeof enforce>[0]) => enforce(req, 'ai.trust.read', 240, 60, 'user');

  /** The latest AI review of a listing (any status), any check still running, and whether the last check failed. */
  app.get('/api/ai/trust/listings/:ref', async (req) => {
    requireAdmin(req);
    await readLimit(req);
    const { ref } = parse(RefParams, req.params);
    const l = await one<{ id: string; ref: string }>('SELECT id, ref FROM listings WHERE ref = $1', [ref]);
    if (!l) throw notFound('That listing');
    const [review, job] = await Promise.all([latestReview(l.id), activeJob(l.ref)]);
    const lastCheckFailed = job ? null : await lastFailedCheck(l.ref, review ? new Date(review.createdAt) : null);
    return { ref: l.ref, review, checking: job ? { jobId: job.id, status: job.status } : null, lastCheckFailed, aiEnabled: aiAvailable() };
  });

  /** Re-run the check now (e.g. after the lister fixed something). Returns the job to poll. */
  app.post('/api/ai/trust/listings/:ref/review', async (req, reply) => {
    const admin = requireAdmin(req);
    await aiGuard(req, 'trust.review', { auth: true, perMinute: 10, perHour: 120 });
    const { ref } = parse(RefParams, req.params);
    const l = await one<{ id: string; ref: string }>('SELECT id, ref FROM listings WHERE ref = $1', [ref]);
    if (!l) throw notFound('That listing');
    const job = await enqueue(TRUST_JOB, { listingId: l.id, trigger: 'admin' }, { userId: admin.id, subject: jobSubject(l.ref), dedupe: true });
    await audit(req, 'ai.trust_recheck', `listing:${l.ref}`);
    return reply.code(202).send({ job: jobDTO(job) });
  });

  /** The review queue: pending listings with their latest AI review, riskiest first. */
  app.get('/api/ai/trust/pending', async (req) => {
    requireAdmin(req);
    await readLimit(req);
    const [items, recent] = await Promise.all([pendingQueue(), recentAutoApproved()]);
    return {
      items,
      aiEnabled: aiAvailable(),
      autoApprove: { enabled: autoApproveEnabled(), maxScore: AUTO_APPROVE_MAX_SCORE },
      recentAutoApproved: recent.map((r) => ({ ...r, approvedAt: new Date(r.approvedAt).toISOString() })),
    };
  });
}
