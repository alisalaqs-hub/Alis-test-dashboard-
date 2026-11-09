/**
 * AI trust & safety for listings: every submitted listing gets an automated check (moderation,
 * code-computed scam and material-information signals, then an AI review) that admins see in
 * the review queue, riskiest first. Edits to a submitted or live private listing (text or photos)
 * are checked again, and a risky edit takes a live listing off the site until a person has looked (an admin's own
 * edits aren't: the admin is that person).
 * Optional auto-approval for clearly low-risk listings (AI_AUTO_APPROVE_LOW_RISK); AI never rejects a listing.
 * With AI switched off or paused (or a listing's daily AI checks used up), Streetkey's automatic
 * rules still run and their findings are stored; a live listing edited past its daily AI checks waits for a
 * person. Admin endpoints only.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { one } from '../db';
import { aiAvailable, aiOffReason, refreshAiState } from '../ai/core';
import { aiGuard } from '../ai/guard';
import { on } from '../ai/hooks';
import { enqueue, jobDTO, registerJob } from '../ai/jobs';
import { holdIfRulesFlag, reviewListing } from '../ai/trust/review';
import { activeJob, AUTO_APPROVE_MAX_SCORE, autoApproveEnabled, contentHashSql, jobSubject, lastFailedCheck, latestReview, pendingQueue, recentAutoApproved, recentlyEdited, TRUST_JOB } from '../ai/trust/store';
import { audit, notFound, parse, requireAdmin } from '../services/http';
import { enforce } from '../services/ratelimit';

const JobInput = z.object({
  listingId: z.uuid(),
  trigger: z.enum(['submitted', 'admin', 'edited']).default('submitted'),
  /** Set when the review must use Streetkey's rules only (the reason is shown to admins). Jobs queued by older versions only. */
  rulesOnly: z.string().max(300).nullish(),
});
const RefParams = z.object({ ref: z.string().trim().min(3).max(40).regex(/^[a-z0-9-]+$/i, 'That isn’t a listing reference.') });

const JOB_ATTEMPTS = 2;
/**
 * Changes that don't alter what the public reads: location fields follow the postcode (which does), and 'photos' is a
 * reorder or a deletion (no new content). New photos arrive through photosUploaded; alt text edits ('photo_alt') are content.
 */
const NOT_CONTENT = new Set(['status', 'district', 'lat', 'lng', 'updated_at', 'photos']);

/**
 * Queue a review. The listing's and lister's daily AI limits are charged by the job itself, only when it is about to
 * use AI, so edits that change nothing the review reads (reordering photos, saving the same values) cost nothing.
 */
async function queueReview(listingId: string, ref: string, trigger: 'submitted' | 'edited', listerId: string | null) {
  const subject = jobSubject(ref);
  const actor = listerId ? `u:${listerId}` : null;
  if (trigger === 'edited') {
    // A check of this kind that hasn't started yet will read the latest version anyway. One that is already
    // running may have read the version before this edit, so a new one is queued behind it.
    const waiting = await one<{ id: string }>(
      `SELECT id FROM ai_jobs WHERE kind = $1 AND subject = $2 AND status = 'queued' AND input->>'trigger' = 'edited' LIMIT 1`, [TRUST_JOB, subject]);
    if (waiting) return;
    // Nothing the review reads has changed since the last check (photos reordered, the same values saved again),
    // and no check is part-way through an older version: there is nothing new to check.
    const unchanged = await one<{ ok: number }>(
      `SELECT 1 AS ok FROM listings l
         JOIN LATERAL (SELECT content_hash FROM listing_ai_reviews r WHERE r.listing_id = l.id ORDER BY r.created_at DESC LIMIT 1) r ON true
        WHERE l.id = $1 AND r.content_hash = ${contentHashSql('l')}
          AND NOT EXISTS (SELECT 1 FROM ai_jobs j WHERE j.kind = $2 AND j.subject = $3 AND j.status = 'running')`, [listingId, TRUST_JOB, subject]);
    if (unchanged) return;
    await enqueue(TRUST_JOB, { listingId, trigger }, { userId: null, subject, actor });
    return;
  }
  // System job (no owner): only admins can see it. Deduped so a listing is never reviewed twice at once.
  await enqueue(TRUST_JOB, { listingId, trigger }, { userId: null, subject, dedupe: true, actor });
}

/**
 * The lister changed a submitted or live private listing (text, price, address or photos). A live listing is
 * checked against Streetkey's code-only rules straight away (a clear problem takes it off the site at once), then
 * fully reviewed again in the background; anything above low risk puts it back in the review queue.
 * An admin's own edit is neither held nor re-checked automatically: the admin is the person a hold waits for. Its
 * stored review then shows as changed since the check (the admin queue lists it), and "Re-check with AI" runs one.
 */
