/**
 * Wording rules for listing text, enforced in code after the model writes (and used to review
 * a seller's own description). UK context: Consumer Protection from Unfair Trading Regulations
 * 2008 / DMCC Act 2024 (no misleading or unverifiable claims, no pressure selling), NTS material
 * information, Equality Act 2010 (no discrimination or steering), Tenant Fees Act 2019 and the
 * Renters' Rights Act (fixed rent, no bidding, no blanket bans).
 *
 * Every rule here removes or flags whole sentences; nothing is rewritten silently.
 */
import { numbersIn, sqft, statedMoney, statedNumbers, type Facts } from './facts';

export type Reason =
  | 'price' | 'figure' | 'schools' | 'transport' | 'area' | 'amenities' | 'planning' | 'investment'
  | 'superlative' | 'discrimination' | 'bidding' | 'fees' | 'pets' | 'mismatch' | 'unstated';

/** Friendly explanations shown to the seller (one per reason). */
export const REASON_TEXT: Record<Reason, string> = {
  price: 'Removed a sentence with a price that isn’t your stated price.',
  figure: 'Removed a detail with a figure that isn’t in your listing details. If it’s accurate, add it to your notes.',
  schools: 'Removed a claim about local schools that isn’t in your details. Add it to your notes if you want it included, and check it’s accurate.',
  transport: 'Removed a claim about transport links that isn’t in your details.',
  area: 'Removed a claim about the neighbourhood or neighbours. Describe the home itself instead.',
  amenities: 'Removed a claim about nearby shops, parks or amenities that isn’t in your details.',
  planning: 'Removed a planning or extension claim. Only mention planning potential you can evidence.',
  investment: 'Removed an investment claim (yield, demand or returns) that isn’t supported by your details.',
  superlative: 'Removed an unverifiable or pressure claim (such as “best in the area” or “won’t last”). Claims in property adverts must be accurate under consumer protection law.',
  discrimination: 'Removed wording that could discriminate or steer people (such as “ideal for professionals” or “no DSS”). Describe the home, not who should live there.',
  bidding: 'Removed bidding language: a rental advert must state one fixed rent.',
  fees: 'Removed a mention of tenant fees: most letting fees are banned under the Tenant Fees Act 2019.',
  pets: 'Removed a blanket “no pets” line: tenants can ask to keep a pet and landlords must not unreasonably refuse.',
  mismatch: 'Removed a detail that didn’t match your listing (for example the EPC rating, council tax band, tenure or bedrooms).',
  unstated: 'Removed a detail that isn’t in your listing details (such as which way the garden faces). Add it to your notes if it’s accurate.',
};

