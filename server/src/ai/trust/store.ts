/** Stored AI reviews of listings: database rows → the shape admins see. */
import { one, q } from '../../db';
import type { Flag, PriceSignal, Risk, Signals } from './signals';

export const TRUST_JOB = 'trust.listing_review';
export const jobSubject = (ref: string) => `listing:${ref}`;
/** Auto-approval threshold: only reviews scoring below this (and rated low risk) can publish without a person. */
export const AUTO_APPROVE_MAX_SCORE = 20;
/** AI_AUTO_APPROVE_LOW_RISK=true lets clearly low-risk listings from verified listers publish without waiting. Off by default. */
export const autoApproveEnabled = () => /^(1|true|yes|on)$/i.test((process.env.AI_AUTO_APPROVE_LOW_RISK ?? '').trim());

/** What started a review: the lister submitting it, an admin's re-check, or the lister editing a submitted or live listing. */
export type ReviewTrigger = 'submitted' | 'admin' | 'edited';

/**
 * A fingerprint (SQL) of everything the review reads and the public sees: text, price, address, material information
 * and the photos (with their descriptions). `a` is the listings alias. A review stores the fingerprint of the version
 * it checked, so "changed since it was checked" means the content changed, not merely that the row was updated
 * (an approval or a status change doesn't make a review stale).
 */
export const contentHashSql = (a: string) => `md5(json_build_array(
    ${a}.channel, ${a}.title, ${a}.description, ${a}.features, ${a}.price, ${a}.price_qualifier, ${a}.address_line, ${a}.town, ${a}.postcode,
    ${a}.property_type, ${a}.tenure, ${a}.lease_years, ${a}.beds, ${a}.baths, ${a}.floor_area, ${a}.era, ${a}.condition, ${a}.epc, ${a}.council_tax,
    ${a}.service_charge_annual, ${a}.ground_rent_annual, ${a}.material_info, ${a}.ownership_declared,
    (SELECT coalesce(json_agg(json_build_array(p.id, p.alt) ORDER BY p.id), '[]'::json) FROM listing_photos p WHERE p.listing_id = ${a}.id))::text)`;
/** SQL: the review `r` no longer matches listing `l` (older reviews without a fingerprint fall back to the update time, pending listings only). */
const staleSql = `CASE WHEN r.content_hash IS NOT NULL THEN r.content_hash <> ${contentHashSql('l')}
    ELSE (l.status = 'pending' AND r.listing_updated_at IS NOT NULL AND l.updated_at > r.listing_updated_at) END`;
/** SQL: how many high or medium concerns the automatic rules (not the AI) found, with quoted evidence or a named signal. */
const ruleConcernsSql = (flags: string) => `(SELECT count(*)::int FROM jsonb_array_elements(coalesce(${flags}, '[]'::jsonb)) f WHERE f->>'source' = 'rules' AND f->>'severity' IN ('high', 'medium'))`;

export interface ReviewRow {
  id: string; listing_id: string; risk: Risk; score: number; flags: Flag[]; signals: Partial<Signals>; summary: string;
  suggested_reason: string | null; auto_approved: boolean; model: string | null; triggered_by: ReviewTrigger;
  listing_updated_at: Date | null; created_at: Date; content_hash?: string | null;
}

export interface TrustReviewDTO {
  id: string; risk: Risk; score: number; flags: Flag[]; summary: string; suggestedReason: string | null;
  autoApproved: boolean; model: string | null; triggeredBy: ReviewTrigger; createdAt: string;
  /** The listing has changed since it was checked. */
  stale: boolean;
  /** The AI review couldn't run: this review is Streetkey's automatic rules only (risk and score come from the rules). */
  rulesOnly: boolean;
  /** Why the AI review couldn't run (a safe, user-facing message), for rules-only reviews. */
  aiProblem: string | null;
  /** High and medium concerns found by Streetkey's rules (with evidence), as opposed to the AI's own judgement. */
  ruleConcerns: number;
  /** What was checked, so admins can see the review's coverage at a glance. */
  checks: {
    /** not_run: there was text, but moderation couldn't run (AI off or failing). skipped: there was no text. */
    textModeration: 'passed' | 'flagged' | 'skipped' | 'not_run';
    photosChecked: number; photosFlagged: number; photosSkipped: number; photoTotal: number;
    price: PriceSignal | null;
    duplicates: number; contactDetails: number; paymentRequests: number; scamWording: number; reviewerInstructions: number;
    /** Which parts of the listing were read (empty for reviews stored before this was recorded). */
    scanned: string[];
  };
}

