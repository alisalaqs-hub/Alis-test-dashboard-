/**
 * Website client for Streetkey AI listing help (sellers and landlords): descriptions, photo checks,
 * price guide explanations and the pre-submission check. Every call is optional: the listing form
 * keeps working with its built-in template and rules when AI isn't available or a call fails.
 */
import { apiCall } from '../api';
import type { CheckPoint, CheckSeverity, ListingInput } from '../../engine/listings';
import { ACCOUNT_CHANGED_EVENT } from '../server';
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
  /** Key features that only repeat a structured field (bedrooms, tenure, EPC…): shown from the facts, so never saved as features. */
  structuredFeatures?: string[];
}
export const describeListing = (facts: ListingFacts, tone: Tone, notes: string, photoInsights: string[]) =>
  aiPost<DescribeResult>('/api/ai/listing/describe', { facts, tone, notes: notes.trim().slice(0, 2000), photoInsights: photoInsights.slice(0, 40) });

/** Key-feature lines worth adding (not ones that repeat a structured fact). Shared with the server tests, so it lives in the engine. */
export { featuresToAdd } from '../../engine/listings';

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

/** token: a signed copy of the result for exactly this file; sent with the upload so the photo isn't checked again. */
export interface PreviewResult { photos: { index: number; name: string | null; analysis: PhotoAnalysis | null; token?: string | null }[]; suggestedOrder: number[]; tips: string[]; label: string }
export interface PriorItem { room: Room | null; score: number | null; issues: PhotoIssue[]; flags: PhotoFlag[] }
export const priorOf = (a: PhotoAnalysis | null | undefined): PriorItem => ({ room: a?.room ?? null, score: a?.quality.score ?? null, issues: a?.quality.issues ?? [], flags: a?.flags ?? [] });

/* Consent: photos are only sent to the AI provider once the person has agreed (and they can withdraw at any time). */
export const PHOTO_CONSENT_TEXT = 'I’m happy for my photos to be sent to Streetkey’s AI provider (OpenAI) to be checked. Photos I add to my listings later are checked too, until I untick this box.';
export const getPhotoConsent = () => aiGet<{ consented: boolean }>('/api/ai/listing/photos/consent');
export const savePhotoConsent = (consent: boolean) => apiCall<{ consented: boolean }>('PUT', '/api/ai/listing/photos/consent', { consent });

/**
 * Check up to 6 photos that are still in the browser (only call this once the person has ticked the consent box).
 * Send the exact files that will be uploaded (so the signed results match them), in chunks from previewChunks().
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
  /** Whether AI checks can run right now (stored results are returned either way). */
  aiEnabled?: boolean;
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

/* ───────── uploads in small batches ───────── */
/*
 * Photos go up a few at a time, each request well under the hosting limit (see src/engine/listings.ts, where the
 * batching lives so the server tests can check it). The same limits keep each AI preview request small.
 */
export { dataUrlBytes, sizeBatches, UPLOAD_BATCH_BYTES, UPLOAD_BATCH_FILES } from '../../engine/listings';
export const PREVIEW_BATCH_FILES = 6;
/** Largest photo the AI preview accepts (the server allows 1.5 MB); the form keeps every photo under it. */
export const PHOTO_MAX_BYTES = 1.4 * 1024 * 1024;

/* ───────── the unsent listing, kept while the person signs in ───────── */
/*
 * Signing in (or creating an account) from the form opens the account page and comes back to /list. The form is
 * kept in this tab's sessionStorage meanwhile. Photos are kept under their own key (so typing doesn't re-save them)
 * when they fit; if they don't, the form says so when it comes back.
 */
export interface DraftEnvelope<T> { v: 1; at: number; data: T }
const DRAFT_TTL_MS = 6 * 3600_000;
export function saveDraft<T>(key: string, data: T): boolean {
  try { sessionStorage.setItem(key, JSON.stringify({ v: 1, at: Date.now(), data } satisfies DraftEnvelope<T>)); return true; } catch { return false; }
}
export function loadDraft<T>(key: string): DraftEnvelope<T> | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as DraftEnvelope<T>;
    if (d?.v !== 1 || !d.data || Date.now() - d.at > DRAFT_TTL_MS) { clearDraft(key); return null; }
    return d;
  } catch { return null; }
}
/** Photos (data URLs) for a draft; false if they're too large to keep (nothing is kept then). */
export function saveDraftPhotos(key: string, photos: string[]): boolean {
  try {
    if (!photos.length) { sessionStorage.removeItem(`${key}.photos`); return true; }
    sessionStorage.setItem(`${key}.photos`, JSON.stringify(photos));
    return true;
  } catch {
    try { sessionStorage.removeItem(`${key}.photos`); } catch { /* storage unavailable */ }
    return false;
  }
}
export function loadDraftPhotos(key: string): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(`${key}.photos`) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.startsWith('data:image/')) : [];
  } catch { return []; }
}
export function clearDraft(key: string) {
  try { sessionStorage.removeItem(key); sessionStorage.removeItem(`${key}.photos`); } catch { /* storage unavailable */ }
}

/**
 * Where a new listing's unsent form is kept in this tab (src/pages/ListProperty.tsx; edits are saved on the server instead).
 * The 'streetkey-draft:' prefix means src/lib/server.tsx clears it (and its photos) on sign-out or when the tab's account changes.
 */
export const LISTING_DRAFT_KEY = 'streetkey-draft:list-new';
/** Forgets the unsent listing kept in this tab. */
export const forgetListingDraft = () => clearDraft(LISTING_DRAFT_KEY);
if (typeof window !== 'undefined') window.addEventListener(ACCOUNT_CHANGED_EVENT, forgetListingDraft);
/** The account type an unsent listing suggests for a new account: 'landlord' when it's to let or from a landlord, else 'owner'. */
export function listingDraftAccountType(): 'owner' | 'landlord' {
  const d = loadDraft<{ f?: { listing?: string }; who?: string }>(LISTING_DRAFT_KEY)?.data;
  return d?.who === 'landlord' || d?.f?.listing === 'rent' ? 'landlord' : 'owner';
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
export type Severity = CheckSeverity;
/**
 * reason: the wording rule (e.g. 'discrimination', 'steering'). enforced: a rule-based "must fix" that also stops
 * publishing (the AI's own points are advice, enforced: false).
 */
export interface PrecheckIssue extends CheckPoint { field: string; message: string; checkId?: string; reason?: string }
export interface PrecheckResult { ready: boolean; issues: PrecheckIssue[]; aiUsed: boolean; aiNote: string | null }
export const precheckListing = (facts: ListingFacts, description: string, photoCount: number) =>
  aiPost<PrecheckResult>('/api/ai/listing/precheck', { facts, description: description.slice(0, 8000), photoCount });

/** Labels and "does it stop publishing" for pre-check points (rules in src/engine/listings.ts). */
export { isEnforced, SEVERITY_LABEL, severityClass, severityLabel } from '../../engine/listings';
export const FIELD_LABEL: Record<string, string> = {
  title: 'Headline', description: 'Description', price: 'Price', postcode: 'Postcode', tenure: 'Tenure', leaseYears: 'Lease', serviceCharge: 'Service charge',
  groundRent: 'Ground rent', councilTax: 'Council tax', epc: 'EPC', beds: 'Bedrooms', baths: 'Bathrooms', floorArea: 'Floor area', features: 'Features', photos: 'Photos', general: 'General',
};
