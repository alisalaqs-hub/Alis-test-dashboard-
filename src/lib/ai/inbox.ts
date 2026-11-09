/**
 * Website side of the AI inbox and listing insights.
 * Everything here has a rule-based fallback (ruleInsights) so the pages keep working when AI is
 * switched off, the site is a static preview, or a request fails.
 */
import { apiCall, type MyListing } from '../api';
import { areaEvidence, POSTCODE_RE } from '../../engine/listings';
import { aiGet, aiPost } from './core';

/* ───────── shapes (mirror server/src/ai/inbox) ───────── */
export interface TriageChip { label: string; tone: 'good' | 'info' | 'urgent' }
export interface BuyerPosition { chainFree: boolean | null; mortgageInPrinciple: boolean | null; cash: boolean | null; firstTimeBuyer: boolean | null; hasPropertyToSell: boolean | null; moveTimescale: string | null }
export interface Triage {
  intent: 'book_viewing' | 'ask_question' | 'make_offer' | 'check_availability' | 'rental_application' | 'other';
  position: BuyerPosition; questions: string[]; urgency: 'this_week' | 'this_month' | 'flexible' | 'unknown';
  summary: string; sentiment: 'positive' | 'neutral' | 'negative'; chips: TriageChip[]; model: string | null; updatedAt: string;
}
export interface TriageResponse { status: 'ready' | 'pending' | 'unavailable' | 'filtered'; triage: Triage | null; filtered: boolean; filterReason: string | null; aiAvailable: boolean }

export type ReplyIntent = 'answer' | 'confirm_viewing' | 'offer_times' | 'decline' | 'request_info';
export type ReplyTone = 'friendly' | 'formal' | 'brief';
export interface SuggestedReply { reply: string; placeholders: string[]; warnings: string[] }

export interface Improvement { action: string; why: string; impact: 'high' | 'medium' | 'low' }
export interface PriceEvidence { low: number; high: number; position: 'below' | 'within' | 'above'; diffPct: number; scope: string; comparables: number }
export interface InsightStats {
  views30d: number; visitors30d: number; saves: number; enquiries30d: number; enquiriesTotal: number; viewingRequests30d: number;
  photoCount: number; daysOnMarket: number | null; enquiryRatePct: number | null; priceEvidence: PriceEvidence | null;
}
export interface ListingInsights {
  headline: string; whatsWorking: string[]; whatToImprove: Improvement[]; priceNote: string | null;
  stats?: InsightStats; generatedAt?: string; model?: string | null;
}
export interface ListingStats { days: { day: string; views: number; visitors: number }[]; totals: Record<string, number>; saves: number; enquiries: number; note: string }

/* ───────── calls ───────── */
const enc = encodeURIComponent;
export const inboxAi = {
  /** Triage for all the conversations you handle as lister (inbox chips). */
  triageAll: () => aiGet<{ items: Record<string, Triage> }>('/api/ai/inbox'),
  triage: (id: string) => aiGet<TriageResponse>(`/api/ai/inbox/${enc(id)}`),
  suggestReply: (id: string, b: { intent: ReplyIntent; tone: ReplyTone; notes?: string }) => aiPost<SuggestedReply>(`/api/ai/inbox/${enc(id)}/suggest-reply`, b, 45_000),
  /** "Not spam": not an AI call, so it works even when AI is switched off. */
  unfilter: (id: string) => apiCall<{ ok: true; filtered: false; emailed: number }>('POST', `/api/ai/inbox/${enc(id)}/unfilter`, {}),
  insights: (ref: string) => aiGet<ListingInsights>(`/api/ai/listings/${enc(ref)}/insights`, 60_000),
  /** Daily views for the last 30 days (core listing stats, consented analytics only). */
  stats: (ref: string) => apiCall<ListingStats>('GET', `/api/me/listings/${enc(ref)}/stats`),
};

export const REPLY_INTENTS: { value: ReplyIntent; label: string }[] = [
  { value: 'answer', label: 'Answer questions' },
  { value: 'confirm_viewing', label: 'Confirm viewing' },
  { value: 'offer_times', label: 'Offer times' },
  { value: 'request_info', label: 'Ask about position' },
  { value: 'decline', label: 'Decline politely' },
];
export const REPLY_TONES: { value: ReplyTone; label: string }[] = [
  { value: 'friendly', label: 'Friendly' }, { value: 'formal', label: 'Formal' }, { value: 'brief', label: 'Brief' },
];
/** A sensible first choice of reply for the kind of enquiry. */
export const defaultIntent = (kind: string, t?: Triage | null): ReplyIntent =>
  t?.questions.length ? 'answer' : kind === 'viewing' || t?.intent === 'book_viewing' ? 'offer_times' : 'answer';

/** Placeholders from a suggestion that are still in the text the lister is about to send. */
export const unfilled = (text: string, placeholders: string[]) => placeholders.filter((p) => text.includes(p));

/* ───────── rule-based insights (no AI) ───────── */
const LIVE = ['live', 'under_offer'];
export const isLive = (status: string) => LIVE.includes(status);
const money = (n: number, rent: boolean) => `£${Math.round(n).toLocaleString('en-GB')}${rent ? ' pcm' : ''}`;

