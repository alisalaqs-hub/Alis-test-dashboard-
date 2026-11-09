/**
 * Website client for trust & safety (admin review queue) and the AI operations overview.
 * Everything here is optional: the admin pages work without it (static preview, or a failed call),
 * the queue simply isn't sorted or annotated. With AI switched off or paused the server still runs
 * Streetkey's automatic rules, so reviews then come back marked rulesOnly (never shown as AI).
 */
import { aiGet, aiPost, pollJob, type AiJob } from './core';

export type TrustRisk = 'low' | 'medium' | 'high';
export type TrustFlagType = 'scam' | 'misleading' | 'discrimination' | 'material-info' | 'photos' | 'contact-details' | 'duplicate' | 'other';
export interface TrustFlag { type: TrustFlagType; severity: TrustRisk; detail: string; evidence: string; source: 'rules' | 'ai' }
export interface TrustPriceCheck {
  checked: boolean; reason?: 'commercial' | 'no-evidence'; channel?: 'sale' | 'rent';
  typicalLow?: number; typicalHigh?: number; belowPct?: number; abovePct?: number; farBelow?: boolean; wellAbove?: boolean; scope?: string; comparables?: number;
}
/** What started a check: the lister submitting, an admin's re-check, or the lister editing a submitted or live listing. */
export type TrustTrigger = 'submitted' | 'admin' | 'edited';
export interface TrustReview {
  id: string; risk: TrustRisk; score: number; flags: TrustFlag[]; summary: string; suggestedReason: string | null;
  autoApproved: boolean; model: string | null; triggeredBy: TrustTrigger; createdAt: string; stale: boolean;
  /** The AI review couldn't run: this is Streetkey's automatic rules only (with the reason, when known). */
  rulesOnly: boolean; aiProblem: string | null;
  /** High and medium concerns found by Streetkey's rules (with evidence). Older servers don't send it. */
  ruleConcerns?: number;
  checks: {
    /** not_run: there was text but moderation couldn't run (AI off or failing); skipped: there was no text. */
    textModeration: 'passed' | 'flagged' | 'skipped' | 'not_run'; photosChecked: number; photosFlagged: number; photosSkipped: number; photoTotal: number;
    price: TrustPriceCheck | null; duplicates: number; contactDetails: number; paymentRequests: number;
    scamWording?: number; reviewerInstructions?: number;
    /** Which parts of the listing were read, e.g. ['title', 'description', 'features', 'town', 'street name', 'photo descriptions']. */
    scanned?: string[];
  };
}
/** The latest check failed after the latest stored review (so the admin can try again). */
export interface TrustFailedCheck { error: string; at: string }
export interface TrustQueueItem {
  ref: string; title: string | null; updatedAt: string; review: TrustReview | null; checking: { jobId: string; status: string } | null;
  lastCheckFailed: TrustFailedCheck | null;
  /** An edit after approval took this listing off the site, and no admin has decided on it since (older servers don't send it). */
  held?: boolean;
  /** What held it: the immediate rules check, the full review, or more edits today than the AI checks cover. */
  heldBy?: 'rules' | 'review' | 'limit' | null;
}
/** A private listing that is live now and was edited after its latest approval (risky edits go back to the queue). */
export interface TrustEditedItem {
  ref: string; title: string | null; status: string;
  /** When the listing last changed for any reason (approvals and status changes included). */
  updatedAt: string;
  /** When it was last edited after approval, if known (older servers don't send it). */
  editedAt?: string | null;
  review: TrustReview | null; checking: { jobId: string; status: string } | null;
}
/** Why AI isn't available on the server (null: it is). */
export type ServerAiOff = 'disabled' | 'no_key' | 'paused' | 'budget' | null;
export interface TrustQueue {
  items: TrustQueueItem[]; aiEnabled: boolean; aiReason?: ServerAiOff; autoApprove: { enabled: boolean; maxScore: number };
  recentAutoApproved: { ref: string; title: string | null; score: number; approvedAt: string; status: string }[];
  recentlyEdited?: TrustEditedItem[];
}
export interface AiOverview {
  enabled: boolean; models: Record<string, string> | null;
  last24h: { calls: number; tokens: number; images: number; failures: number } | null;
  byPurpose: { purpose: string; calls: number; tokens: number }[];
  dailyTokenBudget: number; jobsMode: string;
  /** Why AI is off (switched off, no key, paused because the OpenAI account is out of credit, or today's budget used up). */
  reason?: ServerAiOff;
  /** An admin-only explanation of the pause or budget state, with what to do about it. */
  notice?: string | null;
  /** Set while AI is paused (the OpenAI account ran out of credit): when it will try again. */
  pause?: { until: string; reason: string | null } | null;
  /** The heaviest users in the last 24 hours, anonymised (an account or a visitor network). */
  topUsers?: { kind: 'account' | 'visitor'; calls: number; tokens: number | string }[];
  /** Per-person daily token caps (0: no cap). */
  dailyTokensPerUser?: number; dailyTokensPerIp?: number;
}

