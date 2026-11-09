/**
 * Website client for Streetkey AI listing help (sellers and landlords): descriptions, photo checks,
 * price guide explanations and the pre-submission check. Every call is optional: the listing form
 * keeps working with its built-in template and rules when AI isn't available or a call fails.
 */
import { apiCall } from '../api';
import type { ListingInput } from '../../engine/listings';
import { aiGet, aiPost, type AiJob } from './core';

export type Tone = 'warm' | 'concise' | 'premium' | 'investor';
export const TONES: { value: Tone; label: string }[] = [
  { value: 'warm', label: 'Warm' }, { value: 'concise', label: 'Concise' }, { value: 'premium', label: 'Premium' }, { value: 'investor', label: 'Investor' },
];

export interface ListingFacts {
  channel: 'sale' | 'rent'; type: string; beds: number; baths: number; floorArea: number | null; title: string | null; town: string | null;
  district: string | null; postcode?: string | null; tenure: string | null; leaseYears: number | null; epc: string | null; councilTax: string | null;
  condition: string | null; era: string | null; features: string[]; price: number | null; serviceCharge: number | null; groundRent: number | null;
}

const OUTWARD = /^\s*([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})?\s*$/i;
/** The postcode district only (e.g. E17), which is all the description writer needs. */
export const outward = (postcode: string) => OUTWARD.exec(postcode)?.[1]?.toUpperCase() ?? null;

/** The listing form's fields as facts for the AI. The full postcode is only sent when a check needs it. */
export function factsFrom(f: ListingInput, o: { fullPostcode?: boolean; staged?: boolean } = {}): ListingFacts {
  const lease = f.tenure !== 'freehold';
  return {
    channel: f.listing, type: f.type, beds: f.beds, baths: f.baths, floorArea: f.floorArea > 0 ? f.floorArea : null, title: f.title?.trim() || null,
    town: f.town.trim() || null, district: outward(f.postcode), ...(o.fullPostcode ? { postcode: f.postcode.trim() || null } : {}),
    tenure: f.tenure ?? null, leaseYears: lease ? f.leaseYears ?? null : null, epc: f.epc || null, councilTax: f.councilTax || null,
    condition: f.condition ?? null, era: f.era ?? null,
    features: [...f.features, ...(o.staged ? ['Contains virtually staged images'] : [])].map((x) => x.slice(0, 60)).slice(0, 30),
    price: f.price > 0 ? f.price : null, serviceCharge: lease ? f.serviceChargeAnnual ?? null : null, groundRent: lease ? f.groundRentAnnual ?? null : null,
  };
}

/* ───────── description ───────── */
export interface DescribeResult {
  headline: string; description: string; keyFeatures: string[]; materialInfo: string[]; wordingWarnings: string[]; missingInfo: string[];
  wordCount: number; tone: Tone; label: string;
}
export const describeListing = (facts: ListingFacts, tone: Tone, notes: string, photoInsights: string[]) =>
  aiPost<DescribeResult>('/api/ai/listing/describe', { facts, tone, notes: notes.trim().slice(0, 2000), photoInsights: photoInsights.slice(0, 40) });

/* ───────── photos ───────── */
export type Room = 'front exterior' | 'rear exterior' | 'garden' | 'living room' | 'kitchen' | 'kitchen-diner' | 'dining room' | 'bedroom' | 'bathroom' | 'en-suite'
  | 'shower room' | 'WC' | 'hallway' | 'landing or stairs' | 'study' | 'utility room' | 'conservatory' | 'garage' | 'balcony or terrace' | 'view' | 'floor plan' | 'communal area' | 'other';
export type PhotoIssue = 'dark' | 'blurry' | 'tilted' | 'cluttered' | 'small' | 'overexposed' | 'obstructed';
export type PhotoFlag = 'people' | 'personal-info' | 'number-plate' | 'possible-virtual-staging' | 'not-a-property-photo' | 'watermark';
export interface PhotoAnalysis { room: Room; alt: string; quality: { score: number; issues: PhotoIssue[] }; features: string[]; flags: PhotoFlag[] }

export const ISSUE_LABEL: Record<PhotoIssue, string> = { dark: 'Dark', blurry: 'Blurry', tilted: 'Tilted', cluttered: 'Cluttered', small: 'Small', overexposed: 'Washed out', obstructed: 'Something in the way' };
export const FLAG_LABEL: Record<PhotoFlag, string> = {
  people: 'People visible', 'personal-info': 'Personal information visible', 'number-plate': 'Number plate visible',
  'possible-virtual-staging': 'May be virtually staged', 'not-a-property-photo': 'Not a property photo', watermark: 'Watermark or logo',
};
export const roomLabel = (r: Room) => (r === 'WC' ? 'WC' : r.charAt(0).toUpperCase() + r.slice(1));

export interface PreviewResult { photos: { index: number; name: string | null; analysis: PhotoAnalysis | null }[]; suggestedOrder: number[]; tips: string[]; label: string }
export interface PriorItem { room: Room | null; score: number | null; issues: PhotoIssue[]; flags: PhotoFlag[] }
export const priorOf = (a: PhotoAnalysis | null | undefined): PriorItem => ({ room: a?.room ?? null, score: a?.quality.score ?? null, issues: a?.quality.issues ?? [], flags: a?.flags ?? [] });

/* Consent: photos are only sent to the AI provider once the person has agreed (and they can withdraw at any time). */
export const PHOTO_CONSENT_TEXT = 'I’m happy for my photos to be sent to Streetkey’s AI provider (OpenAI) to be checked. Photos I add to my listings later are checked too, until I untick this box.';
export const getPhotoConsent = () => aiGet<{ consented: boolean }>('/api/ai/listing/photos/consent');
export const savePhotoConsent = (consent: boolean) => apiCall<{ consented: boolean }>('PUT', '/api/ai/listing/photos/consent', { consent });