export function toReviewDTO(r: ReviewRow, stale = false): TrustReviewDTO {
  const s = r.signals ?? {};
  const photos = s.moderation?.photos ?? [];
  const flags = Array.isArray(r.flags) ? r.flags : [];
  const text = s.moderation?.text;
  return {
    id: r.id, risk: r.risk, score: r.score, flags, summary: r.summary, suggestedReason: r.suggested_reason,
    autoApproved: r.auto_approved, model: r.model, triggeredBy: r.triggered_by, createdAt: r.created_at.toISOString(), stale,
    rulesOnly: !r.model, aiProblem: !r.model ? (s.aiProblem ?? null) : null,
    ruleConcerns: flags.filter((f) => f.source === 'rules' && f.severity !== 'low').length,
    checks: {
      textModeration: text?.checked ? (text.flagged ? 'flagged' : 'passed') : text?.hadText ? 'not_run' : 'skipped',
      photosChecked: photos.filter((p) => p.checked).length, photosFlagged: photos.filter((p) => p.flagged).length,
      photosSkipped: photos.filter((p) => !p.checked).length, photoTotal: s.moderation?.photoTotal ?? photos.length,
      price: s.price ?? null, duplicates: s.duplicates?.length ?? 0, contactDetails: s.contacts?.length ?? 0, paymentRequests: s.payments?.length ?? 0,
      scamWording: s.scamPhrases?.length ?? 0, reviewerInstructions: s.reviewerInstructions?.length ?? 0, scanned: Array.isArray(s.scanned) ? s.scanned : [],
    },
  };
}

/** The latest review of one listing, with whether the listing changed since. */
export async function latestReview(listingId: string) {
  const r = await one<ReviewRow & { stale: boolean }>(
    `SELECT r.*, ${staleSql} AS stale
       FROM listing_ai_reviews r JOIN listings l ON l.id = r.listing_id
      WHERE r.listing_id = $1 ORDER BY r.created_at DESC LIMIT 1`, [listingId]);
  return r ? toReviewDTO(r, !!r.stale) : null;
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
  /** An edit after approval took this listing off the site, and no admin has decided on it since. */
  held: boolean;
  /** What held it: Streetkey's immediate rules check, the full review, or more edits today than the AI checks cover. */
  heldBy: 'rules' | 'review' | 'limit' | null;
}

/** Audit actions that record an admin's (or auto-approval's) decision on a listing. */
const APPROVALS = `('admin.listing_approved', 'ai.auto_approved')`;
const DECISIONS = `('admin.listing_approved', 'ai.auto_approved', 'admin.listing_rejected')`;
/** SQL: the latest audit row of one of `actions` for listing `l`. */
const lastAudit = (actions: string) => `(SELECT max(d.at) FROM audit_log d WHERE d.subject = 'listing:' || l.ref AND d.action IN ${actions})`;

const REVIEW_JSON = `CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object(
              'id', r.id, 'risk', r.risk, 'score', r.score, 'flags', r.flags, 'signals', r.signals, 'summary', r.summary,
              'suggested_reason', r.suggested_reason, 'auto_approved', r.auto_approved, 'model', r.model, 'triggered_by', r.triggered_by,
              'created_at', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END`;
const fromJson = (x: ReviewRow | null, stale: boolean | null) => (x ? toReviewDTO({ ...x, created_at: new Date(x.created_at as unknown as string) }, !!stale) : null);

/**
 * Pending listings, riskiest first, each with its latest review and any check in progress. A listing the AI hasn't
 * reviewed (no review yet, or a rules-only review that found nothing) is unknown rather than safe, so it comes
 * after high and medium risk but before listings the AI rated low. Within a risk band, listings with more concerns
 * found by Streetkey's rules (quoted evidence, not just the AI's opinion) come first, then the higher score.
 */
export async function pendingQueue(): Promise<QueueItem[]> {
  const rows = await q<{
    ref: string; title: string | null; updated_at: Date; review: ReviewRow | null; stale: boolean | null; job_id: string | null; job_status: string | null;
    last_status: string | null; last_error: string | null; last_finished: Date | null; held_by: string | null;
  }>(
    `SELECT l.ref, l.title, l.updated_at, ${REVIEW_JSON} AS review,
            CASE WHEN r.id IS NULL THEN false ELSE ${staleSql} END AS stale, j.id AS job_id, j.status AS job_status,
            lj.status AS last_status, lj.error AS last_error, lj.finished_at AS last_finished, h.held_by
       FROM listings l
       LEFT JOIN LATERAL (SELECT * FROM listing_ai_reviews x WHERE x.listing_id = l.id ORDER BY x.created_at DESC LIMIT 1) r ON true
       LEFT JOIN LATERAL (SELECT id, status FROM ai_jobs aj WHERE aj.kind = $1 AND aj.subject = 'listing:' || l.ref AND aj.status IN ('queued', 'running') ORDER BY aj.created_at DESC LIMIT 1) j ON true
       LEFT JOIN LATERAL (SELECT status, error, finished_at FROM ai_jobs aj WHERE aj.kind = $1 AND aj.subject = 'listing:' || l.ref ORDER BY aj.created_at DESC LIMIT 1) lj ON true
       -- Taken off the site after an edit, with no admin decision since (the latest hold, if any).
       LEFT JOIN LATERAL (SELECT coalesce(a.detail->>'by', 'review') AS held_by FROM audit_log a
                           WHERE a.subject = 'listing:' || l.ref AND a.action = 'trust.listing_held' AND a.at > coalesce(${lastAudit(DECISIONS)}, '-infinity'::timestamptz)
                           ORDER BY a.at DESC LIMIT 1) h ON true
      WHERE l.status = 'pending'
      ORDER BY CASE WHEN r.risk = 'high' THEN 0 WHEN r.risk = 'medium' THEN 1 WHEN r.risk = 'low' AND r.model IS NOT NULL THEN 3 ELSE 2 END,
               ${ruleConcernsSql('r.flags')} DESC, r.score DESC NULLS LAST, l.updated_at ASC
      LIMIT 200`, [TRUST_JOB]);
  return rows.map((x) => {
    const review = fromJson(x.review, x.stale);
    return {
      ref: x.ref, title: x.title, updatedAt: x.updated_at.toISOString(), review,
      checking: x.job_id ? { jobId: x.job_id, status: x.job_status ?? 'queued' } : null,
      lastCheckFailed: failedCheck(x.last_status, x.last_error, x.last_finished, review ? new Date(review.createdAt) : null),
      held: !!x.held_by,
      heldBy: x.held_by === 'rules' || x.held_by === 'limit' ? x.held_by : x.held_by ? 'review' : null,
    };
  });
}

