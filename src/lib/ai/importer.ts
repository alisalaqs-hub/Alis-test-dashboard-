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
import { complianceChecks, extractListing, type Extracted, type ListingInput } from '../../engine/listings';

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

interface Money { amount: number; before: string; after: string; period: Period | null }
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
    if (Number.isFinite(amount)) out.push({ amount, before: t.slice(Math.max(0, at - 48), at), after, period: periodAfter(after) });
  }
  return out;
}
const SALE_WORDS = /\b(for sale|guide price|asking price|offers (over|in excess of|in the region of|around)|o\.?i\.?r\.?o|o\.?i\.?e\.?o|freehold|share of freehold|stamp duty|no onward chain|chain[- ]free)\b/i;
const LET_WORDS = /\b(to let|to rent|for rent|available to (rent|let)|let agreed|tenancy agreement|holding deposit|security deposit)\b/i;

/** The asking price or rent (pcm), skipping service charges, ground rent, deposits, fees and old prices. */
function priceOf(money: Money[], text: string): { listing: 'sale' | 'rent'; price: number } | null {
  const real = money.filter((m) => !notPriceBefore(m.before));
  const rent = real.find((m) => (m.period === 'month' || m.period === 'week') && m.amount >= 50 && m.amount <= 100_000);
  const sale = real.find((m) => m.period === null && m.amount >= 1000);
  const clearlyForSale = !!sale && sale.amount >= 20_000 && SALE_WORDS.test(text) && !LET_WORDS.test(text);
  if (rent && !clearlyForSale) return { listing: 'rent', price: rent.period === 'week' ? Math.round((rent.amount * 52) / 12) : Math.round(rent.amount) };
  if (sale) return { listing: 'sale', price: Math.round(sale.amount) };
  return null;
}
/** An annual charge (converted from its written period in code), or undefined. */
function chargeOf(money: Money[], keys: string, max: number): number | undefined {
  const m = money.find((x) => keyBefore(x.before, keys));
  if (!m) return undefined;
  const annual = Math.round(m.amount * (m.period ? PER_YEAR[m.period] : 1));
  return annual >= 0 && annual <= max ? annual : undefined;
}

/**
 * The built-in reader (src/engine/listings.ts extractListing) with the money corrected: a "£100 per
 * month" service charge isn't read as the rent, charges keep their period, and ground rent is read.
 */
export function ruleReading(text: string, url = ''): ImportValues {
  const ex = extractListing(text, /^https?:\/\//i.test(url.trim()) ? url.trim() : '');
  const v: ImportValues = { ...ex.fields, features: ex.fields.features ?? [] };
  const money = moneyIn(text);
  const p = priceOf(money, text);
  if (p) { v.listing = p.listing; v.price = p.price; } else { delete v.listing; delete v.price; }
  const sc = chargeOf(money, 'service charges?', 60_000);
  if (sc !== undefined) v.serviceChargeAnnual = sc; else delete v.serviceChargeAnnual;
  const gr = chargeOf(money, 'ground rents?', 20_000) ?? (RE.peppercorn.test(text) ? 0 : undefined);
  if (gr !== undefined) v.groundRentAnnual = gr;
  return v;
}

/* ───────────── red flags (rules) ───────────── */
export function ruleFlags(v: ImportValues, text: string): RedFlag[] {
  const flags: RedFlag[] = [];
  const add = (id: string, severity: Severity, title: string, detail: string, evidence: string | null = null) => flags.push({ id, severity, title, detail, evidence, source: 'rules' });
  const rent = v.listing === 'rent';
  const lease = v.tenure === 'leasehold';

  if (!has(v.epc)) add('no-epc', 'medium', 'No EPC rating stated', 'An Energy Performance Certificate is needed before a home is marketed. Ask for the rating and the certificate: it affects running costs and, for a let, whether it can legally be rented.');
  else if (rent && ['F', 'G'].includes(String(v.epc))) add('epc-let', 'high', `EPC ${v.epc} for a home to let`, 'Homes in England and Wales generally can’t be let with an EPC below E unless a valid exemption is registered. Ask the agent to confirm.');
  else if (['F', 'G'].includes(String(v.epc))) add('epc-low', 'low', `Low EPC rating (${v.epc})`, 'Expect higher energy bills, and improvement work would be needed before it could be let.');

  if (!has(v.tenure)) add('tenure-missing', 'medium', 'Tenure not stated', 'Freehold or leasehold makes a big difference to costs and rights, and it’s required information. Ask the agent.');
  if (lease && !has(v.leaseYears)) add('lease-unknown', 'high', 'Lease length not stated', 'Ask how many years are left. Leases under about 80 years usually cost more to extend, and some lenders won’t lend on short leases.');
  else if (lease && Number(v.leaseYears) < 80) add('short-lease', 'high', `Lease under 80 years (${v.leaseYears} years stated)`, 'Short leases usually cost more to extend and some lenders won’t lend on them. Get a lease extension quote and legal advice before you offer.', quote(text, new RegExp(`\\b${Number(v.leaseYears)}\\s*(years?|yrs?)`, 'i')));
  else if (lease && Number(v.leaseYears) < 100) add('lease-under-100', 'low', `Lease under 100 years (${v.leaseYears} years stated)`, 'Many lenders want a minimum unexpired term. Check what an extension would cost and how long it would take.');
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
  const values = ruleReading(text, url);
  const fields: ImportResult['fields'] = {};
  for (const k of ORDER) if (has(values[k as keyof ImportValues])) fields[k] = { confidence: k === 'condition' || k === 'listing' ? 'inferred' : 'stated', evidence: null, source: 'rules' };
  const redFlags = combineFlags(values, text);
  return { engine: 'rules', values, fields, found: foundOf(values), missing: missingOf(values), redFlags, questionsToAsk: combineQuestions(values, redFlags), note: null };
}
