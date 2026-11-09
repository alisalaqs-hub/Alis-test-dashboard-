/**
 * "Check any listing": shared types and rules for reading a listing someone has copied from
 * another website and pasted into Streetkey.
 *
 * Pure TypeScript (no browser, React or server APIs) so the website's offline fallback and the
 * server's safety net around the AI reader apply exactly the same rules. The AI only reads the
 * text; every red flag here is decided by these rules from the facts found, and the AI's own
 * flags are added only when they quote the listing.
 *
 * We never fetch other websites: only the text the person pasted is read.
 */
import { complianceChecks, extractListing, POSTCODE_RE, type Extracted, type ListingInput } from '../../engine/listings';

export type Confidence = 'stated' | 'inferred';
export type SaleMethod = 'private treaty' | 'auction' | 'modern method of auction' | 'tender';
export type FieldKey =
  | 'title' | 'listing' | 'price' | 'priceQualifier' | 'addressLine' | 'town' | 'postcode' | 'type' | 'tenure' | 'leaseYears'
  | 'beds' | 'baths' | 'floorArea' | 'era' | 'condition' | 'epc' | 'councilTax' | 'serviceChargeAnnual' | 'groundRentAnnual' | 'saleMethod';

/** Where a value came from: written in the text ("stated") or deduced ("inferred"), with a quote when there is one. */
export interface FieldInfo {
  confidence: Confidence; evidence: string | null; source: 'ai' | 'rules' | 'both';
  /** Streetkey AI read a different value from the built-in reader: the page shows it so the person can check and choose. */
  alt?: { value: string | number; evidence: string | null };
}
/** Editable listing facts (the same shape the built-in reader returns, plus a few extras). */
export type ImportValues = Extracted['fields'] & { priceQualifier?: string; saleMethod?: SaleMethod };
export type Severity = 'high' | 'medium' | 'low';
export interface RedFlag { id: string; severity: Severity; title: string; detail: string; evidence: string | null; source: 'rules' | 'ai' }

export interface ImportResult {
  /** 'ai' when Streetkey AI read the text (with the built-in reader as a safety net), 'rules' for the built-in reader alone. */
  engine: 'ai' | 'rules';
  values: ImportValues;
  fields: Partial<Record<FieldKey, FieldInfo>>;
  found: string[];
  missing: string[];
  redFlags: RedFlag[];
  questionsToAsk: string[];
  /** A short, honest note about how the text was read (e.g. the AI wasn't available). */
  note: string | null;
}

/* ───────────── labels ───────────── */
export const FIELD_LABEL: Record<FieldKey, string> = {
  title: 'title', listing: 'sale or rent', price: 'price', priceQualifier: 'price qualifier', addressLine: 'street', town: 'town',
  postcode: 'postcode', type: 'property type', tenure: 'tenure', leaseYears: 'lease length', beds: 'bedrooms', baths: 'bathrooms',
  floorArea: 'floor area', era: 'age', condition: 'condition', epc: 'EPC', councilTax: 'council tax', serviceChargeAnnual: 'service charge',
  groundRentAnnual: 'ground rent', saleMethod: 'sale method',
};
/** Choices for the age and condition the page lets people check (the refurbishment estimate uses them). */
export const ERA_OPTIONS: [NonNullable<ImportValues['era']>, string][] = [['pre-1919', 'Before 1919'], ['1919-1944', '1919 to 1944'], ['1945-1979', '1945 to 1979'], ['1980-1999', '1980 to 1999'], ['2000+', '2000 or later']];
export const CONDITION_OPTIONS: [NonNullable<ImportValues['condition']>, string][] = [['good', 'Good: ready to move in'], ['fair', 'Fair: some updating'], ['poor', 'Poor: needs modernising'], ['derelict', 'Derelict: major works']];
const ORDER: FieldKey[] = ['listing', 'price', 'priceQualifier', 'saleMethod', 'title', 'addressLine', 'town', 'postcode', 'type', 'tenure', 'leaseYears', 'beds', 'baths', 'floorArea', 'era', 'condition', 'epc', 'councilTax', 'serviceChargeAnnual', 'groundRentAnnual'];
const has = (v: unknown) => v !== undefined && v !== null && v !== '';

/** Facts found, as labels (price shows as "rent" for lettings, matching the built-in reader). */
export function foundOf(v: ImportValues): string[] {
  return ORDER.filter((k) => has(v[k as keyof ImportValues])).map((k) => (k === 'price' && v.listing === 'rent' ? 'rent' : FIELD_LABEL[k]));
}
/** Required facts that are still missing (the same list the built-in reader uses). */
export function missingOf(v: ImportValues): string[] {
  const out: string[] = [];
  if (!has(v.price)) out.push(v.listing === 'rent' ? 'rent' : 'price');
  if (!has(v.beds)) out.push('bedrooms');
  if (!has(v.postcode)) out.push('postcode');
  if (!has(v.type)) out.push('property type');
  if (!has(v.tenure)) out.push('tenure');
  return out;
}

/* ───────────── reading text ───────────── */
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
/**
 * Straight quotes and dashes, single spaces, line breaks kept (they separate facts on most listings).
 * Each character maps to one character, so positions found in a lower-cased copy are valid here.
 */
const prep = (s: string) => s.replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, (w) => (w.includes('\n') ? '\n' : ' ')).trim();
/** Lower-case `prep`: replacing its line breaks with spaces gives exactly validate.ts's `squash`. */
export const normText = (s: string) => prep(s).toLowerCase();

/** A short quote around the first match, so people can see what triggered a flag. */
function quote(text: string, re: RegExp): string | null {
  const t = tidy(text);
  const m = re.exec(t);
  return m ? quoteAt(t, m.index, m.index + m[0].length) : null;
}
function quoteAt(t: string, from: number, to: number): string {
  let start = Math.max(0, from - 30); while (start > 0 && !/\s/.test(t[start - 1])) start--;
  let end = Math.min(t.length, to + 30); while (end < t.length && !/\s/.test(t[end])) end++;
  return `${start > 0 ? '…' : ''}${tidy(t.slice(start, end))}${end < t.length ? '…' : ''}`.slice(0, 140);
}
/**
 * The line a value was read from ("Tenure: Leasehold. Length of lease: 68 years remaining"), or
 * about 40 characters either side of it on a long line: a short quote people can find in the listing.
 * `t` is `prep`ed text (line breaks kept).
 */
