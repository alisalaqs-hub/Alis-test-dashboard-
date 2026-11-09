/** Stored AI reviews of listings: database rows → the shape admins see. */
import { one, q } from '../../db';
import type { Flag, PriceSignal, Risk, Signals } from './signals';

export const TRUST_JOB = 'trust.listing_review';
export const jobSubject = (ref: string) => `listing:${ref}`;
/** Auto-approval threshold: only reviews scoring below this (and rated low risk) can publish without a person. */
export const AUTO_APPROVE_MAX_SCORE = 20;
/** AI_AUTO_APPROVE_LOW_RISK=true lets clearly low-risk listings from verified listers publish without waiting. Off by default. */
export const autoApproveEnabled = () => /^(1|true|yes|on)$/i.test((process.env.AI_AUTO_APPROVE_LOW_RISK ?? '').trim());

export interface ReviewRow {
  id: string; listing_id: string; risk: Risk; score: number; flags: Flag[]; signals: Partial<Signals>; summary: string;
  suggested_reason: string | null; auto_approved: boolean; model: string | null; triggered_by: 'submitted' | 'admin';
  listing_updated_at: Date | null; created_at: Date;
}

export interface TrustReviewDTO {
  id: string; risk: Risk; score: number; flags: Flag[]; summary: string; suggestedReason: string | null;
  autoApproved: boolean; model: string | null; triggeredBy: 'submitted' | 'admin'; createdAt: string;
  /** The listing has changed since it was checked. */
  stale: boolean;
  /** The AI review couldn't run: this review is Streetkey's automatic rules only (risk and score come from the rules). */
  rulesOnly: boolean;
  /** Why the AI review couldn't run (a safe, user-facing message), for rules-only reviews. */
  aiProblem: string | null;
  /** What was checked, so admins can see the review's coverage at a glance. */
  checks: {
    textModeration: 'passed' | 'flagged' | 'skipped';
    photosChecked: number; photosFlagged: number; photosSkipped: number; photoTotal: number;
    price: PriceSignal | null;
    duplicates: number; contactDetails: number; paymentRequests: number;
  };
}

export function toReviewDTO(r: ReviewRow, stale = false): TrustReviewDTO {
  const s = r.signals ?? {};
  const photos = s.moderation?.photos ?? [];
  return {
    id: r.id, risk: r.risk, score: r.score, flags: Array.isArray(r.flags) ? r.flags : [], summary: r.summary, suggestedReason: r.suggested_reason,
    autoApproved: r.auto_approved, model: r.model, triggeredBy: r.triggered_by, createdAt: r.created_at.toISOString(), stale,
    rulesOnly: !r.model, aiProblem: !r.model ? (s.aiProblem ?? null) : null,
    checks: {
      textModeration: !s.moderation?.text?.checked ? 'skipped' : s.moderation.text.flagged ? 'flagged' : 'passed',
      photosChecked: photos.filter((p) => p.checked).length, photosFlagged: photos.filter((p) => p.flagged).length,
      photosSkipped: photos.filter((p) => !p.checked).length, photoTotal: s.moderation?.photoTotal ?? photos.length,
      price: s.price ?? null, duplicates: s.duplicates?.length ?? 0, contactDetails: s.contacts?.length ?? 0, paymentRequests: s.payments?.length ?? 0,
    },
  };
}

/** The latest review of one listing, with whether the listing changed since. */
export async function latestReview(listingId: string) {
  const r = await one<ReviewRow & { stale: boolean }>(
    `SELECT r.*, (l.status = 'pending' AND r.listing_updated_at IS NOT NULL AND l.updated_at > r.listing_updated_at) AS stale
       FROM listing_ai_reviews r JOIN listings l ON l.id = r.listing_id
      WHERE r.listing_id = $1 ORDER BY r.created_at DESC LIMIT 1`, [listingId]);
  return r ? toReviewDTO(r, r.stale) : null;
}

/** A review job for this listing that hasn't finished yet, if any. */
export const activeJob = (ref: string) => one<{ id: string; status: string }>(
  `SELECT id, status FROM ai_jobs WHERE kind = $1 AND subject = $2 AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`, [TRUST_JOB, jobSubject(ref)]);