/** Topics the model may only mention when the seller's own facts or notes do. */
const TOPICS = {
  schools: /\b(schools?|ofsted|catchment|nurser(y|ies)|academ(y|ies)|sixth[- ]form|colleges?|universit(y|ies)|campus)\b/i,
  transport: /\b(stations?|tube|underground|overground|railway|rail (links?|services?)|trains?|bus(es)?|bus (routes?|stops?|links?)|trams?|metro|DLR|elizabeth line|motorways?|airports?|commut(e|es|ing|ers?)|transport links?|ring road|cycle (routes?|paths?)|junction \d+)\b/i,
  area: /\b(neighbou?rs?|neighbou?rhoods?|communit(y|ies)|crime|safe (area|street|road|neighbou?rhood|location)|up[- ]and[- ]coming|sought[- ]after|desirable (area|location|street|road|neighbou?rhood|postcode|address)|family[- ]friendly (area|street|road|neighbou?rhood|community|location)|quiet (street|road|cul[- ]de[- ]sac|area|neighbou?rhood|location|residential)|leafy|prestigious|exclusive (area|location|address|street|road))\b/i,
  amenities: /\b(shops|shopping|high street|caf[eé]s?|restaurants?|pubs?|supermarkets?|parks?|parkland|green spaces?|amenities|gyms?|leisure (centre|facilities)|hospitals?|GP surgery|doctors'? surgery|town centre|city centre|village centre|seafront|beach|riverside|marina|countryside walks|walking distance|minutes'? walk|stone'?s throw|moments from|on the doorstep|within easy reach)\b/i,
  planning: /\b(planning permission|permitted development|STPP|subject to planning|planning consent|scope to extend|potential to extend|could be extended|extension potential|loft conversion potential|potential for (a |an )?(loft|extension|conversion)|development potential|building plot)\b/i,
  investment: /\b(yields?|rental (income|demand|returns?)|returns? on investment|ROI|cash ?flow|capital growth|capital appreciation|strong demand|high demand|investment opportunity|buy[- ]to[- ]let investors?)\b/i,
  unstated: /\b((north|south|east|west|north[- ]east|north[- ]west|south[- ]east|south[- ]west)[- ]facing|(sea|river|park|city|countryside|panoramic) views?)\b/i,
} as const;
const ROAD = /\b[AM]\d{1,4}\b/; // road numbers are case-sensitive (A406, M25)
type Topic = keyof typeof TOPICS;

const SUPERLATIVE = [
  /\b(best|cheapest|finest|biggest|largest|nicest|most (sought[- ]after|desirable|popular|exclusive)) (home |house |flat |property )?(in|on|of) (the )?(area|street|road|market|town|city|village|postcode|region|country|uk|london)\b/i,
  /\b(unbeatable|unrivall?ed|unparall?eled|second to none|like no other|nothing else like it|one of a kind|guaranteed (rent|rental|income|returns?|sale|yield|growth)|risk[- ]free|once[- ]in[- ]a[- ]lifetime|won'?t last( long)?|will not last|act (fast|now|quickly)|hurry|don'?t miss (out|this)|priced to sell|bargain|below market value|under[- ]?valued|best value|value for money|rare opportunity|rarely available|must be sold|offers? (are )?invited quickly)\b/i,
];
const DISCRIMINATION = [
  /\b(no|not suitable for|unsuitable for|sorry,? no|not accepting|we do not accept|cannot accept) (dss|benefits?|housing benefits?|universal credit|children|kids|famil(y|ies)|students|foreigners|immigrants|refugees|asylum seekers|disabled( people)?|pensioners|sharers|couples|smokers or children)\b/i,
  /\bDSS\b/,
  /\b(professionals?|working (people|professionals?|tenants?|persons?)|white|black|asian|british|english|christians?|muslims?|jewish|hindus?|sikhs?|single (people|persons?|females?|males?)|females?|males?|ladies|gentlemen|men|women|young (people|professionals?)|mature (people|persons?|professionals?)|non[- ]students?|employed (people|persons?|tenants?)) (only|preferred|wanted|required|sought)\b/i,
  /\b(would (ideally )?suit|ideal for|perfect for|suitable for|suited to|great for|tailor[- ]made for|aimed at) (a |an |the )?(young |single |retired |professional |working |growing |small |large |mature |elderly )*(professionals?|couples?|famil(y|ies)|retirees|pensioners|students|singles?|single (person|people)|bachelors?|newlyweds|men|women|ladies|gentlemen|christians?|muslims?|elderly (people|persons?)|young (people|persons?))\b/i,
  /\b(english|british) (speakers?|nationals?|citizens?) only\b/i,
];
const BIDDING = /\b(offers? (over|in excess of|above|in the region of)|o\.?i\.?r\.?o\.?|o\.?i\.?e\.?o\.?|best offers?|bids?|bidding|highest (offer|bidder)|sealed bids?|guide price|rent (is )?negotiable|or nearest offer|o\.?n\.?o\.?|open to offers|offers invited)\b/i;
const FEES = /\b(admin(istration)? fees?|referencing fees?|check[- ](in|out) fees?|inventory fees?|(tenancy )?set[- ]up fees?|renewal fees?|agency fees?|application fees?|credit check fees?)\b/i;
const PETS = /\b(no pets|pets not (allowed|permitted|accepted)|strictly no (pets|animals))\b/i;

const WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// The property-size forms only ("three-bedroom house", "3-bed"): "two double bedrooms and a single" describes a subset.
const BEDS_RE = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[- ]bed(room)?\b(?![- ]?s\b|rooms)/gi;
const BATHS_RE = /\b(\d+|one|two|three|four|five|six)[- ]bath(room)?\b(?![- ]?s\b|rooms)/gi;
const COUNT_ADJ = '(?:(?:double|single|twin|king[- ]size|good[- ]sized|generous|large|spacious|further|more|other|separate|family)[- ]+)?';
// ("bedrooms" only: "two single beds" is furniture.)
const BEDS_PLURAL_RE = new RegExp(`\\b(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)[- ]+${COUNT_ADJ}bedrooms\\b`, 'gi');
const BATHS_PLURAL_RE = new RegExp(`\\b(\\d+|one|two|three|four|five|six)[- ]+${COUNT_ADJ}(?:bathrooms|shower rooms)\\b`, 'gi');

export interface RuleContext {
  facts: Facts;
  /** Seller-supplied text that may unlock topics and figures (notes, features, photo insights). */
  sources: string[];
}

/** Topics the seller's own details mention (so the model may mention them too). */
function allowedTopics(ctx: RuleContext): Set<Topic> {
  const text = [...ctx.sources, ...ctx.facts.features, ctx.facts.title ?? ''].join(' \n ');
  const allowed = new Set<Topic>();
  for (const t of Object.keys(TOPICS) as Topic[]) if (TOPICS[t].test(text)) allowed.add(t);
  if (ROAD.test(text)) allowed.add('transport');
  if (/\bloft potential\b|\bextension\b/i.test(text)) allowed.add('planning');
  if (/\bclose to station\b/i.test(text)) allowed.add('transport');
  return allowed;
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function placeless(s: string, f: Facts) {
  let out = s;
  for (const name of [f.town, ...(f.town ?? '').split(/,\s*/), f.district, f.postcode?.split(/\s+/)[0]]) {
    const n = name?.trim();
    if (n && n.length >= 2) out = out.replace(new RegExp(`\\b${escapeRe(n)}\\b`, 'gi'), ' ');
  }
  return out;
}

/** Relative tolerance (unit conversions such as m² to sq ft only, never prices). */
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * tol);
/** A plain figure that is one of the stated ones: exact, or a whole number the stated value rounds to (92.4 m² written as 92). */
const sameNumber = (n: number, x: number) => Math.abs(n - x) < 1e-6 || (Number.isInteger(n) && Math.round(x) === n);

export interface Money { amount: number; unit: '' | 'k' | 'm' | 'bn'; decimals: number }

/** £ amounts in text, with how they were written (handles £525,000, £525k, £1.2m, 525,000 pounds, GBP 500). */
export function moneyMatchesIn(text: string): Money[] {
  const out: Money[] = [];
  const re = /(?:£|GBP\s?)\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k|m|million|thousand|bn)?\b|(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k|m|million|thousand)?\s?(pounds|GBP)\b/gi;
  for (const m of text.matchAll(re)) {
    const raw = (m[1] ?? m[3]).replace(/,/g, '');
    const word = (m[2] ?? m[4] ?? '').toLowerCase();
    const unit: Money['unit'] = word === 'k' || word === 'thousand' ? 'k' : word === 'm' || word === 'million' ? 'm' : word === 'bn' ? 'bn' : '';
    const n = Number(raw) * (unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : unit === 'bn' ? 1e9 : 1);
    if (Number.isFinite(n)) out.push({ amount: Math.round(n * 100) / 100, unit, decimals: raw.split('.')[1]?.length ?? 0 });
  }
  return out;
}
/** £ amounts in text, as numbers. */
export const moneyIn = (text: string): number[] => moneyMatchesIn(text).map((m) => m.amount);