/**
 * Check up to 6 photos that are still in the browser (only call this once the person has ticked the consent box).
 * `prior` = results for earlier photos, so order and tips cover all of them.
 */
export function previewPhotos(photos: Blob[], prior: PriorItem[] = []) {
  const form = new FormData();
  form.append('consent', 'true');
  if (prior.length) form.append('prior', JSON.stringify(prior.slice(-30)));
  photos.slice(0, 6).forEach((b, i) => form.append('photos', b, `photo-${i + 1}.jpg`));
  return apiCall<PreviewResult>('POST', '/api/ai/listing/photos/preview', form, { timeout: 60_000 });
}

/** What the background photo check did: `limited` = it stopped at today's allowance; `consent: false` = consent was withdrawn. */
export interface PhotoJobOutput { checked: number; skipped: number; failed?: number; limited?: boolean; consent?: false }
export interface ListingPhotosResult {
  photos: { id: string; url: string; alt: string | null; position: number; checked: boolean; analysis: PhotoAnalysis | null }[];
  suggestedOrder: string[]; tips: string[]; pending: boolean; job: AiJob<PhotoJobOutput> | null; consented: boolean; label: string;
}
export const listingPhotos = (ref: string) => aiGet<ListingPhotosResult>(`/api/ai/listing/${encodeURIComponent(ref)}/photos`);
/** (Re)check a live listing's photos (only call this once the person has ticked the consent box). */
export const checkListingPhotos = (ref: string, recheck = false) => aiPost<{ job: AiJob<PhotoJobOutput> | null; note?: string }>(`/api/ai/listing/${encodeURIComponent(ref)}/photos/check`, { recheck, consent: true });
export const setPhotoAlt = (ref: string, id: string, alt: string) => apiCall<{ ok: true }>('PATCH', `/api/listings/${encodeURIComponent(ref)}/photos/${encodeURIComponent(id)}`, { alt: alt.trim().slice(0, 160) });
export const setPhotoOrder = (ref: string, ids: string[]) => apiCall<{ ok: true }>('PUT', `/api/listings/${encodeURIComponent(ref)}/photos/order`, { ids });

/** Short "room: features" lines for the description writer (only what the photo check saw). */
export function photoInsightsFrom(analyses: (PhotoAnalysis | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const a of analyses) {
    if (!a || a.flags.includes('not-a-property-photo')) continue;
    out.push(`${a.room}${a.features.length ? `: ${a.features.join(', ')}` : ''}`.slice(0, 80));
  }
  return [...new Set(out)].slice(0, 40);
}

/** A smaller JPEG copy for the AI check (the AI looks at a low-detail version, so this keeps uploads quick). */
export function shrinkForCheck(src: string, max = 1024): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      const attempt = (q: number) => c.toBlob((b) => {
        if (!b) { reject(new Error('Couldn’t prepare that photo.')); return; }
        if (b.size > 1.4 * 1024 * 1024 && q > 0.45) attempt(q - 0.15); else resolve(b);
      }, 'image/jpeg', q);
      attempt(0.72);
    };
    img.onerror = () => reject(new Error('Couldn’t read that photo.'));
    img.src = src;
  });
}

/**
 * Which of the photos sent to uploadPhotos were stored, in order. The upload names them photo-1.jpg, photo-2.jpg…
 * and reports refusals as "photo-3.jpg: reason", so `added` lines up with the indexes that weren't refused.
 */
export function storedIndexes(total: number, added: number, rejected: string[]): number[] | null {
  const refused = new Set(rejected.map((r) => Number(/^photo-(\d+)\./.exec(r)?.[1]) - 1).filter((n) => n >= 0));
  const kept = Array.from({ length: total }, (_, i) => i).filter((i) => !refused.has(i));
  return kept.length === added ? kept : null;
}

/* ───────── price guide ───────── */
export interface PriceGuideResult {
  low: number | null; high: number | null; position: 'below' | 'within' | 'above' | null; askingVsMidPct?: number | null;
  basis: { n: number; scope: string; perM2: number; method: string; evidence: 'sales' | 'rentals' | 'assumed-yield'; demo: true } | null;
  narrative: { explanation: string; position: string; advice: string[] } | null; note?: string; label?: string;
}
export const priceGuide = (b: { postcode: string; type: string; beds: number; floorArea: number; condition: string; channel: 'sale' | 'rent'; askingPrice?: number | null }) =>
  aiPost<PriceGuideResult>('/api/ai/listing/price-guide', b);

/* ───────── pre-submission check ───────── */
export type Severity = 'block' | 'warn' | 'tip';
export interface PrecheckIssue { severity: Severity; field: string; message: string; source: 'checks' | 'wording' | 'ai'; checkId?: string }
export interface PrecheckResult { ready: boolean; issues: PrecheckIssue[]; aiUsed: boolean; aiNote: string | null }
export const precheckListing = (facts: ListingFacts, description: string, photoCount: number) =>
  aiPost<PrecheckResult>('/api/ai/listing/precheck', { facts, description: description.slice(0, 8000), photoCount });

export const SEVERITY_LABEL: Record<Severity, string> = { block: 'Must fix', warn: 'Check', tip: 'Tip' };
export const FIELD_LABEL: Record<string, string> = {
  title: 'Headline', description: 'Description', price: 'Price', postcode: 'Postcode', tenure: 'Tenure', leaseYears: 'Lease', serviceCharge: 'Service charge',
  groundRent: 'Ground rent', councilTax: 'Council tax', epc: 'EPC', beds: 'Bedrooms', baths: 'Bathrooms', floorArea: 'Floor area', features: 'Features', photos: 'Photos', general: 'General',
};
