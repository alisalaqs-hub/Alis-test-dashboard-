/**
 * Listing supply: everything that turns outside data into Streetkey listings.
 *
 *  1. Owner / landlord posts      → buildListing() + complianceChecks()
 *  2. Agent CRM feeds (BLM v3)    → parseBLM()      (the bulk format CRMs already export to portals)
 *  3. Links found on other sites  → extractListing() (user-pasted text, kept PRIVATE, links back)
 *  4. Merging the same home from several sources → dedupe()
 *  5. "Search everywhere" deep links → externalSearchLinks()
 *
 * We never fetch or copy content from other portals. Agent feeds arrive with
 * the agent's consent; pasted listings are user-provided and private.
 */
import { PROPERTIES, type ListingSource, type Property } from '../data/properties';
import { regionFromPostcode, type Condition, type Era, type PropertyType, type RegionKey } from './refurb';
import type { Nation } from './tax';

/* ---------- geography (offline fallback; production uses ONS Postcode Directory / postcodes.io) ---------- */
const REGION_CENTROID: Record<RegionKey, [number, number]> = {
  'central-london': [51.51, -0.12], 'outer-london': [51.5, -0.1], 'south-east': [51.3, -0.8], east: [52.2, 0.6], 'south-west': [50.9, -3.2],
  'west-midlands': [52.48, -1.9], 'east-midlands': [52.9, -1.2], 'north-west': [53.48, -2.5], yorkshire: [53.8, -1.5], 'north-east': [54.9, -1.6],
  wales: [51.7, -3.4], scotland: [55.9, -4.0], 'northern-ireland': [54.6, -5.9],
};
export function locate(postcode: string): { lat: number; lng: number; nation: Nation; district: string; precise: boolean } {
  const pc = postcode.trim().toUpperCase();
  const district = pc.split(' ')[0] || pc.slice(0, -3);
  const known = PROPERTIES.find((p) => p.district === district && !p.source);
  const region = regionFromPostcode(pc) ?? 'south-west';
  const nation: Nation = region === 'wales' ? 'wales' : region === 'scotland' ? 'scotland' : region === 'northern-ireland' ? 'northern-ireland' : 'england';
  if (known) return { lat: known.lat, lng: known.lng, nation, district, precise: false };
  const [lat, lng] = REGION_CENTROID[region];
  return { lat, lng, nation, district, precise: false };
}
export const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
export const normalisePostcode = (s: string) => { const m = s.toUpperCase().match(POSTCODE_RE); return m ? `${m[1]} ${m[2]}` : s.toUpperCase().trim(); };

/* ---------- evidence for price checks ---------- */
export function areaEvidence(postcode: string) {
  const district = normalisePostcode(postcode).split(' ')[0];
  const region = regionFromPostcode(postcode);
  const resi = PROPERTIES.filter((p) => p.listing !== 'rent' && p.type !== 'commercial' && !p.source);
  const near = resi.filter((p) => p.district === district);
  const pool = near.length ? near : resi.filter((p) => regionFromPostcode(p.postcode) === region);
  if (!pool.length) return null;
  const perM2 = (p: Property) => p.price / p.floorArea;
  const asIsPerM2 = pool.reduce((s, p) => s + perM2(p), 0) / pool.length;
  const refurbishedPerM2 = pool.reduce((s, p) => s + p.estGdv / p.floorArea, 0) / pool.length;
  const lets = PROPERTIES.filter((p) => p.listing === 'rent' && !p.source && regionFromPostcode(p.postcode) === region);
  const rentPerM2 = lets.length ? lets.reduce((s, p) => s + p.price / p.floorArea, 0) / lets.length : (asIsPerM2 * 0.045) / 12;
  return { asIsPerM2, refurbishedPerM2, rentPerM2, n: pool.length, scope: near.length ? `postcode district ${district}` : 'the wider region', district };
}

/* ---------- 1. build a listing from any input ---------- */
export interface ListingInput {
  id?: string;
  listing: 'sale' | 'rent';
  title?: string;
  addressLine: string;
  town: string;
  postcode: string;
  type: PropertyType;
  tenure: Property['tenure'];
  leaseYears?: number;
  beds: number; baths: number; floorArea: number;
  era?: Era; condition?: Condition;
  price: number;
  epc?: string;
  councilTax?: string;
  serviceChargeAnnual?: number; groundRentAnnual?: number;
  features: string[];
  description?: string;
  photos?: string[];
  source: ListingSource;
  visibility?: 'public' | 'private';
  status?: Property['status'];
  geo?: { lat: number; lng: number };
}