/** The indicative range the listing form shows ("Price guide"), from Streetkey's area evidence. */
export function priceEvidence(l: Pick<MyListing, 'postcode' | 'channel' | 'floorArea' | 'condition' | 'price' | 'type'>): PriceEvidence | null {
  if (l.type === 'commercial' || !POSTCODE_RE.test(l.postcode)) return null;
  const ev = areaEvidence(l.postcode);
  if (!ev) return null;
  const condAdj = ({ good: 0.97, fair: 0.9, poor: 0.8, derelict: 0.68 } as Record<string, number>)[l.condition ?? 'fair'] ?? 0.9;
  const [low, high] = l.channel === 'rent'
    ? [Math.round((ev.rentPerM2 * l.floorArea * 0.92) / 25) * 25, Math.round((ev.rentPerM2 * l.floorArea * 1.08) / 25) * 25]
    : [Math.round((ev.refurbishedPerM2 * l.floorArea * condAdj * 0.92) / 1000) * 1000, Math.round((ev.refurbishedPerM2 * l.floorArea * condAdj * 1.08) / 1000) * 1000];
  if (!(low > 0 && high > low)) return null;
  const mid = (low + high) / 2;
  return { low, high, position: l.price > high ? 'above' : l.price < low ? 'below' : 'within', diffPct: Math.round(((l.price - mid) / mid) * 1000) / 10, scope: ev.scope, comparables: ev.n };
}

/** Streetkey's built-in reading of a listing's figures: used when AI isn't available. */
export function ruleInsights(l: MyListing): ListingInsights {
  const rent = l.channel === 'rent';
  const photos = l.photos.length;
  const words = (l.description ?? '').trim().split(/\s+/).filter(Boolean).length;
  const missing = l.checks.filter((c) => !c.ok && c.id !== 'photos' && c.id !== 'photo-min');
  const ev = priceEvidence(l);
  const { views30d: views, saves, enquiries } = l.stats;
  const days = l.publishedAt ? Math.max(0, Math.floor((Date.now() - new Date(l.publishedAt).getTime()) / 86_400_000)) : null;

  const improve: Improvement[] = [];
  if (missing.length) improve.push({ action: 'Add the missing material information', why: missing[0].message, impact: 'high' });
  if (photos < 3) improve.push({ action: 'Add more photos, covering every main room and the outside', why: `The listing has ${photos} photo${photos === 1 ? '' : 's'}. Buyers want to see every main room and the outside before they enquire.`, impact: 'high' });
  else if (photos < 8) improve.push({ action: 'Add a few more photos', why: `The listing has ${photos} photos. Buyers like to see every room before they enquire.`, impact: 'medium' });
  if (words < 80) improve.push({ action: 'Write a fuller description', why: `It has ${words} words. Describe the layout, light, storage, outside space and transport links.`, impact: words < 30 ? 'high' : 'medium' });
  if (ev?.position === 'above') improve.push({ action: 'Compare your price with similar homes nearby', why: `It is above the indicative ${money(ev.low, rent)}–${money(ev.high, rent)} range from ${ev.scope} evidence.`, impact: 'high' });
  if (views >= 50 && enquiries === 0) improve.push({ action: 'Look at why viewers aren’t enquiring', why: `${views} views in 30 days but no enquiries yet: the price, photos or missing details may be putting people off.`, impact: 'high' });
  if (views < 20 && (days ?? 0) >= 14) improve.push({ action: 'Share the listing link', why: `${views} views in the last 30 days. Sharing it on social media and with local groups helps.`, impact: 'medium' });
  if (l.features.length < 4) improve.push({ action: 'List more key features', why: 'Buyers filter by features such as parking, a garden or a new kitchen.', impact: 'low' });

  const working: string[] = [];
  if (saves >= 3) working.push(`${saves} people have saved it.`);
  if (enquiries > 0) working.push(`${enquiries} enquir${enquiries === 1 ? 'y' : 'ies'} so far.`);
  if (photos >= 8) working.push(`A good set of ${photos} photos.`);
  if (words >= 150) working.push('A detailed description.');
  if (!missing.length) working.push('All the required material information is there.');
  if (ev?.position === 'within') working.push('The price sits within the indicative range for similar homes.');

  const headline = missing.length ? 'Some required details are missing, which can hold buyers back.'
    : views >= 50 && enquiries === 0 ? 'Plenty of people are looking, but nobody has enquired yet.'
    : enquiries > 0 ? `${enquiries} enquir${enquiries === 1 ? 'y' : 'ies'} so far.`
    : views === 0 ? 'No tracked views yet in the last 30 days.' : `${views} views in the last 30 days.`;
  const priceNote = ev ? `Your ${rent ? 'rent' : 'asking price'} of ${money(l.price, rent)} is ${ev.position} the indicative ${money(ev.low, rent)}–${money(ev.high, rent)} range from ${ev.scope} evidence (${ev.comparables} comparable${ev.comparables === 1 ? '' : 's'}). This is a guide from Streetkey’s demo evidence, not a valuation.` : null;
  return { headline, whatsWorking: working.slice(0, 4), whatToImprove: improve.slice(0, 5), priceNote };
}
