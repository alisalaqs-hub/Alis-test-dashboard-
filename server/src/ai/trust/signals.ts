/**
 * Trust & safety signals computed in code (no AI): contact details and payment requests in
 * listing text, prices far below the area, missing material information, discriminatory
 * wording and duplicated descriptions. These are deterministic, so they back up the AI review
 * with hard rules and give admins evidence they can check for themselves.
 */
import { areaEvidence } from '../../../../src/engine/listings';
import type { CheckDTO } from '../../../../src/lib/apiTypes';

export type Risk = 'low' | 'medium' | 'high';
export type Severity = Risk;
export const FLAG_TYPES = ['scam', 'misleading', 'discrimination', 'material-info', 'photos', 'contact-details', 'duplicate', 'other'] as const;
export type FlagType = (typeof FLAG_TYPES)[number];
export interface Flag { type: FlagType; severity: Severity; detail: string; evidence: string; source: 'rules' | 'ai' }

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
export const maxRisk = (...r: Risk[]): Risk => r.reduce<Risk>((a, b) => (RANK[b] > RANK[a] ? b : a), 'low');
/** Score bands: low 0–29, medium 30–69, high 70–100. */
export const BAND_MIN: Record<Risk, number> = { low: 0, medium: 30, high: 70 };
export const riskFromScore = (s: number): Risk => (s >= BAND_MIN.high ? 'high' : s >= BAND_MIN.medium ? 'medium' : 'low');
export const clampScore = (n: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));

/* ───────────────────────── text matching ───────────────────────── */
export interface Found { label: string; text: string }
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/[\s,;:.-]+$/, '');

function collect(text: string, rules: [RegExp, string][], max = 6): Found[] {
  const out: Found[] = [];
  for (const [re, label] of rules) {
    for (const m of text.matchAll(re)) {
      const t = tidy(m[0]).slice(0, 120);
      if (t && !out.some((o) => o.text.toLowerCase() === t.toLowerCase())) out.push({ label, text: t });
      if (out.length >= max) return out;
    }
  }
  return out;
}