/** Listings published by auto-approval recently (so people keep oversight of what skipped the queue). */
export const recentAutoApproved = (days = 14) => q<{ ref: string; title: string | null; score: number; approvedAt: string; status: string }>(
  `SELECT l.ref, l.title, r.score, r.created_at AS "approvedAt", l.status
     FROM listing_ai_reviews r JOIN listings l ON l.id = r.listing_id
    WHERE r.auto_approved AND r.created_at > now() - make_interval(days => $1)
    ORDER BY r.created_at DESC LIMIT 20`, [days]);

export interface EditedItem {
  ref: string; title: string | null; status: string;
  /** When the row last changed for any reason (an approval or a status change counts too). */
  updatedAt: string;
  /** When it was last edited after approval (the latest edit's check), or null if unknown. */
  editedAt: string | null;
  review: TrustReviewDTO | null; checking: { jobId: string; status: string } | null;
}
/**
 * Private listings that are on the site now (live or under offer) and were edited after their latest approval in
 * the last few days, or changed since their last check. Risky edits go back to the queue automatically; this list
 * keeps the rest visible, so admins can see what changed after they approved it. A listing that was held after an
 * edit and then approved again drops off until it is edited again.
 */
export async function recentlyEdited(days = 14): Promise<EditedItem[]> {
  const rows = await q<{ ref: string; title: string | null; status: string; updated_at: Date; edited_at: Date | null; review: ReviewRow | null; stale: boolean | null; job_id: string | null; job_status: string | null }>(
    `SELECT l.ref, l.title, l.status, l.updated_at, e.edited_at, ${REVIEW_JSON} AS review, ${staleSql} AS stale, j.id AS job_id, j.status AS job_status
       FROM listings l
       LEFT JOIN organisations o ON o.id = l.organisation_id
       JOIN LATERAL (SELECT * FROM listing_ai_reviews x WHERE x.listing_id = l.id ORDER BY x.created_at DESC LIMIT 1) r ON true
       LEFT JOIN LATERAL (SELECT id, status FROM ai_jobs aj WHERE aj.kind = $2 AND aj.subject = 'listing:' || l.ref AND aj.status IN ('queued', 'running') ORDER BY aj.created_at DESC LIMIT 1) j ON true
       -- The latest edit: when its check was queued (close to the edit itself), or when the check ran.
       CROSS JOIN LATERAL (SELECT coalesce(
           (SELECT max(aj.created_at) FROM ai_jobs aj WHERE aj.kind = $2 AND aj.subject = 'listing:' || l.ref AND aj.input->>'trigger' = 'edited'),
           (SELECT max(x.created_at) FROM listing_ai_reviews x WHERE x.listing_id = l.id AND x.triggered_by = 'edited')) AS edited_at) e
      WHERE l.status IN ('live', 'under_offer') AND NOT coalesce(o.verified, false)
        AND ((e.edited_at > now() - make_interval(days => $1) AND e.edited_at > coalesce(${lastAudit(APPROVALS)}, '-infinity'::timestamptz))
             OR (${staleSql} AND l.updated_at > now() - make_interval(days => $1)))
      ORDER BY coalesce(e.edited_at, l.updated_at) DESC LIMIT 30`, [days, TRUST_JOB]);
  return rows.map((x) => ({
    ref: x.ref, title: x.title, status: x.status, updatedAt: x.updated_at.toISOString(), editedAt: x.edited_at ? new Date(x.edited_at).toISOString() : null,
    review: fromJson(x.review, x.stale), checking: x.job_id ? { jobId: x.job_id, status: x.job_status ?? 'queued' } : null,
  }));
}