/**
 * Whether a £ amount, as written, is exactly `stated` (£525,000 or £525k for 525,000; pennies may be dropped).
 * The only rounding allowed is a millions figure written with decimals, to its last written digit
 * (£1.2m for £1,200,000 or £1,195,000). Anything else, however close (£527,500 for £525,000), is a different price.
 */
export function isStated(m: Money, stated: number): boolean {
  if (Math.abs(m.amount - stated) < 0.005) return true;
  if (!m.unit && Number.isInteger(m.amount) && (m.amount === Math.trunc(stated) || m.amount === Math.round(stated))) return true; // pennies left off
  if ((m.unit === 'm' || m.unit === 'bn') && m.decimals >= 1) {
    const step = (m.unit === 'm' ? 1e6 : 1e9) / 10 ** m.decimals;
    return Math.abs(Math.round(stated / step) * step - m.amount) < 1;
  }
  return false;
}

/** Why a sentence breaks the rules (null if it's fine). */
export function sentenceProblem(sentence: string, ctx: RuleContext, allowed = allowedTopics(ctx)): Reason | null {
  const f = ctx.facts;
  const s = sentence;
  for (const re of DISCRIMINATION) if (re.test(s)) return 'discrimination';
  if (f.channel === 'rent') {
    if (BIDDING.test(s)) return 'bidding';
    if (FEES.test(s)) return 'fees';
    if (PETS.test(s)) return 'pets';
  }
  for (const re of SUPERLATIVE) if (re.test(s)) return 'superlative';
  // Prices: only the stated price (and stated charges) may appear.
  const money = statedMoney(f);
  if (moneyMatchesIn(s).some((a) => !money.some((m) => isStated(a, m)))) return 'price';
  // Facts the text must not contradict (checked before other figures, so "a 4-bed house" for a 3-bed listing is a
  // mismatch, which the pre-submission check also flags in the seller's own text, not just an unstated figure).
  const epc = s.match(/\bEPC\b[^.]{0,20}?\b(?:rating|band|grade)?\s*(?:of\s+)?([A-G])\b(?![a-z])/);
  if (epc && f.epc && epc[1] !== f.epc) return 'mismatch';
  const ct = s.match(/\bcouncil tax\b[^.]{0,12}?\bband\s+([A-I])\b(?![a-z])/i);
  if (ct && f.councilTax && ct[1].toUpperCase() !== f.councilTax) return 'mismatch';
  // (Share-of-freehold homes also have a lease, so only plain freehold/leasehold are compared.)
  if (f.tenure === 'freehold' && /\bleasehold\b/i.test(s) && !/\bnot leasehold\b/i.test(s)) return 'mismatch';
  if (f.tenure === 'leasehold' && /\b(?<!share of (the )?)freehold\b/i.test(s)) return 'mismatch';
  for (const m of s.matchAll(BEDS_RE)) { const n = WORDS[m[1].toLowerCase()] ?? Number(m[1]); if (Number.isFinite(n) && n !== f.beds) return 'mismatch'; }
  for (const m of s.matchAll(BATHS_RE)) { const n = WORDS[m[1].toLowerCase()] ?? Number(m[1]); if (Number.isFinite(n) && n !== f.baths) return 'mismatch'; }
  // Plural counts ("four bedrooms", "two double bedrooms") may describe some of the rooms, but never more than the listing has.
  for (const m of s.matchAll(BEDS_PLURAL_RE)) { const n = WORDS[m[1].toLowerCase()] ?? Number(m[1]); if (Number.isFinite(n) && n > f.beds) return 'mismatch'; }
  for (const m of s.matchAll(BATHS_PLURAL_RE)) { const n = WORDS[m[1].toLowerCase()] ?? Number(m[1]); if (Number.isFinite(n) && n > f.baths) return 'mismatch'; }
  // Other figures: only those in the facts or the seller's own text (floor area in sq ft is allowed).
  const nums = statedNumbers(f, ctx.sources);
  const sqftN = f.floorArea ? sqft(f.floorArea) : null;
  const stripped = s.replace(/(?:£|GBP\s?)\s?\d[\d,]*(?:\.\d+)?\s?(k|m|million|thousand|bn)?\b/gi, ' ');
  for (const n of numbersIn(stripped)) {
    if (nums.some((x) => sameNumber(n, x))) continue;
    if (sqftN && near(n, sqftN, 0.015)) continue;
    return 'figure';
  }
  // Claims the seller hasn't made (place names are taken out first: "Finsbury Park" is a town, not a park).
  const claims = placeless(s, f);
  for (const t of Object.keys(TOPICS) as Topic[]) if (!allowed.has(t) && TOPICS[t].test(claims)) return t;
  if (!allowed.has('transport') && ROAD.test(claims)) return 'transport';
  return null;
}