function lineQuote(t: string, from: number, to: number): string {
  const ls = t.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  let le = t.indexOf('\n', to); if (le < 0) le = t.length;
  const bullet = (s: string) => s.replace(/^[-•*·]\s*/, '');
  if (le - ls <= 100) return bullet(tidy(t.slice(ls, le)));
  let start = Math.max(ls, from - 40); while (start > ls && !/\s/.test(t[start - 1])) start--;
  let end = Math.min(le, to + 40); while (end < le && !/\s/.test(t[end])) end++;
  return `${start > ls ? '…' : ''}${bullet(tidy(t.slice(start, end)))}${end < le ? '…' : ''}`;
}
/** lineQuote around the first match of `re` in `prep`ed text, or null. */
function lineQuoteOf(t: string, re: RegExp): string | null {
  const m = new RegExp(re.source, re.flags.replace('g', '')).exec(t);
  return m ? lineQuote(t, m.index, m.index + m[0].length) : null;
}

const RE = {
  auction: /\b(auction|modern method of auction|reservation (fee|agreement)|legal pack|buyer['’]?s premium)\b/i,
  cashOnly: /\b(cash buyers? only|cash purchasers? only|cash purchase only|non[- ]mortgageable|unmortgageable)\b/i,
  construction: /\b(non[- ]standard construction|concrete (frame|construction|panel)|steel[- ]frame(d)?|timber[- ]frame(d)?|prefab(ricated)?|\bprc\b|mundic|wimpey no[- ]fines|airey house)\b/i,
  cladding: /\b(cladding|ews ?1|external wall system)\b/i,
  shared: /\b(shared ownership|\d{1,2}% share)\b/i,
  knotweed: /\bjapanese knotweed\b/i,
  probate: /\bprobate\b/i,
  flood: /\bflood(ed|ing)?\b/i,
  poa: /\b(poa|price on application)\b/i,
  fees: /\b(admin(istration)?|referencing|reference|set[- ]?up|check[- ]?out|inventory|renewal|tenancy agreement) fees?\b/i,
  deposit: /deposit[^£]{0,30}£\s?([\d,]{2,7})/i,
  peppercorn: /\b(peppercorn|no ground rent|nil ground rent|ground rent:? nil)\b/i,
};

/* ───────────── mentions that count (negation-aware) ───────────── */
export type MentionTopic = 'auction' | 'cashOnly' | 'construction' | 'cladding' | 'shared' | 'knotweed' | 'probate' | 'flood' | 'fees';
const MENTION: Record<MentionTopic, RegExp> = {
  auction: RE.auction, cashOnly: RE.cashOnly, construction: RE.construction, cladding: RE.cladding, shared: RE.shared,
  knotweed: RE.knotweed, probate: RE.probate, flood: RE.flood, fees: RE.fees,
};
/** Sentence and list breaks: a "no" before one of these doesn't reach past it. */
const BOUNDARY = /[.;!?•·|\n]|:\s|\s-\s/;
const NEG_BEFORE = /\b(no|not|never|without|zero|nil|none|free (of|from)|isn't|aren't|wasn't|won't|don't|doesn't|cannot|can't|excluding|exempt from)\b/i;
const NEG_AFTER = /^\s*(?:[:-]\s*)?(?:none|nil|n\/a|not applicable|not required|not needed|zero|£\s?0(?![\d.,]))(?![a-z])|^\s*[:-]\s*no(?![a-z])/i;

/**
 * Is the match at [from, to) negated? "No admin fees", "not subject to auction", "free of knotweed",
 * "No admin, referencing or check-out fees" and "Admin fees: none" are; "No onward chain, cash buyers only" isn't.
 */
function negatedAt(t: string, from: number, to: number): boolean {
  const sentence = t.slice(Math.max(0, from - 160), from).split(BOUNDARY).pop() ?? '';
  const parts = sentence.split(',');
  let scope = parts.pop() ?? '';
  let max = 4;
  if (parts.length && /\b(or|nor|and)\b/i.test(scope)) { scope = sentence; max = 8; } // a list after "no …, … or …"
  const words = scope.trim().split(/\s+/).filter(Boolean).slice(-max).join(' ');
  return NEG_BEFORE.test(words) || NEG_AFTER.test(t.slice(to, to + 24));
}
const LIGHT = /\b(light|sunlight|daylight|sunshine|sun|natural light)\b/i;
/** Look-alikes that aren't the risk: "flooded with light", "timber-framed windows", "probate granted". */
const LOOKALIKE: Partial<Record<MentionTopic, (t: string, from: number, to: number) => boolean>> = {
  flood: (t, from, to) => LIGHT.test(t.slice(from, to + 40).split(/[.;!?,•·|\n]/)[0]) || /(light|sun)[- ]?$/i.test(t.slice(Math.max(0, from - 8), from)),
  construction: (t, _from, to) => /^\s*(sash\s+|double[- ]glazed\s+)?(windows?|doors?|glazing|french doors|bi-?folds?|conservatory|garden (room|office|studio)|summer ?house|sheds?|outbuildings?|car ?ports?|garages?|pergolas?|gazebos?|staircases?|stairs|beams?)\b/i.test(t.slice(to, to + 40)),
  probate: (t, _from, to) => /^\s*(has been |had been |is |now |already |was )?(granted|obtained|completed?)\b/i.test(t.slice(to, to + 30)),
};
/** Cladding matters for flats and other multi-occupancy buildings, or when the listing mentions building safety. */
const CLADDING_RISK = /\b(ews ?1|remediation|fire (safety|risk)|external wall|acm|building safety)\b/i;

/**
 * The first real mention of a topic as a short quote, or null. Negated wording ("No admin fees",
 * "Not subject to auction") and look-alikes ("Flooded with natural light") don't count, and cladding
 * only counts for flats and leasehold homes unless the text mentions EWS1, remediation or fire safety.
 */
export function mention(text: string, topic: MentionTopic, v: ImportValues = {}): string | null {
  if (topic === 'cladding' && v.type !== 'flat' && v.tenure !== 'leasehold' && v.tenure !== 'share-of-freehold' && !CLADDING_RISK.test(text)) return null;
  const t = prep(text);
  for (const m of t.matchAll(new RegExp(MENTION[topic].source, 'gi'))) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    if (negatedAt(t, from, to) || LOOKALIKE[topic]?.(t, from, to)) continue;
    return quoteAt(t, from, to);
  }
  return null;
}
/** Topics whose words appear in a string at all (before any negation check). */
export const topicsIn = (s: string): MentionTopic[] => (Object.keys(MENTION) as MentionTopic[]).filter((k) => MENTION[k].test(s));

/* ───────────── money: prices, rents and charges with their periods ───────────── */
export type Period = 'week' | 'month' | 'quarter' | 'half-year' | 'year';
export const PER_YEAR: Record<Period, number> = { week: 52, month: 12, quarter: 4, 'half-year': 2, year: 1 };
const LEAD = String.raw`^\s*\(?\s*(?:(?:payable|paid|charged|currently|approx\.?|approximately|plus vat|\+\s?vat|inc\.? vat|including vat)\s+)*`;
const per = (alts: string) => new RegExp(`${LEAD}(?:${alts})(?![a-z])`, 'i');
const PERIODS: [Period, RegExp][] = [
  ['week', per(String.raw`pw|p\/w|p\.w\.?|pppw|per week|a week|weekly|per wk|\/\s?(?:week|wk|w)`)],
  ['month', per(String.raw`pcm|p\.c\.m\.?|p\/m|pm|per calendar month|per month|a month|monthly|per mth|\/\s?(?:month|mth|m|pcm)`)],
  ['quarter', per(String.raw`per quarter|a quarter|quarterly|\/\s?(?:quarter|qtr)`)],
  ['half-year', per(String.raw`per half[- ]?year|half[- ]?yearly|half[- ]?annually|bi-?annually|six[- ]?monthly|every six months`)],
  ['year', per(String.raw`per annum|p\.?\s?a\.?|per year|a year|per yr|yearly|annually|annual|\/\s?(?:year|yr|annum|a)`)],
];
/** The period written straight after an amount ("£1,200 per annum" → year), or null when none is written. */
export function periodAfter(after: string): Period | null {
  for (const [p, re] of PERIODS) if (re.test(after)) return p;
  return null;
}
/** Up to ~25 characters between a keyword and the amount, without crossing another amount or a sentence end. */
const GAP = String.raw`\b(?:[^£\n;.]|\.(?=\S)){0,25}$`;
const ABBREV = /\b(approx|est|inc|incl|excl|exc|c|ca|circa)\.\s/gi;
/** Does the text just before an amount end with one of these words ("Service charge: £…")? */
export const keyBefore = (before: string, keys: string) => new RegExp(`(?:${keys})${GAP}`, 'i').test(before.replace(ABBREV, '$1  '));
/** Money after these words is a charge, deposit, fee or old price, not the asking price or rent. */
const NOT_PRICE = String.raw`service charges?|ground rents?|deposit|council tax|(?:estate|management|maintenance|parking|permit|admin(?:istration)?|reservation|holding|tenancy|referencing|buyer'?s?) (?:charges?|fees?|premium|deposit)|buyer'?s premium|parking(?: space| permit)?|rental income|(?:currently|presently) (?:let|rented)(?: at| for)?|tenanted at|(?:achievable|estimated|potential|expected|passing) rent|reduced from|previously|was`;
export const notPriceBefore = (before: string) => keyBefore(before, NOT_PRICE);

interface Money { amount: number; before: string; after: string; period: Period | null; at: number; end: number }
function moneyIn(text: string): Money[] {
  const t = normText(text);
  const out: Money[] = [];
  for (const m of t.matchAll(/(?:£|gbp\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s?(k|m|million)(?![a-z²]))?/g)) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    const base = Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);
    const amount = base * (m[3] === 'k' ? 1000 : m[3] ? 1_000_000 : 1);
    const rest = t.slice(end, end + 48);
    const cut = rest.search(/£|\d/);
    const after = cut >= 0 ? rest.slice(0, cut) : rest;
    if (Number.isFinite(amount)) out.push({ amount, before: t.slice(Math.max(0, at - 48), at), after, period: periodAfter(after), at, end });
  }
  return out;
}
const SALE_WORDS = /\b(for sale|guide price|asking price|offers (over|in excess of|in the region of|around)|o\.?i\.?r\.?o|o\.?i\.?e\.?o|freehold|share of freehold|stamp duty|no onward chain|chain[- ]free)\b/i;
const LET_WORDS = /\b(to let|to rent|for rent|available to (rent|let)|let agreed|tenancy agreement|holding deposit|security deposit)\b/i;