// UK numbers: 0xxxx xxxxxx or +44 / 0044, allowing spaces, dashes and brackets between digits.
const PHONE = /(?:(?:\+|\b00)\s?44\s?(?:\(0\)\s?)?|\(?\b0)(?:\d[\s\-()]{0,2}){9,10}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const EMAIL_SPELT = /\b[a-z0-9._-]+\s?(?:\(at\)|\[at\]|\{at\}|\sat\s)\s?[a-z0-9-]+\s?(?:\(dot\)|\[dot\]|\sdot\s|\.)\s?(?:com|co\.uk|net|org|uk|io)\b/gi;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>()"']+|\b[a-z0-9][a-z0-9-]{1,62}\.(?:co\.uk|org\.uk|com|net|org|uk|io|info|biz|me)\b(?:\/[^\s<>()"']*)?/gi;
const MESSAGING = /\b(?:whats\s?app|telegram|wechat|viber|signal\s+(?:me|on))\b/gi;

/** Phone numbers, emails, web links and messaging apps in listing text (people should contact listers through Streetkey). */
export function contactDetails(text: string): Found[] {
  const emails = collect(text, [[EMAIL, 'email address'], [EMAIL_SPELT, 'email address']]);
  let rest = text;
  for (const e of emails) rest = rest.split(e.text).join(' ');
  return [...collect(rest, [[PHONE, 'phone number']]), ...emails, ...collect(rest, [[URL, 'web link'], [MESSAGING, 'messaging app']])].slice(0, 8);
}

const PAYMENT: [RegExp, string][] = [
  [/\b(?:bank|wire|money|telegraphic)\s+transfer\b/gi, 'bank transfer'],
  [/\b(?:western\s+union|money\s?gram|remitly|world\s?remit)\b/gi, 'money transfer service'],
  [/\b(?:crypto(?:currenc(?:y|ies))?|bitcoins?|btc|ethereum|usdt|tether)\b/gi, 'cryptocurrency'],
  [/\bgift\s?cards?\b/gi, 'gift cards'],
  [/\bpay\s?pal\b/gi, 'PayPal'],
  [/\b(?:deposit|payment|pay|fee|money|funds)\b[^.!?\n]{0,50}?\bbefore\s+(?:the\s+|a\s+|any\s+|you\s+|we\s+)?(?:view(?:ing)?s?|visit(?:ing|s)?|see(?:ing)?\s+(?:it|the\s+(?:property|flat|house)))\b/gi, 'payment before viewing'],
  [/\bviewing\s+fees?\b/gi, 'viewing fee'],
];
/** Requests to pay off-platform or before a viewing: classic property-scam patterns. */
export const paymentRequests = (text: string) => collect(text, PAYMENT);

const SCAM_PHRASES: [RegExp, string][] = [
  [/\b(?:i\s+am|i'm|i’m|we\s+are|we're|we’re|owner\s+is|landlord\s+is)\s+(?:currently\s+|now\s+)?(?:abroad|overseas|out\s+of\s+the\s+country|working\s+abroad|living\s+abroad)\b/gi, 'lister says they are abroad'],
  [/\bkeys?\b[^.!?\n]{0,40}?\b(?:posted|by\s+post|couriered|by\s+courier|sent\s+to\s+you|delivered\s+to\s+you)\b/gi, 'keys sent by post'],
  [/\b(?:no\s+viewings?|viewings?\s+(?:are\s+|is\s+)?not\s+(?:possible|available)|can(?:not|'t|’t)\s+(?:do|arrange|offer)\s+(?:a\s+|any\s+)?viewings?)\b/gi, 'no viewings offered'],
];
export const scamPhrases = (text: string) => collect(text, SCAM_PHRASES);

const GROUPS = 'foreigners|immigrants|asians?|africans?|indians?|pakistanis?|bangladeshis?|chinese|polish|romanians?|eastern\\s+europeans?|black\\s+people|travellers|gypsies|muslims?|jews|christians?|hindus?|sikhs?|gays?|lesbians?|lgbt\\w*|pregnant\\s+women';
const DISCRIM: [RegExp, string][] = [
  [new RegExp(`\\b(?:no|not\\s+suitable\\s+for|not\\s+for|sorry\\s+no)\\s+(?:${GROUPS})\\b`, 'gi'), 'excludes a protected group'],
  [/\b(?:english|british|white|christian|muslim|hindu|indian|asian|european)\s+(?:only|tenants\s+only|people\s+only|families\s+only|preferred)\b/gi, 'prefers a protected group'],
];
/** Wording that excludes people by race, nationality, religion, sexual orientation or pregnancy (beyond the core checks). */
export const discriminatoryWording = (text: string) => collect(text, DISCRIM);

/** Mask digits and the local part of emails so contact details aren't sent to the AI model. */
export function mask(s: string) {
  return s.replace(/\d(?=(?:\D*\d){3})/g, '•').replace(/^([^@\s]{1})[^@\s]*@/, '$1•••@');
}

/* ───────────────────────── price vs area ───────────────────────── */
export interface PriceSignal {
  checked: boolean;
  reason?: 'commercial' | 'no-evidence';
  channel?: 'sale' | 'rent';
  /** Typical level for the area and this floor area, from Streetkey's area evidence (£, or £ pcm for rentals). */
  typicalLow?: number; typicalHigh?: number;
  /** Asking price as a share of the bottom of the typical range. */
  ratio?: number;
  belowPct?: number; abovePct?: number;
  farBelow?: boolean; wellAbove?: boolean;
  scope?: string; comparables?: number;
}
export const FAR_BELOW_RATIO = 0.6; // more than 40% below the area range
export const WELL_ABOVE_RATIO = 2.5;

export function priceSignal(l: { channel: 'sale' | 'rent'; postcode: string; property_type: string; price: number; floor_area: number }): PriceSignal {
  if (l.property_type === 'commercial') return { checked: false, reason: 'commercial' };
  const ev = areaEvidence(l.postcode);
  const area = Number(l.floor_area);
  if (!ev || !(area > 0)) return { checked: false, reason: 'no-evidence' };
  const round = (n: number) => (l.channel === 'rent' ? Math.round(n / 25) * 25 : Math.round(n / 1000) * 1000);
  const low = l.channel === 'rent' ? ev.rentPerM2 * area : ev.asIsPerM2 * area;
  const high = l.channel === 'rent' ? ev.rentPerM2 * area : Math.max(ev.refurbishedPerM2, ev.asIsPerM2) * area;
  if (!(low > 0)) return { checked: false, reason: 'no-evidence' };
  const price = Number(l.price);
  const ratio = price / low;
  return {
    checked: true, channel: l.channel, typicalLow: round(low), typicalHigh: round(high), ratio: Math.round(ratio * 100) / 100,
    belowPct: ratio < 1 ? Math.round((1 - ratio) * 100) : 0, abovePct: price > high ? Math.round((price / high - 1) * 100) : 0,
    farBelow: ratio < FAR_BELOW_RATIO, wellAbove: price / high > WELL_ABOVE_RATIO,
    // Rents come from regional evidence; sale prices from the postcode district where Streetkey has it.
    scope: l.channel === 'rent' ? 'rentals in the wider region' : ev.scope, comparables: l.channel === 'rent' ? undefined : ev.n,
  };
}

/* ───────────────────────── duplicates ───────────────────────── */
export const normaliseText = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
export const words = (s: string) => normaliseText(s).split(' ').filter(Boolean);
export function shingles(s: string, k = 3) {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(' '));
  return out;
}
/** How much of `a` is repeated in `b` (max of Jaccard and containment, 0–1). */
export function overlap(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return Math.max(both / (a.size + b.size - both), both / a.size);
}
export const DUPLICATE_MIN_WORDS = 15;
export const DUPLICATE_THRESHOLD = 0.7;
/** Distinctive words to find candidate duplicates with the full-text index (letters only: safe for to_tsquery). */
export function searchTerms(s: string, max = 10) {
  return [...new Set(words(s).filter((w) => w.length >= 5 && /^[a-z]+$/.test(w)))].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, max);
}

/* ───────────────────────── checks → flags ───────────────────────── */
const CHECK_TYPE: Record<string, FlagType> = { discrim: 'discrimination', bidding: 'other', photos: 'photos', 'photo-min': 'photos', ownership: 'other' };

export interface Signals {
  moderation: {
    text: { checked: boolean; flagged: boolean; categories: string[] };
    photos: { photoId: string; position: number; checked: boolean; flagged: boolean; categories: string[]; note?: string }[];
    photoTotal: number;
  };
  price: PriceSignal;
  failingChecks: (CheckDTO & { type: FlagType })[];
  duplicates: { ref: string; similarity: number; sameLister: boolean; status: string }[];
  contacts: Found[];
  payments: Found[];
  scamPhrases: Found[];
  discrimination: Found[];
  blockingChecksPass: boolean;
  wordCount: number;
}

export const typeForCheck = (id: string): FlagType => CHECK_TYPE[id] ?? 'material-info';

const gbp = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const list = (xs: string[]) => xs.join(', ');

/** Flags that follow directly from the code-computed signals (always included, whatever the AI says). */
export function ruleFlags(s: Signals): Flag[] {
  const f: Flag[] = [];
  const add = (type: FlagType, severity: Severity, detail: string, evidence: string) => f.push({ type, severity, detail, evidence: evidence.slice(0, 300), source: 'rules' });
  if (s.moderation.text.flagged) add('other', 'medium', 'Automatic content moderation flagged the listing text.', `Categories: ${list(s.moderation.text.categories) || 'unspecified'}`);
  for (const p of s.moderation.photos.filter((x) => x.flagged)) add('photos', 'medium', `Photo ${p.position} was flagged by automatic content moderation.`, `Categories: ${list(p.categories) || 'unspecified'}`);
  const price = s.price;
  if (price.checked && price.farBelow) {
    add('scam', s.payments.length ? 'high' : 'medium',
      `The ${price.channel === 'rent' ? 'rent' : 'asking price'} is about ${price.belowPct}% below the typical level for ${price.scope}${s.payments.length ? ', and the listing asks for payment outside Streetkey' : ''}.`,
      `Typical ${price.channel === 'rent' ? 'rent' : 'price'} for this size: from ${gbp(price.typicalLow!)}${price.channel === 'rent' ? ' pcm' : ''} (Streetkey area evidence${price.comparables ? `, ${price.comparables} reference ${price.comparables === 1 ? 'listing' : 'listings'}` : ''})`);
  }
  if (price.checked && price.wellAbove) add('misleading', 'low', `The ${price.channel === 'rent' ? 'rent' : 'price'} is far above the typical level for ${price.scope}; it may have been entered incorrectly.`, `Typical up to ${gbp(price.typicalHigh!)}${price.channel === 'rent' ? ' pcm' : ''}`);
  if (s.payments.length) add('scam', price.checked && price.farBelow ? 'high' : 'medium', 'The listing asks for payment outside Streetkey or before a viewing.', s.payments.map((p) => `“${p.text}”`).join(' · '));
  if (s.scamPhrases.length) add('scam', 'medium', `Wording often seen in rental and sale scams (${list([...new Set(s.scamPhrases.map((p) => p.label))])}).`, s.scamPhrases.map((p) => `“${p.text}”`).join(' · '));
  if (s.contacts.length) add('contact-details', 'medium', `The listing includes contact details (${list([...new Set(s.contacts.map((c) => c.label))])}). Enquiries should go through Streetkey so both sides stay protected.`, s.contacts.map((c) => c.text).join(' · '));
  if (s.discrimination.length) add('discrimination', 'high', 'Wording that may exclude people because of a protected characteristic (Equality Act 2010).', s.discrimination.map((d) => `“${d.text}”`).join(' · '));
  const others = s.duplicates.filter((d) => !d.sameLister);
  if (others.length) add('duplicate', 'medium', `The description closely matches ${others.length === 1 ? 'another listing' : `${others.length} other listings`} from a different lister.`, others.map((d) => `${d.ref} (${Math.round(d.similarity * 100)}% match, ${d.status})`).join(' · '));
  const own = s.duplicates.filter((d) => d.sameLister);
  if (own.length) add('duplicate', 'low', 'The description repeats another listing by the same lister.', own.map((d) => `${d.ref} (${Math.round(d.similarity * 100)}% match)`).join(' · '));
  for (const c of s.failingChecks) add(c.type, c.type === 'discrimination' ? 'high' : c.severity === 'block' ? 'medium' : 'low', c.message, `Check: ${c.id}`);
  return f;
}

/** A polite, actionable message for the lister built from the rule flags (used when the AI gives none). */
export function fallbackReason(s: Signals): string | null {
  const asks: string[] = [];
  if (s.contacts.length) asks.push('Remove phone numbers, email addresses and web links from the listing. People contact you securely through Streetkey, which keeps your details private.');
  if (s.payments.length) asks.push('Remove any request for payment by bank transfer, cryptocurrency or similar, or before a viewing. Payments should never be asked for before someone has viewed the property.');
  if (s.scamPhrases.length) asks.push('Please make sure in-person viewings are offered and that keys are handed over in person.');
  if (s.price.checked && s.price.farBelow) asks.push('Please double-check the price: it is much lower than similar homes nearby. If it is correct, add a short note explaining why.');
  if (s.discrimination.length || s.failingChecks.some((c) => c.type === 'discrimination')) asks.push('Remove wording that excludes particular groups of people. Adverts must be open to everyone.');
  if (s.duplicates.some((d) => !d.sameLister)) asks.push('Write the description in your own words: it closely matches another listing on Streetkey.');
  if (s.moderation.photos.some((p) => p.flagged)) asks.push('Replace any photos that do not show the property itself.');
  if (s.moderation.text.flagged) asks.push('Remove any wording that is offensive or unrelated to the property.');
  const missing = s.failingChecks.filter((c) => c.type === 'material-info' || c.type === 'photos');
  if (missing.length) asks.push(`Add the missing details: ${missing.map((c) => c.message.replace(/\.$/, '')).join('; ')}.`);
  if (!asks.length) return null;
  return `Thank you for your listing. Before it can go live, please:\n${asks.map((a) => `- ${a}`).join('\n')}\nYou can edit the listing and submit it again from your account.`.slice(0, 1000);
}

/* ───────────────────────── grounding ───────────────────────── */
const MONEY = /£\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|bn|million|thousand)?\b/gi;
const PERCENT = /(\d+(?:\.\d+)?)\s?(?:%|per\s?cent)/gi;
const toNum = (digits: string, unit?: string) => {
  const n = Number(digits.replace(/,/g, ''));
  const u = (unit ?? '').toLowerCase();
  return n * (u === 'k' || u === 'thousand' ? 1e3 : u === 'm' || u === 'million' ? 1e6 : u === 'bn' ? 1e9 : 1);
};
/** Every number that appears in a text (so figures quoted from the listing count as grounded). */
export function numbersIn(text: string) {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?(k|m|million|thousand)?\b/gi)) out.push(toNum(m[1], m[2]));
  return out;
}

/**
 * Drops sentences that state a £ amount or a percentage that isn't in the allowed set
 * (engine/database figures and numbers the listing itself contains). The model explains;
 * it doesn't produce figures.
 */
export function groundFigures(text: string, allowed: { money: number[]; percent: number[] }) {
  const ok = (v: number, pool: number[], tol: (x: number) => number) => pool.some((a) => Math.abs(a - v) <= tol(a));
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z“"(])/);
  const keep = sentences.filter((s) => {
    for (const m of s.matchAll(MONEY)) if (!ok(toNum(m[1], m[2]), allowed.money, (a) => Math.max(1, Math.abs(a) * 0.01))) return false;
    for (const m of s.matchAll(PERCENT)) if (!ok(Number(m[1]), allowed.percent, () => 1)) return false;
    return true;
  });
  return keep.join(' ').trim();
}

/** Strips contact details from AI-written text meant for the lister (the model must not add any). */
export const hasContactDetails = (s: string) => contactDetails(s).length > 0;