/** Splits text into sentences, keeping paragraph breaks. */
export function sentences(paragraph: string): string[] {
  return paragraph.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9£“"‘'(])/).map((x) => x.trim()).filter(Boolean);
}

export interface Cleaned { text: string; removed: { sentence: string; reason: Reason }[] }

/** Removes sentences that break the rules from multi-paragraph text. */
export function cleanText(text: string, ctx: RuleContext): Cleaned {
  const allowed = allowedTopics(ctx);
  const removed: Cleaned['removed'] = [];
  const paras = text.replace(/\r/g, '').split(/\n\s*\n/).map((p) => {
    const kept = sentences(p).filter((s) => {
      const r = sentenceProblem(s, ctx, allowed);
      if (r) removed.push({ sentence: s, reason: r });
      return !r;
    });
    return kept.join(' ');
  }).filter(Boolean);
  return { text: paras.join('\n\n'), removed };
}

/** Keeps the short lines (headline, bullets) that pass the rules. */
export function cleanLines(lines: string[], ctx: RuleContext): { kept: string[]; removed: Cleaned['removed'] } {
  const allowed = allowedTopics(ctx);
  const removed: Cleaned['removed'] = [];
  const kept = lines.filter((l) => {
    const r = sentenceProblem(l, ctx, allowed);
    if (r) removed.push({ sentence: l, reason: r });
    return !r;
  });
  return { kept, removed };
}