/** The asking price or rent (pcm), skipping service charges, ground rent, deposits, fees and old prices. */
function priceOf(money: Money[], text: string): { listing: 'sale' | 'rent'; price: number; m: Money } | null {
  const real = money.filter((m) => !notPriceBefore(m.before));
  const rent = real.find((m) => (m.period === 'month' || m.period === 'week') && m.amount >= 50 && m.amount <= 100_000);
  const sale = real.find((m) => m.period === null && m.amount >= 1000);
  const clearlyForSale = !!sale && sale.amount >= 20_000 && SALE_WORDS.test(text) && !LET_WORDS.test(text);
  if (rent && !clearlyForSale) return { listing: 'rent', price: rent.period === 'week' ? Math.round((rent.amount * 52) / 12) : Math.round(rent.amount), m: rent };
  if (sale) return { listing: 'sale', price: Math.round(sale.amount), m: sale };
  return null;
}
/** An annual charge (converted from its written period in code), or undefined. */
function chargeOf(money: Money[], keys: string, max: number): { annual: number; m: Money } | undefined {
  const m = money.find((x) => keyBefore(x.before, keys));
  if (!m) return undefined;
  const annual = Math.round(m.amount * (m.period ? PER_YEAR[m.period] : 1));
  return annual >= 0 && annual <= max ? { annual, m } : undefined;
}