/** The latest check of a listing failed after its latest stored review (so admins know to try again). */
export interface FailedCheck { error: string; at: string }
const FAILED_FALLBACK = 'The automatic check couldn’t finish.';
const failedCheck = (status: string | null, error: string | null, finishedAt: Date | string | null, reviewedAt: Date | null): FailedCheck | null =>
  status === 'failed' && finishedAt && (!reviewedAt || new Date(finishedAt) > reviewedAt)
    ? { error: (error ?? FAILED_FALLBACK).slice(0, 200), at: new Date(finishedAt).toISOString() } : null;

/** The latest check job for this listing, if it failed after the given review. */
export async function lastFailedCheck(ref: string, reviewedAt: Date | null) {
  const j = await one<{ status: string; error: string | null; finished_at: Date | null }>(
    `SELECT status, error, finished_at FROM ai_jobs WHERE kind = $1 AND subject = $2 ORDER BY created_at DESC LIMIT 1`, [TRUST_JOB, jobSubject(ref)]);
  return j ? failedCheck(j.status, j.error, j.finished_at, reviewedAt) : null;
}

export interface QueueItem {
  ref: string; title: string | null; updatedAt: string; review: TrustReviewDTO | null; checking: { jobId: string; status: string } | null;
  lastCheckFailed: FailedCheck | null;
}

/**
 * Pending listings, riskiest first, each with its latest review and any check in progress. A listing the AI hasn't
 * reviewed (no review yet, or a rules-only review that found nothing) is unknown rather than safe, so it comes
 * after high and medium risk but before listings the AI rated low.
 */
export async function pendingQueue(): Promise<QueueItem[]> {
  const rows = await q<{
    ref: string; title: string | null; updated_at: Date; review: ReviewRow | null; stale: boolean | null; job_id: string | null; job_status: string | null;
    last_status: string | null; last_error: string | null; last_finished: Date | null;
  }>(
    `SELECT l.ref, l.title, l.updated_at, CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object(
              'id', r.id, 'risk', r.risk, 'score', r.score, 'flags', r.flags, 'signals', r.signals, 'summary', r.summary,
              'suggested_reason', r.suggested_reason, 'auto_approved', r.auto_approved, 'model', r.model, 'triggered_by', r.triggered_by,
              'created_at', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END AS review,
            (r.listing_updated_at IS NOT NULL AND l.updated_at > r.listing_updated_at) AS stale, j.id AS job_id, j.status AS job_status,
            lj.status AS last_status, lj.error AS last_error, lj.finished_at AS last_finished
       FROM listings l
       LEFT JOIN LATERAL (SELECT * FROM listing_ai_reviews x WHERE x.listing_id = l.id ORDER BY x.created_at DESC LIMIT 1) r ON true
       LEFT JOIN LATERAL (SELECT id, status FROM ai_jobs aj WHERE aj.kind = $1 AND aj.subject = 'listing:' || l.ref AND aj.status IN ('queued', 'running') ORDER BY aj.created_at DESC LIMIT 1) j ON true
       LEFT JOIN LATERAL (SELECT status, error, finished_at FROM ai_jobs aj WHERE aj.kind = $1 AND aj.subject = 'listing:' || l.ref ORDER BY aj.created_at DESC LIMIT 1) lj ON true
      WHERE l.status = 'pending'
      ORDER BY CASE WHEN r.risk = 'high' THEN 0 WHEN r.risk = 'medium' THEN 1 WHEN r.risk = 'low' AND r.model IS NOT NULL THEN 3 ELSE 2 END,
               r.score DESC NULLS LAST, l.updated_at ASC
      LIMIT 200`, [TRUST_JOB]);
  return rows.map((x) => {
    const review = x.review ? toReviewDTO({ ...x.review, created_at: new Date(x.review.created_at as unknown as string) }, !!x.stale) : null;
    return {
      ref: x.ref, title: x.title, updatedAt: x.updated_at.toISOString(), review,
      checking: x.job_id ? { jobId: x.job_id, status: x.job_status ?? 'queued' } : null,
      lastCheckFailed: failedCheck(x.last_status, x.last_error, x.last_finished, review ? new Date(review.createdAt) : null),
    };
  });
}

/** Listings published by auto-approval recently (so people keep oversight of what skipped the queue). */
export const recentAutoApproved = (days = 14) => q<{ ref: string; title: string | null; score: number; approvedAt: string; status: string }>(
  `SELECT l.ref, l.title, r.score, r.created_at AS "approvedAt", l.status
     FROM listing_ai_reviews r JOIN listings l ON l.id = r.listing_id
    WHERE r.auto_approved AND r.created_at > now() - make_interval(days => $1)
    ORDER BY r.created_at DESC LIMIT 20`, [days]);