const enc = encodeURIComponent;
export const trustApi = {
  queue: () => aiGet<TrustQueue>('/api/ai/trust/pending'),
  review: (ref: string) => aiGet<{ ref: string; review: TrustReview | null; checking: TrustQueueItem['checking']; lastCheckFailed: TrustFailedCheck | null; aiEnabled: boolean }>(`/api/ai/trust/listings/${enc(ref)}`),
  /** Waits for a check already in progress (e.g. started when the listing was submitted), then returns the review. */
  waitFor: async (ref: string, jobId: string, o: { signal?: AbortSignal; onProgress?: (job: AiJob) => void } = {}) => {
    await pollJob(jobId, { signal: o.signal, onProgress: o.onProgress });
    return (await trustApi.review(ref)).review;
  },
  /** Runs the check again now (with AI when it's on, otherwise Streetkey's automatic rules) and returns the new review. */
  recheck: async (ref: string, o: { signal?: AbortSignal; onProgress?: (job: AiJob) => void } = {}) => {
    const { job } = await aiPost<{ job: AiJob }>(`/api/ai/trust/listings/${enc(ref)}/review`, {});
    return trustApi.waitFor(ref, job.id, o);
  },
};
export const aiOverview = () => aiGet<AiOverview>('/api/ai/admin/overview');

/* ───────── presentation helpers ───────── */
export const RISK_RANK: Record<TrustRisk, number> = { high: 0, medium: 1, low: 3 };
/** Not reviewed by AI (no review, or a rules-only review that found nothing serious): unknown, so ahead of AI-rated low risk. */
const UNKNOWN_RANK = 2;
const rankOf = (r: TrustReview | null | undefined) => (!r || (r.rulesOnly && r.risk === 'low') ? UNKNOWN_RANK : RISK_RANK[r.risk]);
export const RISK_LABEL: Record<TrustRisk, string> = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' };
export const SEVERITY_LABEL: Record<TrustRisk, string> = { high: 'High', medium: 'Medium', low: 'Low' };
export const FLAG_LABEL: Record<TrustFlagType, string> = {
  scam: 'Possible scam', misleading: 'Possibly misleading', discrimination: 'Discriminatory wording', 'material-info': 'Material information',
  photos: 'Photos', 'contact-details': 'Contact details', duplicate: 'Duplicated text', other: 'Other',
};

/** High and medium concerns from Streetkey's rules (counted from the flags when the server doesn't say). */
export const ruleConcernsOf = (r: TrustReview | null | undefined) =>
  !r ? 0 : r.ruleConcerns ?? r.flags.filter((f) => f.source === 'rules' && f.severity !== 'low').length;

/**
 * Riskiest first, matching the server's queue order: high, medium, then listings the AI hasn't reviewed (unknown is
 * not the same as safe), then AI-rated low risk. Within a band, more concerns backed by Streetkey's rules first,
 * then the higher score. Ties keep their original order.
 */
export function sortByRisk<T extends { ref: string }>(items: T[], reviewOf: (ref: string) => TrustReview | null | undefined): T[] {
  return items.map((item, i) => ({ item, i, r: reviewOf(item.ref) }))
    .sort((a, b) => rankOf(a.r) - rankOf(b.r) || ruleConcernsOf(b.r) - ruleConcernsOf(a.r) || (b.r?.score ?? -1) - (a.r?.score ?? -1) || a.i - b.i)
    .map((x) => x.item);
}