/* ───────────── facts read line by line, with labels first ───────────── */
type Tenure = NonNullable<ImportValues['tenure']>;
type Era = NonNullable<ImportValues['era']>;
type Condition = NonNullable<ImportValues['condition']>;
/** A value the built-in reader found, the words it found it in, and whether they state it or only point to it. */
export interface RuleFind<T> { value: T; evidence: string; confidence: Confidence }
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** Words after a mention that cancel it: "Share of freehold option not available". */
const CANCELLED_AFTER = /\b(not|unavailable|no longer|n\/a)\b/i;
const live = (t: string, from: number, to: number) => !negatedAt(t, from, to) && !CANCELLED_AFTER.test(t.slice(to, to + 40).split(/[.;!?•·|\n,()]/)[0]);

/**
 * Bedrooms or bathrooms. Labelled values come first ("BEDROOMS: x2", "Bathrooms ×1", or the label
 * on one line and "×1" on the next, as Rightmove pages copy); then "2 bedrooms" written on one line.
 * A number straight after "x"/"×" or another label ("BEDROOMS ×2 BATHROOMS ×1") belongs to that label.
 */
function countOf(t: string, kind: 'bed' | 'bath'): RuleFind<number> | null {
  const w = kind === 'bed' ? String.raw`bed(?:room)?s?` : String.raw`bath(?:room)?s?`;
  // Not a room size ("Bedroom: 3.5m x 3.0m"): the number isn't followed by a decimal or a unit.
  const notSize = String.raw`(?!\d|[.,]\d|\s?(?:m|ft|metres?|meters?|feet|'|")(?![a-z]))`;
  // A bare label counts when the next label follows on the same line ("BEDROOMS 2 BATHROOMS 1"), not before a room size.
  const nextLabel = String.raw`(?=[ \t]+(?:bed(?:room)?s?|bath(?:room)?s?|receptions?|size|tenure|epc|council|property type)\b)`;
  const labelled = new RegExp(String.raw`\b${w}\s*(?::\s*[x×]?|[x×])\s*(\d{1,2})${notSize}|\b${w}[ \t]*\n[ \t]*(\d{1,2})[ \t]*(?:\n|$)|\b${w}[ \t]+(\d{1,2})${nextLabel}`, 'i').exec(t);
  if (labelled) return { value: Number(labelled[1] ?? labelled[2] ?? labelled[3]), evidence: lineQuote(t, labelled.index, labelled.index + labelled[0].length), confidence: 'stated' };
  const words = Object.keys(WORD_NUM).join('|');
  const re = new RegExp(String.raw`\b(\d{1,2}|${words})[ \t-]*(?:(?:double|single|good[- ]sized|large)[ \t]+)?${w}\b`, 'gi');
  for (const m of t.matchAll(re)) {
    const at = m.index ?? 0;
    const lineBefore = t.slice(Math.max(0, at - 30), at).split('\n').pop() ?? '';
    if (/[x×]\s*$/i.test(lineBefore) || /\b(bed(room)?s?|bath(room)?s?|receptions?)\s*[:\-]?\s*$/i.test(lineBefore)) continue;
    const raw = m[1].toLowerCase();
    return { value: WORD_NUM[raw] ?? Number(raw), evidence: lineQuote(t, at, at + m[0].length), confidence: 'stated' };
  }
  if (kind === 'bed') { const s = /\bstudio\b/i.exec(t); if (s) return { value: 0, evidence: lineQuote(t, s.index, s.index + s[0].length), confidence: 'inferred' }; }
  return null;
}

const SOF = String.raw`share (?:of|in) (?:the )?freehold`;
/**
 * Tenure: a labelled value ("Tenure: Leasehold") wins; otherwise the first mention that isn't negated
 * or cancelled ("Share of freehold option not available" isn't share of freehold), share of freehold
 * before leasehold before freehold ("Leasehold with a share of the freehold" is share of freehold).
 */
export function tenureOf(text: string): RuleFind<Tenure> | null {
  const t = prep(text);
  const sof = (s: string, offset = 0) => { for (const m of s.matchAll(new RegExp(SOF, 'gi'))) { const at = offset + (m.index ?? 0); if (live(t, at, at + m[0].length)) return { at, end: at + m[0].length }; } return null; };
  const lab = new RegExp(String.raw`\btenure\b[ \t]*(?:[:\-]|\bis\b)?\s*(?:(${SOF})|(leasehold)|(freehold))\b`, 'i').exec(t);
  if (lab) {
    const end = lab.index + lab[0].length;
    const line = t.slice(end, end + 80).split('\n')[0];
    const alsoSof = lab[2] ? sof(line, end) : null; // "Tenure: Leasehold with a share of the freehold"
    const value: Tenure = lab[1] || alsoSof ? 'share-of-freehold' : lab[2] ? 'leasehold' : 'freehold';
    return { value, evidence: lineQuote(t, lab.index, alsoSof ? alsoSof.end : end), confidence: 'stated' };
  }
  const s = sof(t);
  if (s) return { value: 'share-of-freehold', evidence: lineQuote(t, s.at, s.end), confidence: 'stated' };
  const sofSpans = [...t.matchAll(new RegExp(SOF, 'gi'))].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  for (const [value, re] of [['leasehold', /\bleasehold\b/gi], ['freehold', /\bfreehold\b/gi]] as const) {
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0; const end = at + m[0].length;
      if (sofSpans.some(([a, b]) => at >= a && end <= b) || !live(t, at, end)) continue;
      return { value, evidence: lineQuote(t, at, end), confidence: 'stated' };
    }
  }
  return null;
}