async function onEdited(listingId: string, ref: string, editorId?: string | null) {
  if (!config.moderateOwnerListings) return; // listings aren't moderated on this site
  const l = await one<{ status: string; owner_user_id: string | null; verified_org: boolean; by_admin: boolean }>(
    `SELECT l.status, l.owner_user_id, coalesce(o.verified, false) AS verified_org,
            EXISTS (SELECT 1 FROM users u WHERE u.id = $2::uuid AND u.role = 'admin') AS by_admin
       FROM listings l LEFT JOIN organisations o ON o.id = l.organisation_id WHERE l.id = $1`, [listingId, editorId ?? null]);
  // Drafts are checked when submitted; verified agencies keep their own verification.
  if (!l || l.verified_org || !['pending', 'live', 'under_offer'].includes(l.status) || l.by_admin) return;
  if (l.status !== 'pending') await holdIfRulesFlag(listingId);
  await queueReview(listingId, ref, 'edited', l.owner_user_id);
}

export async function aiTrustRoutes(app: FastifyInstance) {
  registerJob(TRUST_JOB, async (job, ctx) => {
    const input = JobInput.parse(job.input);
    await refreshAiState().catch(() => {});
    // On the last attempt an AI fault falls back to a rules-only review instead of failing (job.attempts counts this one).
    // Automatic reviews count towards the daily AI limits once per job (on its first attempt, not again on a retry).
    return reviewListing(input.listingId, {
      trigger: input.trigger, userId: job.user_id, progress: ctx.progress, finalAttempt: job.attempts >= JOB_ATTEMPTS, rulesOnly: input.rulesOnly ?? null,
      dailyLimits: input.trigger !== 'admin' && job.attempts <= 1,
    });
  }, { maxAttempts: JOB_ATTEMPTS, leaseSec: 900 });

  // Every submitted listing is checked: with AI when it's on, and with Streetkey's automatic rules when it isn't.
  on('listingSubmitted', async ({ listingId, ref, userId }) => { await queueReview(listingId, ref, 'submitted', userId); });
  on('listingUpdated', async ({ listingId, ref, fields, userId }) => { if (fields.some((f) => !NOT_CONTENT.has(f))) await onEdited(listingId, ref, userId); });
  on('photosUploaded', async ({ listingId, ref, userId }) => { await onEdited(listingId, ref, userId); });

  const readLimit = (req: Parameters<typeof enforce>[0]) => enforce(req, 'ai.trust.read', 240, 60, 'user');

  /** The latest AI review of a listing (any status), any check still running, and whether the last check failed. */
  app.get('/api/ai/trust/listings/:ref', async (req) => {
    requireAdmin(req);
    await readLimit(req);
    const { ref } = parse(RefParams, req.params);
    const l = await one<{ id: string; ref: string }>('SELECT id, ref FROM listings WHERE ref = $1', [ref]);
    if (!l) throw notFound('That listing');
    await refreshAiState().catch(() => {});
    const [review, job] = await Promise.all([latestReview(l.id), activeJob(l.ref)]);
    const lastCheckFailed = job ? null : await lastFailedCheck(l.ref, review ? new Date(review.createdAt) : null);
    return { ref: l.ref, review, checking: job ? { jobId: job.id, status: job.status } : null, lastCheckFailed, aiEnabled: aiAvailable(), aiReason: aiOffReason() };
  });

  /**
   * Re-run the check now (e.g. after the lister fixed something). Returns the job to poll. With AI switched off or
   * paused, Streetkey's automatic rules are re-run instead (no AI cost).
   */
  app.post('/api/ai/trust/listings/:ref/review', async (req, reply) => {
    const admin = requireAdmin(req);
    await refreshAiState().catch(() => {});
    if (aiAvailable()) await aiGuard(req, 'trust.review', { auth: true, perMinute: 10, perHour: 120 });
    else await enforce(req, 'ai.trust.rules', 20, 60, 'user', 'You’re re-checking listings a bit fast. Please wait a moment and try again.');
    const { ref } = parse(RefParams, req.params);
    const l = await one<{ id: string; ref: string }>('SELECT id, ref FROM listings WHERE ref = $1', [ref]);
    if (!l) throw notFound('That listing');
    const job = await enqueue(TRUST_JOB, { listingId: l.id, trigger: 'admin' }, { userId: admin.id, subject: jobSubject(l.ref), dedupe: true });
    await audit(req, 'ai.trust_recheck', `listing:${l.ref}`, { ai: aiAvailable() });
    return reply.code(202).send({ job: jobDTO(job), aiEnabled: aiAvailable() });
  });

  /** The review queue: pending listings with their latest review, riskiest first, and live listings changed after approval. */
  app.get('/api/ai/trust/pending', async (req) => {
    requireAdmin(req);
    await readLimit(req);
    await refreshAiState().catch(() => {});
    const [items, recent, edited] = await Promise.all([pendingQueue(), recentAutoApproved(), recentlyEdited()]);
    return {
      items,
      aiEnabled: aiAvailable(),
      aiReason: aiOffReason(),
      autoApprove: { enabled: autoApproveEnabled(), maxScore: AUTO_APPROVE_MAX_SCORE },
      recentAutoApproved: recent.map((r) => ({ ...r, approvedAt: new Date(r.approvedAt).toISOString() })),
      recentlyEdited: edited,
    };
  });
}