/** The high and medium concerns on a review, most serious first (what an admin should weigh before approving). */
export const seriousFlags = (r: TrustReview | null | undefined) =>
  (r?.flags ?? []).filter((f) => f.severity !== 'low').sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));

/** Whether approving should ask "publish anyway?": the check found something, is out of date, or is still running. */
export function approveNeedsConfirm(r: TrustReview | null | undefined, checking: boolean): boolean {
  return checking || (!!r && (r.risk !== 'low' || r.stale));
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "title, description and town" */
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
/**
 * Plain-English list of what the check covered, e.g. "read the title, description, town and street name · text
 * moderation passed · 3 of 3 photos checked · price compared with the area · no contact details found".
 */
export function coverage(c: TrustReview['checks']): string[] {
  const out: string[] = [];
  if (c.scanned?.length) out.push(`read the ${andList(c.scanned)}`);
  out.push(c.textModeration === 'skipped' ? 'no text to moderate' : c.textModeration === 'not_run' ? 'text moderation didn’t run'
    : c.textModeration === 'flagged' ? 'text flagged by moderation' : 'text moderation passed');
  if (c.photoTotal) out.push(`${c.photosChecked} of ${plural(c.photoTotal, 'photo')} checked${c.photosFlagged ? ` (${c.photosFlagged} flagged)` : ''}`);
  else out.push('no photos');
  if (c.price?.checked) {
    const unit = c.price.channel === 'rent' ? ' pcm' : '';
    const range = c.price.typicalLow === c.price.typicalHigh ? gbp(c.price.typicalLow ?? 0) : `${gbp(c.price.typicalLow ?? 0)}–${gbp(c.price.typicalHigh ?? 0)}`;
    out.push(`price compared with ${c.price.scope ?? 'the area'} (typical ${range}${unit})`);
  } else out.push(c.price?.reason === 'commercial' ? 'price not compared (commercial)' : 'no area price evidence');
  out.push(c.duplicates ? `${plural(c.duplicates, 'similar description')} found` : 'no duplicated text');
  // Say what the rules looked for even when they found nothing, so "nothing found" isn't mistaken for "not checked".
  out.push(c.contactDetails ? `${plural(c.contactDetails, 'contact detail')} found` : 'no contact details found');
  out.push(c.paymentRequests ? `${plural(c.paymentRequests, 'payment request')} found` : 'no payment requests found');
  if (c.scamWording != null) out.push(c.scamWording ? `${plural(c.scamWording, 'scam phrase')} found` : 'no scam wording found');
  if (c.reviewerInstructions) out.push(`${plural(c.reviewerInstructions, 'note')} aimed at the reviewer found`);
  return out;
}

export const ROLE_INFO: Record<string, string> = {
  main: 'Complex reasoning and longer writing (assistant, listing checks)', fast: 'Parsing, classification and short drafts', vision: 'Understanding photos',
  image: 'Room redesign images', embedding: 'Similarity search', moderation: 'Safety checks on text and photos',
};
export const JOBS_MODE_INFO: Record<string, string> = {
  sync: 'Runs before the request returns (tests only)', inline: 'Runs on this server straight after the request', netlify: 'Runs in Netlify Background Functions (up to 15 minutes)',
};
const FEATURE_LABEL: Record<string, string> = {
  trust: 'Listing checks', assistant: 'Assistant', search: 'Search', listing: 'Listing writer', inbox: 'Inbox', import: 'Listing import',
  property: 'Property insights', design: 'Design studio', studio: 'Design studio', briefing: 'Briefings', automation: 'Automations',
};
/** "trust.review" → { feature: "Listing checks", task: "review" } (unknown features show their code). */
export function purposeLabel(p: string) {
  const [head, ...rest] = p.split('.');
  return { feature: FEATURE_LABEL[head] ?? head, task: rest.join(' ').replace(/[_-]+/g, ' ') };
}