/** Problems in a seller's own text (nothing removed), for the pre-submission check. */
export function reviewText(text: string, ctx: RuleContext): { sentence: string; reason: Reason }[] {
  const allowed = allowedTopics(ctx);
  const out: { sentence: string; reason: Reason }[] = [];
  for (const p of text.replace(/\r/g, '').split(/\n+/)) for (const s of sentences(p)) {
    const r = sentenceProblem(s, ctx, allowed);
    // The seller's own claims about schools, transport and amenities are theirs to make; flag only legal and accuracy risks.
    if (r && !['schools', 'transport', 'amenities', 'area', 'figure', 'unstated'].includes(r)) out.push({ sentence: s, reason: r });
  }
  return out;
}

/** Wording in the seller's notes that we deliberately left out. */
export function notesProblems(notes: string, facts: Facts): Reason[] {
  const out = new Set<Reason>();
  const money = statedMoney(facts);
  for (const p of notes.split(/\n+/)) for (const s of sentences(p)) {
    for (const re of DISCRIMINATION) if (re.test(s)) out.add('discrimination');
    if (facts.channel === 'rent' && BIDDING.test(s)) out.add('bidding');
    if (facts.channel === 'rent' && FEES.test(s)) out.add('fees');
    if (facts.channel === 'rent' && PETS.test(s)) out.add('pets');
    for (const re of SUPERLATIVE) if (re.test(s)) out.add('superlative');
    if (moneyMatchesIn(s).some((a) => !money.some((m) => isStated(a, m)))) out.add('price');
  }
  return [...out];
}

export const wordCount = (s: string) => (s.match(/[A-Za-z0-9£][\w'’£,.-]*/g) ?? []).length;

/** Trims to a maximum length at a word boundary (no trailing punctuation fragments). */
export function clip(s: string, max: number) {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : t.slice(0, max)).replace(/[\s,;:–-]+$/, '');
}