const eraOfYear = (y: number): Era => (y < 1919 ? 'pre-1919' : y < 1945 ? '1919-1944' : y < 1980 ? '1945-1979' : y < 2000 ? '1980-1999' : '2000+');
const BUILDING = String.raw`(?:semi|semi-detached|detached|terrace|terraced|house|home|bungalow|flat|apartment|block|build|building|property|conversion|cottage|villa|maisonette|mansion block|purpose[- ]built)`;
/**
 * Age clues in a piece of text: a build year or "new build" state it; a period name (Victorian,
 * 1930s semi, post-war) points to it. Negated clues ("not a new build") don't count. `loose` adds
 * weaker hints such as "period features", for checking a reading rather than making one.
 */
export function eraClues(text: string, o: { loose?: boolean } = {}): RuleFind<Era>[] {
  const t = prep(text);
  const now = new Date().getFullYear();
  const out: (RuleFind<Era> & { at: number })[] = [];
  const add = (re: RegExp, value: (m: RegExpMatchArray) => Era | null, confidence: Confidence) => {
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0; const end = at + m[0].length;
      const v = value(m);
      if (v && !negatedAt(t, at, end)) out.push({ value: v, evidence: lineQuote(t, at, end), confidence, at });
    }
  };
  const year = (s: string) => { const y = Number(s); return y >= 1700 && y <= now + 3 ? eraOfYear(y) : null; };
  add(/\b(?:built|constructed|erected|dating from|dates from|dates back to)\b[^.;\n\d]{0,20}?\b((?:17|18|19|20)\d\d)\b/gi, (m) => year(m[1]), 'stated');
  add(/\b(new[- ]build|newly built|brand[- ]new (?:home|house|flat|apartment|development))\b/gi, () => '2000+', 'stated');
  add(new RegExp(String.raw`\b((?:18|19|20)\d0)'?s\s+${BUILDING}\b`, 'gi'), (m) => year(m[1]), 'inferred');
  add(/\b(victorian|edwardian|georgian|regency)\b/gi, () => 'pre-1919', 'inferred');
  add(/\b(inter[- ]?war|art deco)\b/gi, () => '1919-1944', 'inferred');
  add(/\bpost[- ]?war\b/gi, () => '1945-1979', 'inferred');
  add(/\bperiod (?:property|home|house|conversion|building|terrace|cottage)\b/gi, () => 'pre-1919', 'inferred');
  // Looser hints, only to support a reading someone will check ("period features" are also found in 1920s homes).
  if (o.loose) add(/\b(?:period|original) (?:features?|details?|character|fireplaces?|cornicing)\b|\bsash windows?\b/gi, () => 'pre-1919', 'inferred');
  return out.sort((a, b) => (a.confidence === b.confidence ? a.at - b.at : a.confidence === 'stated' ? -1 : 1)).map(({ at: _at, ...r }) => r);
}

const CONDITION_WORDS: [Condition, RegExp][] = [
  ['derelict', /\b(derelict|uninhabitable|fire[- ]damaged|shell condition|structural (?:repairs?|issues?|problems?|damage)|in need of (?:complete|total) (?:renovation|refurbishment|restoration))\b/gi],
  ['poor', /\b(?:requires?|needs?|needing|in need of|ripe for)\s+(?:(?:complete|full|extensive|total|general|major|significant)\s+)?(?:modernis|moderniz|updat|renovat|refurbish|restor|improvement|work|repair)\w*|\b(?:renovation|refurbishment|restoration|modernisation|improvement) (?:project|opportunity)\b|\bin poor (?:condition|repair)\b/gi],
  ['fair', /\b(?:requires?|needs?|needing|in need of)\s+(?:some|light|minor|cosmetic)\s+\w+|\b(?:could|would) benefit from\b|\b(?:scope|potential|room) (?:to|for) (?:improve|update|modernise|modernize|add value|improvement|updating)\w*|\bfair condition\b|\bdated\b/gi],
  ['good', /\b(?:well[- ]presented|immaculate(?:ly)?|beautifully (?:presented|refurbished|renovated)|(?:newly|recently|fully|completely|tastefully) (?:refurbished|renovated|modernised|modernized|updated|decorated|refitted)|refurbished to a high standard|excellent condition|good (?:condition|order)|move[- ]in ready|ready to move (?:in|into)|turn[- ]?key|show home)\b/gi],
];
/** Condition clues in a piece of text ("requires modernisation", "beautifully presented"), first one first. Negated ones don't count. */
export function conditionClues(text: string): RuleFind<Condition>[] {
  const t = prep(text);
  const out: (RuleFind<Condition> & { at: number })[] = [];
  for (const [value, re] of CONDITION_WORDS) for (const m of t.matchAll(re)) {
    const at = m.index ?? 0; const end = at + m[0].length;
    if (!negatedAt(t, at, end)) out.push({ value, evidence: lineQuote(t, at, end), confidence: 'inferred', at });
  }
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...r }) => r);
}

/** Where the built-in reader found each value, for the page to show next to it. */
export type RuleEvidence = Partial<Record<FieldKey, { quote: string; confidence: Confidence }>>;

/**
 * The built-in reader (src/engine/listings.ts extractListing) with the money corrected (a "£100 per
 * month" service charge isn't read as the rent, charges keep their period, ground rent is read),
 * tenure and room counts read with their labels and line breaks, the age and condition read from
 * clear wording, and the words each value was found in.
 */