const EPC_SCORE: Record<string, number> = { A: 94, B: 84, C: 72, D: 61, E: 47, F: 30, G: 15 };
const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export function buildListing(i: ListingInput): Property {
  const pc = normalisePostcode(i.postcode);
  const loc = locate(pc);
  const ev = areaEvidence(pc);
  const epc = (i.epc ?? 'D').toUpperCase().slice(0, 1);
  const area = Math.max(15, i.floorArea || Math.round(25 + i.beds * 22));
  const id = i.id ?? `${i.source.kind}-${pc.replace(/\s/g, '').toLowerCase()}-${Math.abs(hue(i.addressLine + i.price + i.beds))}-${Date.now().toString(36)}`;
  return {
    id, title: i.title?.trim() || `${i.beds ? `${i.beds}-bed ` : ''}${i.type}${i.listing === 'rent' ? ' to rent' : ' for sale'} in ${i.town}`,
    street: i.addressLine, district: loc.district, postcode: pc, town: i.town, nation: loc.nation,
    lat: i.geo?.lat ?? loc.lat + ((hue(id) % 20) - 10) / 1000, lng: i.geo?.lng ?? loc.lng + ((hue(id + 'x') % 20) - 10) / 1000,
    listing: i.listing, price: i.price, type: i.type, tenure: i.tenure, leaseYears: i.leaseYears,
    beds: i.beds, baths: Math.max(1, i.baths), floorArea: area, storeys: i.type === 'flat' || i.type === 'bungalow' ? 1 : 2,
    era: i.era ?? '1945-1979', condition: i.condition ?? 'fair',
    epc: { current: epc, potential: epc <= 'C' ? epc : 'C', score: EPC_SCORE[epc] ?? 60 }, councilTax: i.councilTax ?? 'Not stated',
    features: i.features.filter(Boolean),
    loftPotential: i.type === 'flat' ? 'none' : 'possible', extensionPotential: i.type === 'flat' ? 'none' : 'possible',
    estRentPcm: i.listing === 'rent' ? i.price : Math.round(((ev?.rentPerM2 ?? 14) * area) / 25) * 25,
    estGdv: ev ? Math.round(ev.refurbishedPerM2 * area / 1000) * 1000 : Math.round(i.price * 1.1),
    commute: { to: 'Nearest centre', minutes: 0, mode: 'Not yet calculated' }, station: { name: 'Not yet calculated', walkMins: 0 },
    schools: [], risks: { flood: 'low', conservationArea: false, article4: false, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [{ date: new Date().toISOString().slice(0, 7), price: i.price, event: 'Listed' }],
    areaIndex: PROPERTIES.find((p) => p.district === loc.district && !p.source)?.areaIndex ?? Array.from({ length: 24 }, (_, k) => 100 + k * 0.15),
    rentDemand: 70, comparables: [], planningNearby: [], agent: i.source.name, daysOnMarket: 0, photoHue: hue(id),
    serviceChargeAnnual: i.serviceChargeAnnual, groundRentAnnual: i.groundRentAnnual,
    documents: [epc ? 'EPC (stated)' : 'EPC (required)', 'Floor plan (requested)'],
    source: i.source, visibility: i.visibility ?? 'public', photos: i.photos, description: i.description, status: i.status ?? 'live', createdAt: new Date().toISOString(),
  };
}

/* ---------- matching without lookbehind ---------- */
/*
 * This file never uses regex lookbehind assertions: Safari before 16.4 (iOS 16.3 and earlier) can't parse them,
 * and as this module loads with the site, the whole site would fail to start there. (src/engine/listings.test.ts
 * checks.) Where a match must not follow certain words ("no bidding", "never pay by bank transfer"), the text
 * before the match is checked in code instead.
 */
/** Whether the text just before `at` ends with `words` (a pattern source, matched case-insensitively). */
function endsWith(words: string): (text: string, at: number) => boolean {
  const tail = new RegExp(String.raw`(?:${words})$`, 'i');
  return (text, at) => tail.test(text.slice(0, at));
}
type Skip = (text: string, at: number, m: RegExpExecArray) => boolean;
/**
 * A RegExp whose matches don't count where `skip` says so, as a negative lookbehind would: a skipped match is
 * tried again from the next character. It works wherever a RegExp does (test, exec, matchAll, match, replace),
 * so the server's wording and trust checks use these patterns like any other. `source` is the pattern without
 * the skip rule, so a RegExp rebuilt from it matches skipped wording too.
 */
class Unless extends RegExp {
  readonly skip: Skip;
  private readonly scan: RegExp;
  constructor(pattern: string | RegExp, flags?: string, skip?: Skip) {
    super(pattern, flags);
    // matchAll and split make their own copy with new RegExp-style arguments (pattern, flags): keep the rule.
    this.skip = skip ?? (pattern instanceof Unless ? pattern.skip : () => false);
    this.scan = new RegExp(this.source, this.flags.includes('g') ? this.flags : `${this.flags}g`);
  }
  override exec(input: string): RegExpExecArray | null {
    const text = String(input);
    const keep = this.global || this.sticky; // only these read and move lastIndex
    const scan = this.scan;
    scan.lastIndex = keep ? this.lastIndex : 0;
    for (let m = scan.exec(text); m; m = scan.exec(text)) {
      if (!this.skip(text, m.index, m)) {
        if (keep) this.lastIndex = scan.lastIndex;
        return m;
      }
      if (this.sticky) break;
      scan.lastIndex = m.index + 1;
    }
    if (keep) this.lastIndex = 0;
    return null;
  }
}

/* ---------- 2. compliance checks for owner/landlord posts ---------- */
export interface Check { id: string; ok: boolean; severity: 'block' | 'warn'; message: string }

/*
 * Wording rules shared by the listing form, the server (submit and edits) and the AI wording checks
 * (server/src/ai/listing/wording.ts), so a listing is judged the same way everywhere.
 *
 * Discrimination: blanket exclusions ("No DSS", "professionals only", "no children") are unlawful in
 * rental adverts and refused. Honest wording that merely mentions these words is not: "no family
 * bathroom", "no children's play area", "DSS welcome", "we accept housing benefit".
 */
export const DISCRIMINATORY: RegExp[] = [
  /\b(?:no|not\s+suitable\s+for|unsuitable\s+for|sorry,?\s+no|not\s+accepting|we\s+(?:do\s+not|don['’]t)\s+accept|cannot\s+accept|can['’]t\s+accept)\s+(?:dss|benefits?(?:\s+claimants)?|housing\s+benefits?|universal\s+credit|children(?!['’])|kids(?!['’])|families|students(?!['’])|foreigners|immigrants|refugees|asylum\s+seekers|disabled(?:\s+people)?|pensioners|sharers|couples)\b/i,
  /\b(?:dss|housing\s+benefits?|universal\s+credit|benefit\s+claimants|children|families|students)\s+(?:tenants\s+)?(?:are\s+|is\s+)?(?:not\s+(?:accepted|considered|allowed|welcome|permitted)|need\s+not\s+apply)\b/i,
  /\b(?:professionals?|working\s+(?:people|professionals?|tenants?|persons?)|white|black|asian|british|english|christians?|muslims?|jewish|hindus?|sikhs?|single\s+(?:people|persons?|females?|males?)|females?|males?|ladies|gentlemen|men|women|young\s+(?:people|professionals?)|mature\s+(?:people|persons?|professionals?)|non[- ]students?|employed\s+(?:people|persons?|tenants?))\s+(?:only|preferred|wanted|required|sought)\b/i,
  /\b(?:english|british)\s+(?:speakers?|nationals?|citizens?)\s+only\b/i,
];
/** Wording honest landlords use to say they *don't* do something ("no bidding", "we don't charge admin fees"). */
const NOT_DONE = endsWith(String.raw`\b(?:no|not|never|zero|nil|without|free\s+of|don['’]t\s+(?:charge|accept|take|ask\s+for)|do\s+not\s+(?:charge|accept|take|ask\s+for)|won['’]t\s+(?:charge|accept|take)|will\s+not\s+(?:charge|accept|take)|not\s+accepting)\s+(?:[\w-]+\s+){0,2}`);
/** Rental bidding: a rental advert must state one fixed rent (Renters' Rights Act). */
export const BIDDING: RegExp = new Unless(String.raw`\b(?:offers?\s+(?:over|in\s+excess\s+of|above|in\s+the\s+region\s+of)|o\.?i\.?r\.?o\.?|o\.?i\.?e\.?o\.?|best\s+offers?|best\s+and\s+final(?:\s+offers?)?|bids?|bidding|highest\s+(?:offer|bidder)|sealed\s+bids?|guide\s+price|rent\s+(?:is\s+)?negotiable|or\s+nearest\s+offer|o\.?n\.?o\b\.?|open\s+to\s+offers|offers\s+invited)\b`, 'i', NOT_DONE);
/** Tenant fees banned by the Tenant Fees Act 2019 (not "no admin fees", which is what honest landlords write). */
export const TENANT_FEES: RegExp = new Unless(String.raw`\b(?:admin(?:istration)?\s+fees?|referencing\s+fees?|check[- ](?:in|out)\s+fees?|inventory\s+fees?|(?:tenancy\s+)?set[- ]up\s+fees?|renewal\s+fees?|agency\s+fees?|application\s+fees?|credit\s+check\s+fees?)\b`, 'i', NOT_DONE);
export const isDiscriminatory = (text: string) => DISCRIMINATORY.some((re) => re.test(text));

/* ---------- contact details, payment requests and scam phrases in listing text ---------- */
/*
 * People contact listers through Streetkey (which keeps everyone's details private), and asking for money
 * before a viewing is the classic rental scam. The trust review (server/src/ai/trust/signals.ts) uses the
 * same patterns; here they warn the lister before they submit and keep public fields (town, street) clean.
 */
export interface Found { label: string; text: string }
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/[\s,;:.-]+$/, '');
/** A global pattern, or a function giving the matching wording, with the label for what it found. */
type Rule = [RegExp | ((text: string) => Iterable<string>), string];
const matches = (text: string, find: Rule[0]): Iterable<string> => (typeof find === 'function' ? find(text) : Array.from(text.matchAll(find), (m) => m[0]));
function collect(text: string, rules: Rule[], max = 6): Found[] {
  const out: Found[] = [];
  for (const [find, label] of rules) {
    for (const hit of matches(text, find)) {
      const t = tidy(hit).slice(0, 120);
      if (t && !out.some((o) => o.text.toLowerCase() === t.toLowerCase())) out.push({ label, text: t });
      if (out.length >= max) return out;
    }
  }
  return out;
}
// UK numbers: 0xxxx xxxxxx or +44 / 0044, allowing spaces, dashes and brackets between digits.
const PHONE = /(?:(?:\+|\b00)\s?44\s?(?:\(0\)\s?)?|\(?\b0)(?:\d[\s\-()]{0,2}){9,10}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
// Spelt-out emails need an explicit marker ("name(at)site.com", "name [at] site [dot] com", "name at site dot com").
const MARK_DOT = String.raw`\s?(?:\(dot\)|\[dot\]|\{dot\})\s?|\s+dot\s+`;
const SPELT_TLD = String.raw`(?:com|co(?:\.|${MARK_DOT})uk|net|org|uk|io)`;
const EMAIL_SPELT = new RegExp(String.raw`\b[a-z0-9._-]+\s?(?:\(at\)|\[at\]|\{at\})\s?[a-z0-9-]+(?:${MARK_DOT}|\.)${SPELT_TLD}\b|\b[a-z0-9._-]+\s+at\s+[a-z0-9-]+(?:${MARK_DOT})${SPELT_TLD}\b`, 'gi');
const WEB_LINK = /\b(?:https?:\/\/|www\.)[^\s<>()"']+|\b[a-z0-9][a-z0-9-]{1,62}\.(?:co\.uk|org\.uk|com|net|org|uk|io|info|biz|me)\b(?:\/[^\s<>()"']*)?/gi;
const MESSAGING = /\b(?:whats\s?app|telegram|wechat|viber|snapchat)\b/gi;
// "Signal" only counts as the messaging app when written like one ("on Signal", "Signal me"), not "mobile signal".
const SIGNAL_APP = /\b(?:on|via)\s+Signal\b|\bSignal\s+(?:me|us)\b/g;

/** Phone numbers, emails, web links and messaging apps in listing text. */
export function contactDetails(text: string): Found[] {
  const emails = collect(text, [[EMAIL, 'email address'], [EMAIL_SPELT, 'email address']]);
  let rest = text;
  for (const e of emails) rest = rest.split(e.text).join(' ');
  return [...collect(rest, [[PHONE, 'phone number']]), ...emails, ...collect(rest, [[WEB_LINK, 'web link'], [MESSAGING, 'messaging app'], [SIGNAL_APP, 'messaging app']])].slice(0, 8);
}

/**
 * Not when the wording rules it out: "we never ask for payment before a viewing", "never pay by bank transfer", "we
 * never take payment via Revolut", "we will never ask for a deposit by bank transfer". Honest anti-scam wording like
 * this mustn't get a payment warning. (The trust review, server/src/ai/trust/signals.ts, uses the same words.)
 */
const NEGATED = endsWith(String.raw`\b(?:no|never|not|without|nor|don['’]t|won['’]t|doesn['’]t)\s+(?:(?:ask|asks|asking|asked|take|takes|taking|taken|request|requests|requested|require|requires|required|need|needs|needed|charge|charges|charged|accept|accepts|send|make|pay|paying|by|via|using|any|a|an|the|for|is|are|be|been|you|to|we|ever|will|should|upfront|money|payment|payments|deposit|deposits|holding|funds|rent)\s+){0,5}`);
const unlessNegated = (re: RegExp) => new Unless(re.source, re.flags, NEGATED);
const PAYMENT: [RegExp, string][] = ([
  [/\b(?:bank|wire|money|telegraphic)\s+transfers?\b/gi, 'bank transfer'],
  [/\b(?:western\s+union|money\s?gram|remitly|world\s?remit)\b/gi, 'money transfer service'],
  [/\b(?:revolut|monzo|cash\s?app|venmo)\b/gi, 'payment app'],
  [/\b(?:sort\s+code|account\s+number|bank\s+details|iban)\b/gi, 'bank details'],
  [/\b(?:crypto(?:currenc(?:y|ies))?|bitcoins?|btc|ethereum|usdt|tether)\b/gi, 'cryptocurrency'],
  [/\bgift\s?cards?\b/gi, 'gift cards'],
  [/\bpay\s?pal\b/gi, 'PayPal'],
  [/\b(?:deposit|payment|pay|fee|money|funds)\b[^.!?\n]{0,50}?\bbefore\s+(?:the\s+|a\s+|any\s+|you\s+|we\s+)?(?:view(?:ing)?s?|visit(?:ing|s)?|see(?:ing)?\s+(?:it|the\s+(?:property|flat|house)))\b/gi, 'payment before viewing'],
  [/\bviewing\s+fees?\b/gi, 'viewing fee'],
] as [RegExp, string][]).map(([re, label]) => [unlessNegated(re), label]);
/** Requests to pay off-platform or before a viewing: classic property-scam patterns. */
export const paymentRequests = (text: string) => collect(text, PAYMENT);

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
/** Ordinary scheduling after "no viewings" ("on Sundays", "before 10am"): not a refusal to show the property. */
const WHEN = String.raw`(?:on\s+(?:a\s+)?(?:\w+days?|weekends?|bank\s+holidays?)|at\s+(?:the\s+)?(?:weekends?|night|\d)|(?:before|after|until|till|from|past)\s+(?:the\s+)?(?:\d|noon|midday|midnight|dark|\w+day\b|weekend|evening|morning|${MONTHS})|(?:during|over|in)\s+(?:the\s+)?(?:weekends?|evenings?|mornings?|holidays?|school\s+holidays|christmas|easter|\w+\s+holidays?)|between\s+\d|(?:this|next)\s+(?:week|weekend|\w+day)|without\s+(?:an?\s+|prior\s+|advance\s+)?(?:appointment|booking|notice)|(?:unless|except)\s+(?:by\s+appointment|booked|arranged))`;
/** How keys get to someone who hasn't viewed: posted, couriered, "sent to you". */
const SENT = String.raw`\b(?:posted|by\s+post|couriered|by\s+courier|sent\s+to\s+you|delivered\s+to\s+you)\b`;
const SENT_WORDS = new RegExp(SENT, 'gi');
const KEYS_SENT = new RegExp(String.raw`\bkeys?\b[^.!?\n]{0,40}?${SENT}`, 'gi');
/** "never posted", "won't be sent to you", "not by courier": the sending is ruled out. */
const NOT_SENT = endsWith(String.raw`(?:\bnever|\bnot|n['’]t)\s+(?:\w+\s+){0,2}`);
/**
 * "Keys … posted / couriered / sent to you", unless that sending is ruled out ("the keys are never posted"). The
 * ruled-out words are blanked first (same length, so positions don't move), then the keys are matched to the
 * nearest sending that's left, so "the keys won't be posted; they'll be couriered" still counts.
 */
function keysSent(text: string): string[] {
  const left = text.replace(SENT_WORDS, (w: string, at: number) => (NOT_SENT(text, at) ? w.replace(/\S/g, ' ') : w));
  return Array.from(left.matchAll(KEYS_SENT), (m) => text.slice(m.index, m.index + m[0].length));
}
const SCAM_PHRASES: Rule[] = [
  [/\b(?:i\s+am|i'm|i’m|we\s+are|we're|we’re|owner\s+is|landlord\s+is)\s+(?:currently\s+|now\s+)?(?:abroad|overseas|out\s+of\s+the\s+country|working\s+abroad|living\s+abroad)\b/gi, 'lister says they are abroad'],
  [keysSent, 'keys sent by post'],
  [new RegExp(String.raw`\b(?:no\s+viewings?|viewings?\s+(?:are\s+|is\s+)?not\s+(?:possible|available)|can(?:not|'t|’t)\s+(?:do|arrange|offer)\s+(?:a\s+|any\s+)?viewings?)\b(?!\s+${WHEN})`, 'gi'), 'no viewings offered'],
];
export const scamPhrases = (text: string) => collect(text, SCAM_PHRASES);

/** Hide the house number for private sellers, e.g. "Flat 2, 14 Elm Road" → "Elm Road" (what the public sees). */
export function streetOnly(addressLine: string) {
  const parts = addressLine.split(',').map((s) => s.trim()).filter(Boolean);
  const street = parts.find((p) => /[a-z]{3,}/i.test(p.replace(/^(flat|apartment|apt|unit|house)\b/i, '')) && !/^(flat|apartment|apt|unit)\b/i.test(p)) ?? parts[parts.length - 1] ?? addressLine;
  return street.replace(/^\s*\d+[a-z]?(\s*[-–/]\s*\d+[a-z]?)?\s+/i, '').trim();
}

/**
 * Why a public place field (town or first line of the address) can't be saved, or null if it's fine.
 * These are shown publicly, so they must not carry contact details, links or payment instructions.
 */
export function placeFieldProblem(value: string, field: 'town' | 'addressLine'): string | null {
  const v = value.trim();
  if (!v) return null;
  if (contactDetails(v).length) return field === 'town' ? 'Enter only the town or area: no phone numbers, emails, links or messaging apps.' : 'Enter only the address: no phone numbers, emails, links or messaging apps.';
  if (paymentRequests(v).length || /\b(?:deposits?|pay(?:ment)?|transfers?|fees?|cash|e-?mail)\b/i.test(v)) {
    return field === 'town' ? 'Enter only the town or area. Put other details in the description.' : 'Enter only the address. Put other details in the description.';
  }
  if (field === 'town' && !/^[\p{L}][\p{L}\p{M}\p{N} .,'’()&!-]*$/u.test(v)) return 'Enter the town or area using letters only (for example “Walthamstow” or “Stratford-upon-Avon”).';
  return null;
}

/** Why photo alt text (public, read out by screen readers) can't be saved, or null if it's fine. */
export function altTextProblem(alt: string): string | null {
  const v = alt.trim();
  if (!v) return null;
  if (contactDetails(v).length) return 'Alt text should only describe the photo: remove phone numbers, email addresses, web links and messaging apps.';
  if (paymentRequests(v).length) return 'Alt text should only describe the photo: remove payment details.';
  return null;
}

/*
 * Key-feature lines that only repeat a structured field (bedrooms, bathrooms, floor area, tenure, EPC,
 * council tax). The listing shows those from the facts themselves, so copying them into the features
 * would show them twice and leave them out of date when the facts change.
 */
const COUNT = String.raw`(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)`;
const STRUCTURED_FACT: RegExp[] = [
  new RegExp(String.raw`^(?:studio(?:\s+(?:flat|apartment))?|${COUNT}[\s-]*(?:double\s+|single\s+)?(?:bed(?:room)?s?|bath(?:room)?s?|shower\s*rooms?|reception(?:\s*rooms?)?))$`, 'i'),
  /^(?:approx(?:imately|\.)?\s*)?[\d,.]+\s*(?:m²|m2|sq\.?\s*m|square\s+met(?:re|er)s?)(?:\s*\(\s*(?:approx(?:imately|\.)?\s*)?[\d,.]+\s*(?:sq\.?\s*ft|square\s+feet)\s*\))?$/i,
  /^(?:approx(?:imately|\.)?\s*)?[\d,.]+\s*(?:sq\.?\s*ft|square\s+feet)$/i,
  /^(?:freehold|leasehold|share\s+of\s+(?:the\s+)?freehold)(?:[,\s]+(?:with\s+)?\d{1,4}\s+years?\s+(?:remaining|left)(?:\s+on\s+the\s+lease)?)?$/i,
  /^(?:epc|energy\s+(?:rating|performance))(?:\s*(?:rating|band|grade))?\s*[:-]?\s*[A-G]$/i,
  /^council\s+tax\s*(?:band)?\s*[:-]?\s*(?:[A-I]|exempt)$/i,
];
export const repeatsStructuredFact = (line: string) => {
  const s = line.trim().replace(/^[-•*\s]+/, '').replace(/[.;]+$/, '').trim();
  return !!s && STRUCTURED_FACT.some((re) => re.test(s));
};
/**
 * Key-feature lines worth adding to the listing's features: not ones that repeat bedrooms, bathrooms, floor area,
 * tenure, EPC or council tax (the listing shows those from the facts, and copies would go out of date).
 */
export function featuresToAdd(lines: string[], structured: string[] = []): string[] {
  const skip = new Set(structured.map((x) => x.trim().toLowerCase()));
  return lines.map((l) => l.replace(/^[-•*\s]+/, '').trim().slice(0, 60)).filter((l) => l && !skip.has(l.toLowerCase()) && !repeatsStructuredFact(l));
}

/* ---------- photo uploads in small batches ---------- */
/*
 * The live site runs on serverless functions that refuse request bodies over about 6 MB (less once binary is
 * encoded), so the listing form sends photos a few at a time, each request well under that.
 */
export const UPLOAD_BATCH_BYTES = 3.5 * 1024 * 1024;
export const UPLOAD_BATCH_FILES = 4;

/** Bytes in a base64 data URL. */
export function dataUrlBytes(u: string): number {
  const b64 = u.slice(u.indexOf(',') + 1);
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
}

/** Splits files (by size) into consecutive batches of at most maxFiles and maxBytes (a single larger file goes alone). Returns indexes. */
export function sizeBatches(sizes: number[], maxBytes = UPLOAD_BATCH_BYTES, maxFiles = UPLOAD_BATCH_FILES): number[][] {
  const out: number[][] = [];
  let cur: number[] = [], bytes = 0;
  sizes.forEach((n, i) => {
    if (cur.length && (cur.length >= maxFiles || bytes + n > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(i); bytes += n;
  });
  if (cur.length) out.push(cur);
  return out;
}

/* ---------- points from the pre-submission check ---------- */
export type CheckSeverity = 'block' | 'warn' | 'tip';
/**
 * A point from the pre-submission check: from the rule-based checks, the wording rules or the AI. enforced: a
 * rule-based "must fix" that also stops publishing (the AI's own points are advice, enforced: false).
 */
export interface CheckPoint { severity: CheckSeverity; source: 'checks' | 'wording' | 'ai'; enforced?: boolean }
export const SEVERITY_LABEL: Record<CheckSeverity, string> = { block: 'Must fix', warn: 'Check', tip: 'Tip' };
/** Whether a point stops publishing (older servers don't say: then only rule-based points do). */
export const isEnforced = (i: CheckPoint) => i.severity === 'block' && (i.enforced ?? i.source !== 'ai');
/** "Must fix" only for points that really stop publishing; the AI's serious points are a "Likely problem". */
export const severityLabel = (i: CheckPoint) => (i.severity === 'block' && !isEnforced(i) ? 'Likely problem' : SEVERITY_LABEL[i.severity]);
export const severityClass = (i: CheckPoint) => (i.severity === 'block' && !isEnforced(i) ? 'likely' : i.severity);

export function complianceChecks(i: ListingInput, o: { minPhotos?: number } = {}): Check[] {
  // Everything a lister writes that the public may see, including the town and the address line.
  const text = [i.title ?? '', i.description ?? '', i.features.join('\n'), i.town ?? '', i.addressLine ?? ''].join('\n');
  const photos = i.photos?.length ?? 0;
  const c: Check[] = [
    { id: 'price', ok: i.price > 0, severity: 'block', message: i.listing === 'rent' ? 'State the monthly rent.' : 'State the asking price.' },
    { id: 'postcode', ok: POSTCODE_RE.test(i.postcode), severity: 'block', message: 'Enter a full UK postcode (e.g. E17 4QH).' },
    { id: 'tenure', ok: !!i.tenure, severity: 'block', message: 'Tenure is required material information.' },
    { id: 'lease', ok: i.tenure !== 'leasehold' || (i.leaseYears ?? 0) > 0, severity: 'block', message: 'Leasehold: state the remaining lease length, service charge and ground rent.' },
    { id: 'charges', ok: i.tenure !== 'leasehold' || i.serviceChargeAnnual != null, severity: 'warn', message: 'Leasehold: add the annual service charge (material information).' },
    { id: 'ctax', ok: !!i.councilTax && i.councilTax !== 'Not stated', severity: 'block', message: 'Council tax band is required material information.' },
    { id: 'epc', ok: !!i.epc, severity: 'block', message: 'An EPC is legally required before marketing. Add the rating (and upload the certificate).' },
    { id: 'epc-let', ok: i.listing !== 'rent' || !i.epc || i.epc.toUpperCase() <= 'E', severity: 'block', message: 'Rented homes in England & Wales must have EPC E or better (unless a registered exemption applies).' },
    ...(o.minPhotos ? [{ id: 'photo-min', ok: photos >= o.minPhotos, severity: 'block' as const, message: o.minPhotos === 1 ? 'Add at least one photo.' : `Add at least ${o.minPhotos} photos.` }] : []),
    { id: 'photos', ok: photos >= 3, severity: 'warn', message: 'Listings with 3+ photos get far more engagement. Virtually staged images must be labelled.' },
    { id: 'discrim', ok: !isDiscriminatory(text), severity: 'block', message: 'Remove discriminatory wording (e.g. “No DSS”, “no children”) — unlawful in rental adverts.' },
    { id: 'bidding', ok: i.listing !== 'rent' || !BIDDING.test(text), severity: 'block', message: 'Rental adverts must state a fixed rent; inviting bids above it is prohibited.' },
    { id: 'fees', ok: i.listing !== 'rent' || !TENANT_FEES.test(text), severity: 'block', message: 'Remove mentions of tenant fees (such as admin or referencing fees): most letting fees are banned under the Tenant Fees Act 2019.' },
    { id: 'contact', ok: contactDetails(text).length === 0, severity: 'warn', message: 'Remove phone numbers, email addresses, web links and messaging apps: people contact you through Streetkey, which keeps your details private.' },
    { id: 'payment', ok: paymentRequests(text).length === 0, severity: 'warn', message: 'Don’t ask for money before a viewing or by bank transfer: listings that do are held for a closer review.' },
    { id: 'scam', ok: scamPhrases(text).length === 0, severity: 'warn', message: 'Offer viewings in person. Listings that say the owner is abroad, offer no viewings or post the keys look like a common scam and are held for review.' },
  ];
  return c;
}

/* ---------- 3. extract a listing pasted from another website ---------- */
export interface Extracted { fields: Partial<ListingInput> & { sourceSite?: string }; found: string[]; missing: string[] }

const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
/*
 * Bedroom and bathroom counts, read the way people write them: "3 bedrooms 2 bathrooms" (counts before the
 * words), "BEDROOMS ×2 BATHROOMS ×1" or "Bedrooms 3 Bathrooms 2" (labels before their values), "Bedrooms: 3",
 * or a label with its value on the next line (how portals lay out their key facts).
 * Counts and room words that follow one another on a line form a run, and the run's shape decides how they pair:
 * a run that starts with a count pairs each count with the word after it; a run that starts with a word and its
 * value pairs each word with the count after it. A labelled value wins over a phrase.
 */
type RoomWord = 'bed' | 'bath' | 'reception';
interface RoomTok { kind: 'count' | 'room'; start: number; end: number; n: number; room: RoomWord; plural: boolean }
const ROOM_TOKEN = new Unless(String.raw`(\d{1,2}|one|two|three|four|five|six)(?:\b|(?=bed|bath))|\b(double|single)\b|(bed|bath)(room)?(s)?\b|\b(reception)(?:[ \t]+room)?(s)?\b`, 'gi', (t, at, m) => {
  const before = t.charAt(at - 1);
  // A count starts its word (not "a12", "1.5" or "2x3"), or follows a standalone "x" ("BEDROOMS x2").
  if (m[1]) return /[\w.]/.test(before) && !(/x/i.test(before) && !/\w/.test(t.charAt(at - 2)));
  // "bed" and "bath" start a word or follow a digit ("3bed"), so not "sunbed" or "birdbath".
  return !!m[3] && /[a-z_]/i.test(before);
});
/** A count straight before its room word: "3 bedrooms", "3-bed", "2 double bedrooms". */
const PHRASE_GAP = /^[ \t]*[-–]?[ \t]*$/;
/** A room word and its value with a mark between ("Bedrooms: 3", "BEDROOMS ×2", "Beds - 3"), even across a line break. */
const MARKED_GAP = /^\s*(?::|×|x|-|–)\s*$/i;
const BARE_GAP = /^[ \t]+$/;
const NEXT_LINE_GAP = /^[ \t]*\n[ \t]*$/;
/** A measurement after a room label, not a count of rooms ("Bedroom: 3.4m x 2.9m", "Bedroom 12' x 10'"). */
const MEASUREMENT = /^(?:[.,]\d|[ \t]*(?:m\b|m²|m2\b|metres?\b|meters?\b|ft\b|feet\b|foot\b|cm\b|mm\b|sq\b|['’"″′]|(?:x|×|by)[ \t]*\d))/i;
/** Room numbers in a list after an unmarked label ("bedrooms 2 and 3 are doubles"), not a count. */
const NUMBERED = /^[ \t]*(?:,[ \t]*\d|(?:and|&|or|to)[ \t]+\d|(?:is|are|has|have|of)\b)/i;

/** `t` keeps its line breaks: a count on one line never belongs to a room word on another unless a mark joins them. */
function roomCounts(t: string): Record<'bed' | 'bath', number | undefined> {
  const toks: RoomTok[] = [];
  let size: { start: number; end: number } | null = null; // "double"/"single" just before a room word
  for (const m of t.matchAll(ROOM_TOKEN)) {
    const start = m.index ?? 0, end = start + m[0].length;
    if (m[2]) { size = { start, end }; continue; }
    if (m[1]) toks.push({ kind: 'count', start, end, n: COUNT_WORDS[m[1].toLowerCase()] ?? Number(m[1]), room: 'bed', plural: false });
    else {
      const from = size && BARE_GAP.test(t.slice(size.end, start)) ? size.start : start; // "2 double bedrooms" is still a phrase
      toks.push({ kind: 'room', start: from, end, n: 0, room: (m[3]?.toLowerCase() ?? 'reception') as RoomWord, plural: !!(m[5] || m[7]) });
    }
    size = null;
  }
  const link = (a: RoomTok, b: RoomTok): 'phrase' | 'bare' | 'marked' | null => {
    const gap = t.slice(a.end, b.start);
    if (a.kind === 'count' && b.kind === 'room') return PHRASE_GAP.test(gap) ? 'phrase' : null;
    if (a.kind === 'room' && b.kind === 'count') {
      if (MARKED_GAP.test(gap)) return 'marked';
      if (BARE_GAP.test(gap)) return 'bare';
      if (NEXT_LINE_GAP.test(gap) && /^[ \t]*(?:\n|$)/.test(t.slice(b.end))) return 'marked'; // "Bedrooms" / "3" on the next line
    }
    return null;
  };
  const labelled: Partial<Record<RoomWord, number>> = {}, phrased: Partial<Record<RoomWord, number>> = {};
  for (let i = 0; i < toks.length;) {
    const run = [toks[i]], links: string[] = [];
    while (i + run.length < toks.length) {
      const l = link(run[run.length - 1], toks[i + run.length]);
      if (!l) break;
      links.push(l); run.push(toks[i + run.length]);
    }
    i += run.length;
    // Word first and either marked ("Bedrooms: 3 …") or an even word-count-word-count run → labels. Otherwise each
    // count goes with the word after it ("3 bed 2 bath", and "Double bedroom 2 bathrooms" leaves the first word alone).
    const labels = run[0].kind === 'room' && run.length > 1 && (links[0] === 'marked' || run.length % 2 === 0);
    for (let k = !labels && run[0].kind === 'room' ? 1 : 0; k + 1 < run.length; k += 2) {
      const word = labels ? run[k] : run[k + 1], count = labels ? run[k + 1] : run[k];
      if (word.room === 'reception') continue;
      if (!labels) { phrased[word.room] ??= count.n; continue; }
      // An unmarked label needs the plural ("Bedrooms 3"): "Bedroom 1" names a room rather than counting them.
      const after = t.slice(count.end);
      const value = !MEASUREMENT.test(after) && (links[k] === 'marked' || (word.plural && !NUMBERED.test(after)));
      if (value) labelled[word.room] ??= count.n;
    }
  }
  return { bed: labelled.bed ?? phrased.bed, bath: labelled.bath ?? phrased.bath };
}

/*
 * Tenure: a labelled value ("Tenure: Leasehold", or "TENURE" with the value on the next line) first, then phrases
 * that aren't ruled out. A negation counts only straight before the phrase ("no share of freehold", "not a
 * leasehold") or straight after it ("share of freehold option not available", "freehold: n/a"), so "No onward
 * chain / Leasehold" and "Leasehold, parking not available" still read as leasehold.
 */
const NOT_BEFORE = endsWith(String.raw`\b(?:no|not|without|isn['’]t|aren['’]t|non)(?:[\s-]+(?:a|an|the|any|longer|currently))*[\s-]+`);
const SHARE_OF = endsWith(String.raw`\bshare\s+of\s+(?:the\s+)?`);
const NOT_AFTER = /^[ \t]*[:–-]?[ \t]*(?:(?:option|basis|title|interest|purchase|is|are|currently)[ \t]+){0,3}(?:not[ \t]+(?:available|included|offered|applicable|possible)|n\/a|unavailable)\b/i;
const TENURE_PHRASES: [RegExp, NonNullable<Property['tenure']>][] = [
  [new Unless(String.raw`\bshare\s+of\s+(?:the\s+)?freehold\b`, 'gi', NOT_BEFORE), 'share-of-freehold'],
  [new Unless(String.raw`\bleasehold\b`, 'gi', NOT_BEFORE), 'leasehold'],
  // Plain "freehold", not the end of "share of freehold".
  [new Unless(String.raw`\bfreehold\b`, 'gi', (t, at) => NOT_BEFORE(t, at) || SHARE_OF(t, at)), 'freehold'],
];
function tenureOf(t: string): Property['tenure'] | undefined {
  const label = /\btenure\s*(?::|-|–)?\s*(share\s+of\s+(?:the\s+)?freehold|freehold|leasehold)\b/i.exec(t);
  if (label) return /share/i.test(label[1]) ? 'share-of-freehold' : (label[1].toLowerCase() as 'freehold' | 'leasehold');
  for (const [re, value] of TENURE_PHRASES) {
    for (const m of t.matchAll(re)) {
      const end = (m.index ?? 0) + m[0].length;
      if (!NOT_AFTER.test(t.slice(end, end + 60))) return value;
    }
  }
  return undefined;
}
export function extractListing(text: string, url = ''): Extracted {
  const t = text.replace(/\s+/g, ' ');
  // Room counts and tenure are read line by line (labels and values often sit on their own lines).
  const lines = text.replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ');
  const f: Extracted['fields'] = { features: [] };
  const found: string[] = [];
  try { if (url) f.sourceSite = new URL(url).hostname.replace(/^www\./, ''); } catch { /* not a URL */ }
  const rent = t.match(/£\s?([\d,]+)\s?(pcm|per month|p\/m|pw|per week|p\/w)/i);
  const price = t.match(/(?:£|GBP\s?)([\d,]{4,})(?!\s?(pcm|per month|pw|per week))/i);
  if (rent) { const v = Number(rent[1].replace(/,/g, '')); f.listing = 'rent'; f.price = /w/i.test(rent[2]) ? Math.round((v * 52) / 12) : v; found.push('rent'); }
  else if (price) { f.listing = 'sale'; f.price = Number(price[1].replace(/,/g, '')); found.push('price'); }
  const rooms = roomCounts(lines);
  if (rooms.bed != null) { f.beds = rooms.bed; found.push('bedrooms'); } else if (/\bstudio\b/i.test(t)) { f.beds = 0; found.push('bedrooms'); }
  if (rooms.bath != null) { f.baths = rooms.bath; found.push('bathrooms'); }
  const pc = t.match(POSTCODE_RE); if (pc) { f.postcode = `${pc[1].toUpperCase()} ${pc[2].toUpperCase()}`; found.push('postcode'); }
  const sqft = t.match(/([\d,]{3,5})\s?(sq\.?\s?ft|sqft|square feet)/i);
  const sqm = t.match(/([\d,.]{2,5})\s?(sq\.?\s?m|m²|m2|square met)/i);
  if (sqm) { f.floorArea = Math.round(Number(sqm[1].replace(/,/g, ''))); found.push('floor area'); }
  else if (sqft) { f.floorArea = Math.round(Number(sqft[1].replace(/,/g, '')) * 0.0929); found.push('floor area'); }
  const type = /semi[- ]detached/i.test(t) ? 'semi-detached' : /\bdetached\b/i.test(t) ? 'detached' : /terrace/i.test(t) ? 'terraced' : /bungalow/i.test(t) ? 'bungalow' : /\b(flat|apartment|maisonette|studio)\b/i.test(t) ? 'flat' : undefined;
  if (type) { f.type = type; found.push('property type'); }
  const tenure = tenureOf(lines);
  if (tenure) { f.tenure = tenure; found.push('tenure'); }
  const lease = t.match(/(\d{2,3})\s*years?\s*(remaining|left|on the lease)/i); if (lease) { f.leaseYears = Number(lease[1]); found.push('lease length'); }
  const epc = t.match(/EPC(?:\s*rating)?\s*[:\-]?\s*([A-G])\b/i); if (epc) { f.epc = epc[1].toUpperCase(); found.push('EPC'); }
  const ct = t.match(/council tax(?:\s*band)?\s*[:\-]?\s*([A-H])\b/i); if (ct) { f.councilTax = ct[1].toUpperCase(); found.push('council tax'); }
  const sc = t.match(/service charge[^£]{0,20}£\s?([\d,]+)/i); if (sc) { f.serviceChargeAnnual = Number(sc[1].replace(/,/g, '')); found.push('service charge'); }
  for (const feat of ['garden', 'parking', 'garage', 'balcony', 'chain free', 'loft', 'cellar', 'period features', 'needs modernisation', 'extension']) if (new RegExp(feat, 'i').test(t)) f.features!.push(feat.replace(/^./, (c) => c.toUpperCase()));
  if (/needs? (modernis|updating|work|refurb)|in need of|renovation project|probate/i.test(t)) f.condition = 'poor';
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 8 && l.length < 120 && !/£/.test(l));
  if (first) f.title = first;
  const required = ['price', 'bedrooms', 'postcode', 'property type', 'tenure'];
  return { fields: f, found, missing: required.filter((r) => !found.includes(r) && !(r === 'price' && found.includes('rent'))) };
}

/* ---------- 4. BLM v3 bulk listing feed (exported by UK agency CRMs) ---------- */
const BLM_TYPE: Record<string, PropertyType> = { '1': 'terraced', '2': 'terraced', '3': 'semi-detached', '4': 'detached', '5': 'terraced', '7': 'flat', '8': 'flat', '9': 'flat', '10': 'flat', '11': 'flat', '12': 'bungalow', '13': 'bungalow', '14': 'bungalow', '15': 'bungalow', '28': 'flat' };
const BLM_TENURE: Record<string, Property['tenure']> = { '1': 'freehold', '2': 'leasehold', '4': 'leasehold', '5': 'share-of-freehold' };

export interface FeedReport {
  accepted: Property[];
  /** The facts exactly as supplied (no defaults filled in), keyed by the agent's own reference — what a server stores. */
  inputs: (ListingInput & { ref: string })[];
  rejected: { ref: string; reason: string }[]; fields: number; version: string;
}

export function parseBLM(raw: string, agentName: string): FeedReport {
  const header = raw.match(/#HEADER#([\s\S]*?)#DEFINITION#/i)?.[1] ?? '';
  const eof = header.match(/EOF\s*:\s*'(.)'/i)?.[1] ?? '^';
  const eor = header.match(/EOR\s*:\s*'(.)'/i)?.[1] ?? '~';
  const version = header.match(/Version\s*:\s*([\d.]+)/i)?.[1] ?? 'unknown';
  const defBlock = raw.match(/#DEFINITION#([\s\S]*?)#DATA#/i)?.[1] ?? '';
  const fields = defBlock.split(eor)[0].trim().split(eof).map((x) => x.trim()).filter(Boolean);
  const dataBlock = raw.match(/#DATA#([\s\S]*?)#END#/i)?.[1] ?? '';
  const rows = dataBlock.split(eor).map((r) => r.trim()).filter(Boolean);
  const accepted: Property[] = []; const inputs: FeedReport['inputs'] = []; const rejected: FeedReport['rejected'] = [];
  for (const r of rows) {
    const row = r.endsWith(eof) ? r.slice(0, -1) : r;
    const vals = row.split(eof);
    const rec: Record<string, string> = Object.fromEntries(fields.map((f, k) => [f, (vals[k] ?? '').trim()]));
    const ref = rec.AGENT_REF || '(no ref)';
    if (vals.length !== fields.length) { rejected.push({ ref, reason: `Expected ${fields.length} fields, got ${vals.length}` }); continue; }
    if (rec.STATUS_ID && rec.STATUS_ID !== '0' && rec.STATUS_ID !== '1') { rejected.push({ ref, reason: `Status ${rec.STATUS_ID} is not available/under offer — skipped` }); continue; }
    const postcode = `${rec.POSTCODE1 ?? ''} ${rec.POSTCODE2 ?? ''}`.trim();
    const price = Number(rec.PRICE);
    if (!POSTCODE_RE.test(postcode)) { rejected.push({ ref, reason: 'Missing or invalid postcode' }); continue; }
    if (!price) { rejected.push({ ref, reason: 'Missing price' }); continue; }
    const lettings = rec.TRANS_TYPE_ID === '2';
    const features = Object.keys(rec).filter((k) => /^FEATURE\d+$/.test(k)).map((k) => rec[k]).filter(Boolean);
    const all = `${rec.SUMMARY ?? ''} ${rec.DESCRIPTION ?? ''} ${features.join(' ')}`;
    const ex = extractListing(all);
    const media = Object.keys(rec).filter((k) => /^MEDIA_IMAGE_\d+$/.test(k)).sort().map((k) => rec[k]).filter((v) => /^https:\/\//i.test(v));
    const input: ListingInput = {
      id: `feed-${agentName.toLowerCase().replace(/[^a-z]+/g, '-')}-${ref.toLowerCase()}`,
      listing: lettings ? 'rent' : 'sale', title: rec.SUMMARY?.slice(0, 90),
      addressLine: [rec.ADDRESS_1, rec.ADDRESS_2].filter(Boolean).join(' '), town: rec.TOWN || rec.ADDRESS_3 || 'Unknown', postcode,
      type: BLM_TYPE[rec.PROP_SUB_ID] ?? ex.fields.type ?? 'terraced', tenure: BLM_TENURE[rec.TENURE_TYPE_ID] ?? ex.fields.tenure ?? 'freehold',
      leaseYears: ex.fields.leaseYears, beds: Number(rec.BEDROOMS) || 0, baths: Number(rec.BATHROOMS) || 1, floorArea: ex.fields.floorArea ?? 0,
      condition: ex.fields.condition, price, epc: ex.fields.epc, councilTax: ex.fields.councilTax, serviceChargeAnnual: ex.fields.serviceChargeAnnual,
      features, description: rec.DESCRIPTION, photos: media.length ? media : undefined,
      source: { kind: 'agent-feed', name: `${agentName} (agent feed)`, licence: 'Displayed under agent feed agreement; agent retains ownership', verified: true },
      status: rec.STATUS_ID === '1' ? 'under offer' : 'live',
    };
    inputs.push({ ...input, ref });
    accepted.push(buildListing(input));
  }
  return { accepted, inputs, rejected, fields: fields.length, version };
}

/* ---------- 5. merge the same home from several sources ---------- */
const keyOf = (p: Property) => `${p.postcode.replace(/\s/g, '')}|${p.street.toLowerCase().replace(/\(fictional\)|[^a-z]/g, '').slice(0, 10)}|${p.beds}|${p.listing}`;
export function dedupe(list: Property[]): { merged: Property[]; duplicates: { kept: string; dropped: string }[] } {
  const map = new Map<string, Property>(); const duplicates: { kept: string; dropped: string }[] = [];
  for (const p of list) {
    const k = keyOf(p); const existing = map.get(k);
    if (existing && Math.abs(existing.price - p.price) / existing.price <= 0.05) {
      // Keep the first-seen record unless a verified agent feed replaces an unverified owner post.
      const keepNew = existing.source?.kind === 'owner' && p.source?.verified;
      const [keep, drop] = keepNew ? [p, existing] : [existing, p];
      keep.alsoListedBy = [...new Set([...(keep.alsoListedBy ?? []), drop.source?.name ?? drop.agent])];
      map.set(k, keep); duplicates.push({ kept: keep.id, dropped: drop.id });
    } else map.set(existing ? `${k}#${p.id}` : k, p);
  }
  return { merged: [...map.values()], duplicates };
}

/* ---------- 6. "Search everywhere" — deep links (we link out; we don't copy) ---------- */
export function externalSearchLinks(place: string, mode: 'sale' | 'rent') {
  const slug = place.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const title = place.trim().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\s+/g, '-');
  if (!slug) return [];
  return [
    { site: 'Rightmove', url: `https://www.rightmove.co.uk/${mode === 'rent' ? 'property-to-rent' : 'property-for-sale'}/${title}.html` },
    { site: 'Zoopla', url: `https://www.zoopla.co.uk/${mode === 'rent' ? 'to-rent' : 'for-sale'}/property/${slug}/` },
    { site: 'OnTheMarket', url: `https://www.onthemarket.com/${mode === 'rent' ? 'to-rent' : 'for-sale'}/property/${slug}/` },
  ];
}
