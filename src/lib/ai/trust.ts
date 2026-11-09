/**
 * Website client for AI trust & safety (admin review queue) and the AI operations overview.
 * Everything here is optional: the admin pages work without it (static preview, AI switched off,
 * or a failed call), the queue simply isn't sorted or annotated by AI.
 */
import { aiGet, aiPost, pollJob, type AiJob } from './core';

export type TrustRisk = 'low' | 'medium' | 'high';
export type TrustFlagType = 'scam' | 'misleading' | 'discrimination' | 'material-info' | 'photos' | 'contact-details' | 'duplicate' | 'other';
export interface TrustFlag { type: TrustFlagType; severity: TrustRisk; detail: string; evidence: string; source: 'rules' | 'ai' }
export interface TrustPriceCheck {
  checked: boolean; reason?: 'commercial' | 'no-evidence'; channel?: 'sale' | 'rent';
  typicalLow?: number; typicalHigh?: number; belowPct?: number; abovePct?: number; farBelow?: boolean; wellAbove?: boolean; scope?: string; comparables?: number;
}
export interface TrustReview {
  id: string; risk: TrustRisk; score: number; flags: TrustFlag[]; summary: string; suggestedReason: string | null;
  autoApproved: boolean; model: string | null; triggeredBy: 'submitted' | 'admin'; createdAt: string; stale: boolean;
  /** The AI review couldn't run: this is Streetkey's automatic rules only (with the reason, when known). */
  rulesOnly: boolean; aiProblem: string | null;
  checks: {
    textModeration: 'passed' | 'flagged' | 'skipped'; photosChecked: number; photosFlagged: number; photosSkipped: number; photoTotal: number;
    price: TrustPriceCheck | null; duplicates: number; contactDetails: number; paymentRequests: number;
  };
}
/** The latest check failed after the latest stored review (so the admin can try again). */
export interface TrustFailedCheck { error: string; at: string }
export interface TrustQueueItem {
  ref: string; title: string | null; updatedAt: string; review: TrustReview | null; checking: { jobId: string; status: string } | null;
  lastCheckFailed: TrustFailedCheck | null;
}
export interface TrustQueue {
  items: TrustQueueItem[]; aiEnabled: boolean; autoApprove: { enabled: boolean; maxScore: number };
  recentAutoApproved: { ref: string; title: string | null; score: number; approvedAt: string; status: string }[];
}
export interface AiOverview {
  enabled: boolean; models: Record<string, string> | null;
  last24h: { calls: number; tokens: number; images: number; failures: number } | null;
  byPurpose: { purpose: string; calls: number; tokens: number }[];
  dailyTokenBudget: number; jobsMode: string;
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
  /** Runs the check again now and returns the new review. */
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

/**
 * Riskiest first (then highest score), matching the server's queue order: high, medium, then listings the AI hasn't
 * reviewed (unknown is not the same as safe), then AI-rated low risk. Ties keep their original order.
 */
export function sortByRisk<T extends { ref: string }>(items: T[], reviewOf: (ref: string) => TrustReview | null | undefined): T[] {
  return items.map((item, i) => ({ item, i, r: reviewOf(item.ref) }))
    .sort((a, b) => rankOf(a.r) - rankOf(b.r) || (b.r?.score ?? -1) - (a.r?.score ?? -1) || a.i - b.i)
    .map((x) => x.item);
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
/** Plain-English list of what the check covered, e.g. "text moderation passed · 3 of 3 photos checked · price compared with the area". */
export function coverage(c: TrustReview['checks']): string[] {
  const out: string[] = [];
  out.push(c.textModeration === 'skipped' ? 'no text to moderate' : c.textModeration === 'flagged' ? 'text flagged by moderation' : 'text moderation passed');
  if (c.photoTotal) out.push(`${c.photosChecked} of ${c.photoTotal} photo${c.photoTotal === 1 ? '' : 's'} checked${c.photosFlagged ? ` (${c.photosFlagged} flagged)` : ''}`);
  else out.push('no photos');
  if (c.price?.checked) {
    const unit = c.price.channel === 'rent' ? ' pcm' : '';
    const range = c.price.typicalLow === c.price.typicalHigh ? gbp(c.price.typicalLow ?? 0) : `${gbp(c.price.typicalLow ?? 0)}–${gbp(c.price.typicalHigh ?? 0)}`;
    out.push(`price compared with ${c.price.scope ?? 'the area'} (typical ${range}${unit})`);
  } else out.push(c.price?.reason === 'commercial' ? 'price not compared (commercial)' : 'no area price evidence');
  out.push(c.duplicates ? `${c.duplicates} similar description${c.duplicates === 1 ? '' : 's'} found` : 'no duplicated text');
  if (c.contactDetails) out.push(`${c.contactDetails} contact detail${c.contactDetails === 1 ? '' : 's'} found`);
  if (c.paymentRequests) out.push(`${c.paymentRequests} payment request${c.paymentRequests === 1 ? '' : 's'} found`);
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
  property: 'Property insights', design: 'Design studio', studio: 'Design studio', briefing: 'Briefings',
};
/** "trust.review" → { feature: "Listing checks", task: "review" } (unknown features show their code). */
export function purposeLabel(p: string) {
  const [head, ...rest] = p.split('.');
  return { feature: FEATURE_LABEL[head] ?? head, task: rest.join(' ').replace(/[_-]+/g, ' ') };
}