export function ruleRead(text: string, url = ''): { values: ImportValues; evidence: RuleEvidence } {
  const ex = extractListing(text, /^https?:\/\//i.test(url.trim()) ? url.trim() : '');
  const v: ImportValues = { ...ex.fields, features: ex.fields.features ?? [] };
  const t = prep(text);
  const evidence: RuleEvidence = {};
  const note = (k: FieldKey, q: string | null, confidence: Confidence = 'stated') => { if (q) evidence[k] = { quote: q, confidence }; };
  const take = <K extends 'beds' | 'baths' | 'tenure' | 'era' | 'condition'>(k: K, f: RuleFind<NonNullable<ImportValues[K]>> | null | undefined) => {
    if (f) { (v as Record<string, unknown>)[k] = f.value; note(k, f.evidence, f.confidence); } else delete v[k];
  };

  const money = moneyIn(text);
  const p = priceOf(money, text);
  if (p) { v.listing = p.listing; v.price = p.price; note('price', lineQuote(t, p.m.at, p.m.end)); note('listing', lineQuote(t, p.m.at, p.m.end), 'inferred'); } else { delete v.listing; delete v.price; }
  const sc = chargeOf(money, 'service charges?', 60_000);
  if (sc) { v.serviceChargeAnnual = sc.annual; note('serviceChargeAnnual', lineQuote(t, sc.m.at, sc.m.end)); } else delete v.serviceChargeAnnual;
  const gr = chargeOf(money, 'ground rents?', 20_000);
  if (gr) { v.groundRentAnnual = gr.annual; note('groundRentAnnual', lineQuote(t, gr.m.at, gr.m.end)); }
  else if (RE.peppercorn.test(text)) { v.groundRentAnnual = 0; note('groundRentAnnual', lineQuoteOf(t, RE.peppercorn)); }

  take('beds', countOf(t, 'bed'));
  take('baths', countOf(t, 'bath'));
  take('tenure', tenureOf(text));
  take('era', eraClues(text)[0]);
  take('condition', conditionClues(text)[0]);

  if (v.title) note('title', v.title);
  if (v.postcode) note('postcode', lineQuoteOf(t, POSTCODE_RE));
  if (v.epc) note('epc', lineQuoteOf(t, /\bEPC(?:\s*rating)?\s*[:\-]?\s*[A-G]\b/i));
  if (v.councilTax) note('councilTax', lineQuoteOf(t, /council tax(?:\s*band)?\s*[:\-]?\s*[A-I]\b/i));
  if (v.leaseYears) note('leaseYears', lineQuoteOf(t, new RegExp(String.raw`\b${v.leaseYears}\s*years?\s*(remaining|left|on the lease)`, 'i')));
  if (v.floorArea) note('floorArea', lineQuoteOf(t, /[\d,.]{2,5}\s?(sq\.?\s?m|m²|m2|square met)/i) ?? lineQuoteOf(t, /[\d,]{3,5}\s?(sq\.?\s?ft|sqft|square feet)/i));
  if (v.type) {
    const words: Record<string, RegExp> = { 'semi-detached': /semi[- ]detached/i, detached: /\bdetached\b/i, terraced: /terrace/i, bungalow: /bungalow/i, flat: /\b(flat|apartment)\b/i };
    const stated = lineQuoteOf(t, words[v.type]);
    note('type', stated ?? lineQuoteOf(t, /\b(maisonette|studio)\b/i), stated ? 'stated' : 'inferred');
  }
  return { values: v, evidence };
}

/** The built-in reader's values (see ruleRead). */
export const ruleReading = (text: string, url = ''): ImportValues => ruleRead(text, url).values;

/* ───────────── red flags (rules) ───────────── */
export function ruleFlags(v: ImportValues, text: string): RedFlag[] {
  const flags: RedFlag[] = [];
  const add = (id: string, severity: Severity, title: string, detail: string, evidence: string | null = null) => flags.push({ id, severity, title, detail, evidence, source: 'rules' });
  const rent = v.listing === 'rent';
  const lease = v.tenure === 'leasehold';
  // A share of freehold usually comes with a lease too: once its length is known, the same lease checks apply.
  const leaseKnown = (lease || v.tenure === 'share-of-freehold') && has(v.leaseYears);

  if (!has(v.epc)) add('no-epc', 'medium', 'No EPC rating stated', 'An Energy Performance Certificate is needed before a home is marketed. Ask for the rating and the certificate: it affects running costs and, for a let, whether it can legally be rented.');
  else if (rent && ['F', 'G'].includes(String(v.epc))) add('epc-let', 'high', `EPC ${v.epc} for a home to let`, 'Homes in England and Wales generally can’t be let with an EPC below E unless a valid exemption is registered. Ask the agent to confirm.');
  else if (['F', 'G'].includes(String(v.epc))) add('epc-low', 'low', `Low EPC rating (${v.epc})`, 'Expect higher energy bills, and improvement work would be needed before it could be let.');

  if (!has(v.tenure)) add('tenure-missing', 'medium', 'Tenure not stated', 'Freehold or leasehold makes a big difference to costs and rights, and it’s required information. Ask the agent.');
  if (lease && !has(v.leaseYears)) add('lease-unknown', 'high', 'Lease length not stated', 'Ask how many years are left. Leases under about 80 years usually cost more to extend, and some lenders won’t lend on short leases.');
  else if (leaseKnown && Number(v.leaseYears) < 80) add('short-lease', 'high', `Lease under 80 years (${v.leaseYears} years stated)`, 'Short leases usually cost more to extend and some lenders won’t lend on them. Get a lease extension quote and legal advice before you offer.', quote(text, new RegExp(`\\b${Number(v.leaseYears)}\\s*(years?|yrs?)`, 'i')));
  else if (leaseKnown && Number(v.leaseYears) < 100) add('lease-under-100', 'low', `Lease under 100 years (${v.leaseYears} years stated)`, 'Many lenders want a minimum unexpired term. Check what an extension would cost and how long it would take.');
  // A charge written in the text ("Ground rent £250 pa") is never reported as "not stated", even if it was cleared on the page.
  if ((lease || v.tenure === 'share-of-freehold') && !has(v.serviceChargeAnnual) && !/service charges?[^.]{0,30}£\s?\d/i.test(text)) add('service-charge', 'medium', 'Service charge not stated', 'Service charges are required information for leasehold homes. Ask for the annual charge, what it covers and whether major works are planned.');
  if (lease && !has(v.groundRentAnnual) && !RE.peppercorn.test(text) && !/ground rents?[^.]{0,30}£\s?\d/i.test(text)) add('ground-rent', 'low', 'Ground rent not stated', 'Ask for the ground rent and how and when it can rise under the lease.');
  if (!has(v.councilTax)) add('council-tax', 'low', 'Council tax band not stated', 'The band is required information. You can also check it on the official council tax band checker.');

  // Mentions only count when they aren't negated ("not subject to auction", "no admin fees") or look-alikes ("flooded with light").
  const said = (topic: MentionTopic) => mention(text, topic, v);
  const auction = said('auction');
  if (v.saleMethod === 'auction' || v.saleMethod === 'modern method of auction' || auction) add('auction', 'high', 'Auction sale: check the legal pack and fees', 'Auction and “modern method of auction” sales can add buyer fees (such as reservation or admin fees) and fixed deadlines. Read the legal pack, get legal advice before bidding and add any fees to your costs.', auction);
  const cash = said('cashOnly'); if (cash) add('cash-only', 'medium', 'Cash buyers only', 'This often means lenders may not lend on it, for example because of construction, condition or the lease. Ask why before paying for surveys.', cash);
  const build = said('construction'); if (build) add('construction', 'medium', 'Non-standard construction mentioned', 'Some construction types are harder to mortgage and insure. Ask for details and consider a specialist survey.', build);
  const clad = said('cladding'); if (clad) add('cladding', 'medium', 'Cladding or EWS1 mentioned', 'Ask whether there is an EWS1 form or fire risk assessment, and whether any remediation costs could fall on leaseholders.', clad);
  const shared = said('shared'); if (shared) add('shared-ownership', 'medium', 'Shared ownership', 'You’d buy a share and pay rent on the rest. Check the rent, service charge, staircasing terms and any eligibility rules.', shared);
  const knot = said('knotweed'); if (knot) add('knotweed', 'medium', 'Japanese knotweed mentioned', 'Ask for the treatment plan and any insurance-backed guarantee; lenders usually ask about it.', knot);
  const probate = said('probate'); if (probate) add('probate', 'low', 'Probate sale', 'The sale may not be able to complete until probate is granted. Ask whether it has been.', probate);
  const flood = said('flood'); if (flood) add('flood', 'low', 'Flooding mentioned', 'Ask about any flood history and insurance, and check the long-term flood risk for the postcode.', flood);
  if (!has(v.price) && RE.poa.test(text)) add('poa', 'low', 'Price on application', 'No price is shown. Ask for it in writing before arranging a viewing.', quote(text, RE.poa));
  if (!has(v.floorArea)) add('floor-area', 'low', 'Floor area not stated', 'Ask for a measured floor plan: it’s the fairest way to compare the price per square metre.');

  if (rent) {
    const input: ListingInput = { listing: 'rent', addressLine: '', town: '', postcode: '', type: v.type ?? 'flat', tenure: v.tenure ?? 'freehold', beds: v.beds ?? 0, baths: v.baths ?? 1, floorArea: v.floorArea ?? 0, price: v.price ?? 0, features: v.features ?? [], description: text.slice(0, 20_000), title: v.title, source: { kind: 'external-link', name: '', licence: '', verified: false } };
    const checks = complianceChecks(input);
    if (checks.find((c) => c.id === 'bidding' && !c.ok)) add('rent-bidding', 'high', 'Invites offers above the rent', 'In England, landlords and agents must not invite or accept offers above the advertised rent. Treat this as a warning sign.', quote(text, /\b(offers? (over|in excess|above)|best offer|bids?|highest offer)\b/i));
    if (checks.find((c) => c.id === 'discrim' && !c.ok)) add('discriminatory', 'high', 'Possibly unlawful wording', 'Blanket bans such as “No DSS” or “no children” are unlawful for lettings in England. Ask the agent to confirm your application will be considered fairly.', quote(text, /\b(no (dss|benefits|housing benefit|universal credit)|professionals only|no children|no kids|no families|no students)\b/i));
    const fees = said('fees');
    if (fees) add('tenant-fees', 'high', 'Letting fees mentioned', 'The Tenant Fees Act 2019 bans most letting fees in England (Wales has similar rules). Apart from rent and a capped deposit, only a few payments are allowed. Ask what you’d be charged.', fees);
    const dep = RE.deposit.exec(text);
    if (dep && has(v.price)) {
      const deposit = Number(dep[1].replace(/,/g, ''));
      const weekly = (Number(v.price) * 12) / 52;
      const capWeeks = Number(v.price) * 12 >= 50_000 ? 6 : 5;
      if (deposit > Math.ceil(weekly * capWeeks)) add('deposit-cap', 'high', 'Deposit may be over the legal cap', `In England, tenancy deposits are capped at ${capWeeks} weeks’ rent. The deposit stated looks higher than that for the rent stated: ask the agent to confirm.`, quote(text, RE.deposit));
    }
  }
  return flags;
}

/* ───────────── questions to ask (rules) ───────────── */
const QUESTION: Record<string, string> = {
  'no-epc': 'What is the EPC rating, and can you send the certificate?',
  'epc-let': 'Is there a registered exemption that allows this home to be let with its current EPC?',
  'tenure-missing': 'Is the property freehold or leasehold?',
  'lease-unknown': 'How many years are left on the lease, and has the seller looked into extending it?',
  'short-lease': 'Has the seller started a lease extension, and would they complete it before the sale?',
  'lease-under-100': 'Has the seller looked into extending the lease, and what would it cost?',
  'service-charge': 'What is the annual service charge, what does it cover, and are any major works planned?',
  'ground-rent': 'What is the ground rent, and how and when can it increase?',
  'council-tax': 'Which council tax band is the property in?',
  auction: 'Can you send the legal pack, and what fees would the buyer pay on top of the price?',
  'cash-only': 'Why is this for cash buyers only? Has a lender turned it down?',
  construction: 'What is the construction type, and has anyone bought it with a mortgage recently?',
  cladding: 'Is there an EWS1 form or fire risk assessment, and are any remediation costs expected?',
  'shared-ownership': 'What share is for sale, what rent is paid on the rest, and what are the staircasing terms?',
  knotweed: 'Is there a treatment plan with an insurance-backed guarantee for the knotweed?',
  probate: 'Has probate been granted yet?',
  flood: 'Has the property ever flooded, and is buildings insurance available on normal terms?',
  poa: 'What is the asking price?',
  'floor-area': 'Can you send a floor plan with measurements?',
  'rent-bidding': 'Is the advertised rent the rent I’d pay, without any bidding?',
  'tenant-fees': 'Apart from rent and the deposit, what exactly would I be asked to pay?',
  'deposit-cap': 'How much is the deposit, and which deposit protection scheme will hold it?',
};
const GENERAL = { beds: 'How many bedrooms does it have?', postcode: 'What is the full postcode?', rent: 'When is it available, and what are the tenancy terms?', sale: 'How long has it been on the market, and is the seller in a chain?' };
export function ruleQuestions(v: ImportValues, flags: RedFlag[]): string[] {
  const out = flags.map((f) => QUESTION[f.id]).filter((q): q is string => !!q);
  if (!has(v.beds)) out.push(GENERAL.beds);
  if (!has(v.postcode)) out.push(GENERAL.postcode);
  out.push(v.listing === 'rent' ? GENERAL.rent : GENERAL.sale);
  return out;
}
const RULE_QUESTIONS = new Set([...Object.values(QUESTION), ...Object.values(GENERAL)]);
/** True for questions the rules write (so a page can re-derive them as facts are edited). */
export const isRuleQuestion = (q: string) => RULE_QUESTIONS.has(q);

/* ───────────── combining rules with the AI's own findings ───────────── */
/** Topics the rules already cover: an AI flag on the same topic is dropped (the rule's wording is checked). */
const TOPIC: Record<string, RegExp> = {
  'no-epc': /\bepc\b|energy (performance|rating)/i, 'epc-let': /\bepc\b/i, 'epc-low': /\bepc\b/i,
  'tenure-missing': /\btenure\b|freehold or leasehold/i, 'lease-unknown': /\blease\b/i, 'short-lease': /\blease\b/i, 'lease-under-100': /\blease\b/i,
  'service-charge': /service charge/i, 'ground-rent': /ground rent/i, 'council-tax': /council tax/i, auction: /auction|legal pack|reservation/i,
  'cash-only': /cash (buyer|purchase)|mortgageab/i, construction: /construction|timber|concrete|steel/i, cladding: /cladding|ews/i,
  'shared-ownership': /shared ownership/i, knotweed: /knotweed/i, probate: /probate/i, flood: /flood/i, poa: /price on application|\bpoa\b/i,
  'floor-area': /floor (area|plan)|square (feet|met)|sq ?(ft|m)/i, 'rent-bidding': /bid|offers? (over|above)/i, discriminatory: /dss|discriminat|no children|benefit/i,
  'tenant-fees': /fee/i, 'deposit-cap': /deposit/i,
};
/** Facts that, once known, make an AI "missing" flag about them wrong. */
const PRESENT: [RegExp, (v: ImportValues) => boolean][] = [
  [/\bepc\b|energy/i, (v) => has(v.epc)], [/\btenure\b/i, (v) => has(v.tenure)], [/\blease\b/i, (v) => has(v.leaseYears)],
  [/service charge/i, (v) => has(v.serviceChargeAnnual)], [/ground rent/i, (v) => has(v.groundRentAnnual)], [/council tax/i, (v) => has(v.councilTax)],
  [/floor (area|plan)|size/i, (v) => has(v.floorArea)], [/\bprice\b|\brent\b/i, (v) => has(v.price)], [/postcode/i, (v) => has(v.postcode)],
  [/bedroom/i, (v) => has(v.beds)],
];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Rule flags for the current facts plus the AI's extra flags that don't repeat a rule (or contradict
 * known facts), highest severity first. Used on the server and again in the browser as people edit.
 */
export function combineFlags(v: ImportValues, text: string, aiFlags: RedFlag[] = []): RedFlag[] {
  const rules = ruleFlags(v, text);
  const covered = rules.map((f) => TOPIC[f.id]).filter(Boolean);
  const extra = aiFlags.filter((f) => f.source === 'ai').filter((f) => {
    const about = `${f.title} ${f.detail}`;
    if (covered.some((re) => re.test(about))) return false;
    if (/not (stated|given|shown|provided|mentioned)|missing|no .* (stated|given)|unknown/i.test(about) && PRESENT.some(([re, present]) => re.test(f.title) && present(v))) return false;
    return true;
  });
  const seen = new Set<string>();
  return [...rules, ...extra]
    .filter((f) => { const k = norm(f.title); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** Rule questions first (they follow from the flags), then the AI's, without near-duplicates. */
export function combineQuestions(v: ImportValues, flags: RedFlag[], aiQuestions: string[] = [], max = 8): string[] {
  const out: string[] = [];
  const keys: string[] = [];
  for (const q of [...ruleQuestions(v, flags), ...aiQuestions]) {
    const t = tidy(q).slice(0, 160);
    if (t.length < 8) continue;
    const k = norm(t).split(' ').slice(0, 5).join(' ');
    if (keys.includes(k)) continue;
    keys.push(k); out.push(/[?]$/.test(t) ? t : `${t.replace(/[.!]+$/, '')}?`);
    if (out.length >= max) break;
  }
  return out;
}

/** The built-in reader on its own: what the site uses offline, and the server's fallback. */
export function rulesOnlyResult(text: string, url = ''): ImportResult {
  const { values, evidence } = ruleRead(text, url);
  const fields: ImportResult['fields'] = {};
  // "Stated" only with the words it was read from; anything the rules worked out, or can't quote, is "inferred".
  for (const k of ORDER) if (has(values[k as keyof ImportValues])) fields[k] = { confidence: evidence[k]?.confidence ?? 'inferred', evidence: evidence[k]?.quote ?? null, source: 'rules' };
  const redFlags = combineFlags(values, text);
  return { engine: 'rules', values, fields, found: foundOf(values), missing: missingOf(values), redFlags, questionsToAsk: combineQuestions(values, redFlags), note: null };
}
