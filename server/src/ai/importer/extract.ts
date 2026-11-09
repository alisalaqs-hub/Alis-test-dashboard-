/**
 * "Check any listing" AI reader: turns listing text a person pasted from another website into
 * structured facts with provenance (stated / inferred + a quote), then merges them with
 * Streetkey's rule-based reader as a safety net.
 *
 * Grounding:
 *  - Only the pasted text is read. The link is never visited (we don't scrape other websites).
 *  - Every value must be supported by its quote, and the quote must be in the text: an EPC needs
 *    "EPC … C", a number must be written in the quote with the right unit or period next to it
 *    ("721 sq ft" can't become 721 m²; "£1,200 per annum" can't become a price or a monthly charge),
 *    and money must belong to the right thing (a service charge isn't a price). Unsupported money,
 *    bands and lease lengths are dropped; other unsupported values become "inferred".
 *  - When the AI and the rule reader both find a value for a fact the rules read reliably and they
 *    disagree, the rule value is kept as "inferred" and the AI's is shown next to it to check.
 *  - Unit conversions (per week → per month, sq ft → m², quarterly → annual) happen in code.
 *  - Red flags come from shared rules (src/lib/ai/importer.ts); the AI's own flags are kept only
 *    when they quote the listing, or (for gaps) when they match a short list of material topics the
 *    text really doesn't mention, worded by Streetkey. Features must be written in the text, and
 *    nothing about who a home suits (schools, families, "young professionals"…) is added.
 */
import { createHash } from 'node:crypto';
import { normalisePostcode, POSTCODE_RE } from '../../../../src/engine/listings';
import {
  combineFlags, combineQuestions, foundOf, keyBefore, mention, missingOf, notPriceBefore, periodAfter, ruleReading, rulesOnlyResult, topicsIn,
  type Confidence, type FieldInfo, type FieldKey, type ImportResult, type ImportValues, type Period, type RedFlag, type SaleMethod,
} from '../../../../src/lib/ai/importer';
import { AiError, cached, chatJSON, HOUSE_RULES, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { bandIn, clean, contextsOf, groundedPhrase, LEGAL_CLAIM, noMoney, numberIn, numbersIn, quoteIn, steers } from './validate';

export const MAX_TEXT = 15_000;

const conf = S.enum(['stated', 'inferred'] as const, 'stated = written in the text; inferred = deduced from other clues in the text');
const evidence = S.nullable(S.str('A short exact quote from the listing (under 100 characters) that supports the value'));
const field = <T>(value: T, description?: string) => S.nullable(S.obj({ value, confidence: conf, evidence }), description);
const money = (periods: readonly string[]) => S.obj({ amount: S.num('Amount in pounds exactly as written'), period: S.enum(periods) });

export const ExtractSchema = S.obj({
  title: field(S.str('The listing headline')),
  listing: field(S.enum(['sale', 'rent'] as const)),
  price: field(money(['total', 'pcm', 'pw'] as const), 'Sale price (period total) or rent (pcm / pw), exactly as written, not converted'),
  priceQualifier: field(S.str('e.g. Guide price, Offers over, Offers in excess of, Fixed price')),
  addressLine: field(S.str('Street (and building name) as written')),
  town: field(S.str()),
  postcode: field(S.str('Full UK postcode, only if written')),
  type: field(S.enum(['terraced', 'semi-detached', 'detached', 'flat', 'bungalow'] as const)),
  tenure: field(S.enum(['freehold', 'leasehold', 'share-of-freehold'] as const)),
  leaseYears: field(S.int('Years remaining on the lease, only if written')),
  beds: field(S.int()),
  baths: field(S.int()),
  floorArea: field(S.obj({ amount: S.num(), unit: S.enum(['sqm', 'sqft'] as const) }), 'As written, not converted'),
  era: field(S.enum(['pre-1919', '1919-1944', '1945-1979', '1980-1999', '2000+'] as const)),
  condition: field(S.enum(['good', 'fair', 'poor', 'derelict'] as const)),
  epc: field(S.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const)),
  councilTax: field(S.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] as const)),
  serviceCharge: field(money(['year', 'half-year', 'quarter', 'month'] as const)),
  groundRent: field(money(['year', 'half-year', 'quarter', 'month'] as const)),
  saleMethod: field(S.enum(['private treaty', 'auction', 'modern method of auction', 'tender'] as const)),
  features: S.arr(S.str(), 'Up to 12 short features stated in the text'),
  redFlags: S.arr(S.obj({
    kind: S.enum(['stated', 'missing'] as const, 'stated = a concern written in the text; missing = important information not given'),
    severity: S.enum(['high', 'medium', 'low'] as const),
    title: S.str('Under 70 characters'),
    detail: S.str('One or two sentences on why it matters and what to check'),
    evidence,
  })),
  questionsToAsk: S.arr(S.str(), 'Up to 6 short, polite questions for the agent'),
});
export type Extraction = Infer<typeof ExtractSchema>;

const SYSTEM = [
  HOUSE_RULES,
  'You read UK property listings that a person copied from another website and pasted in, and turn them into structured facts so they can check the home before going further.',
  'Rules:',
  '- Extract only what the text says. Use confidence "stated" only when the value is written in the text, with a short exact quote as evidence that contains the value itself (for example "EPC rating: C", "721 sq ft", "Service charge £1,200 per annum"). Use "inferred" when you deduce it from a clue in the text (for example "maisonette" means a flat), and quote the clue.',
  '- If a fact isn’t in the text, return null. Never guess prices, rents, charges, lease lengths, sizes, EPC ratings or council tax bands.',
  '- Give money exactly as written with its period; give floor area with its unit. Do not convert or calculate.',
  '- features: short features written in the text (for example "Private garden", "Off-street parking"). Nothing about who the home suits, schools, safety or the neighbours.',
  '- redFlags: things a buyer or renter should check. Use "missing" for important information that isn’t given (for example parking, heating, broadband, utilities, chain, rights of way) and "stated" for concerns written in the text (auction terms or fees, a short lease, cash buyers only, non-standard construction, cladding, shared ownership, probate, Japanese knotweed, flooding, letting fees, inviting offers above the rent, discriminatory wording). Quote the text for "stated" flags. Don’t include figures that aren’t in the text, and don’t reach legal conclusions.',
  '- Read negations carefully: "no admin fees", "not subject to auction" and "flooded with natural light" are not concerns.',
  '- questionsToAsk: short, polite questions to fill the gaps or clear up the concerns.',
  '- Don’t describe who the home or area suits, and don’t comment on the people who live there.',
].join('\n');

type Raw = Extraction;
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 40);

/** Ask the model (cached by text, so the same paste isn't paid for twice). */
async function readWithAi(text: string, site: string | null, userId: string | null): Promise<Raw> {
  return cached(`import.extract:v2:${sha(`${site ?? ''}\n${text}`)}`, 6 * 3600, () => chatJSON<Raw>([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Website the person copied this from (for reference only; it has not been visited): ${site ?? 'not given'}\n\n${untrusted('listing', text, MAX_TEXT)}` },
  ], ExtractSchema, 'listing_extract', { purpose: 'import.extract', userId, role: 'fast', maxTokens: 3000 }));
}

/* ───────────── what a quote must say ───────────── */
type Cand<T> = { value: T; confidence: Confidence; evidence: string | null } | null;
/** yes = the quote states it; weak = consistent with the quote but not stated outright (→ inferred); no = not supported. */
type Support = 'yes' | 'weak' | 'no';
const yes = (b: boolean): Support => (b ? 'yes' : 'no');
const PERIOD_FACTOR: Record<string, number> = { year: 1, 'half-year': 2, quarter: 4, month: 12 };
const PRICE_PERIOD: Record<'total' | 'pcm' | 'pw', Period | null> = { total: null, pcm: 'month', pw: 'week' };
const inRange = (n: number, lo: number, hi: number) => Number.isFinite(n) && n >= lo && n <= hi;

const LISTING_WORDS = {
  rent: /\b(to (let|rent)|for rent|let|letting|rent(al)?|pcm|per (calendar )?month|pw|per week|tenancy)\b/i,
  sale: /\b(for sale|sale|guide price|asking price|offers|price|freehold|leasehold|auction)\b/i,
};
const TYPE_WORDS: Record<NonNullable<ImportValues['type']>, RegExp> = {
  terraced: /terrace/i, 'semi-detached': /semi[- ]?detached|\bsemi\b/i, detached: /\bdetached\b/i,
  flat: /\b(flat|apartment|maisonette|studio|penthouse)\b/i, bungalow: /bungalow/i,
};
const UNIT_WORDS = {
  sqft: /^\s*(sq\.?\s?ft|sqft|sq\.?\s?feet|square f(ee|oo)t|ft²|ft2)/i,
  sqm: /^\s*(sq\.?\s?m(etres?|eters?|trs?)?\b|sqm|m²|m2\b|square met(re|er)s?|metres? squared)/i,
};
const EPC_KEY = /\b(epc|energy)\b/;
const COUNCIL_TAX_KEY = /\bcouncil\s*tax\b|\btax\s*band\b/;
const CHARGE_KEY = { service: 'service charges?', ground: 'ground rents?' };

/**
 * Gaps the AI may point out beyond the rules (which already cover EPC, tenure, lease, charges, council tax
 * and floor area). Only kept when the text really doesn't mention the topic, and always in Streetkey's words.
 */
const MISSING_TOPICS: { id: string; about: RegExp; mentioned: RegExp; title: string; detail: string; when?: (v: ImportValues) => boolean }[] = [
  { id: 'parking', about: /parking/i, mentioned: /\b(parking|garage|driveway|off[- ]?street|car ?port|permit)\b/i, title: 'Parking not mentioned', detail: 'Ask whether there is parking, whether it’s allocated and whether a permit is needed.' },
  { id: 'heating', about: /heating|boiler/i, mentioned: /\b(heating|boiler|heat pump|radiators?|storage heaters?|underfloor)\b/i, title: 'Heating not described', detail: 'Ask what heating the home has, how old the boiler or system is and when it was last serviced.' },
  { id: 'broadband', about: /broadband|internet|mobile (signal|coverage)/i, mentioned: /\b(broadband|fibre|internet|wi-?fi|mobile (signal|coverage))\b/i, title: 'Broadband and mobile signal not mentioned', detail: 'Agents should give this as material information. Ask, or check the coverage for the postcode on Ofcom’s checker.' },
  { id: 'utilities', about: /\b(water|electricity|drainage|sewer|sewerage|utilities|mains)\b/i, mentioned: /\b(mains|septic|cesspit|cesspool|private drainage|water supply|sewerage|sewer)\b/i, title: 'Utilities not described', detail: 'Ask how the home gets its water, electricity and drainage, and whether any of them are private rather than mains.' },
  { id: 'chain', about: /\bchain\b/i, mentioned: /\bchain\b/i, title: 'Chain not mentioned', detail: 'Ask whether the seller is buying another home and how far along that purchase is.', when: (v) => v.listing !== 'rent' },
  { id: 'rights', about: /covenant|easement|right of way|restriction/i, mentioned: /covenant|easement|right of way|rights of access/i, title: 'Rights and restrictions not mentioned', detail: 'Ask about any restrictive covenants, rights of way or shared access. A conveyancer will confirm them.' },
];

/* ───────────── merging ───────────── */
/** Facts the rule reader reads reliably: on a disagreement its value is kept (as "inferred") and the AI's shown. */
const RULE_FIRST = new Set<FieldKey>(['price', 'epc', 'councilTax', 'leaseYears', 'floorArea', 'serviceChargeAnnual', 'groundRentAnnual', 'postcode']);

/**
 * Merge the AI's reading with the rule-based reader.
 * Exported for tests; `text` is what the person pasted.
 */
export function mergeExtraction(ai: Raw, text: string, url: string): ImportResult {
  const r = ruleReading(text, url);
  const nums = numbersIn(text);
  const values: ImportValues = { features: [] };
  const fields: ImportResult['fields'] = {};
  if (r.sourceSite) values.sourceSite = r.sourceSite;

  /**
   * Verify a candidate: its quote must be in the text and (with `supports`) must back the value itself.
   * Unsupported: dropped when `strict` (money, bands, lease), otherwise "inferred" without the quote.
   */
  const check = <T>(c: Cand<T>, o: { number?: number | null; supports?: (ev: string) => Support; strict?: boolean; needStated?: boolean } = {}): Cand<T> => {
    if (!c) return null;
    if (o.number != null && !numberIn(o.number, nums)) return null; // never show a figure that isn't in the listing
    let ev = c.evidence && quoteIn(c.evidence, text) ? clean(c.evidence, 140) : null;
    let confidence: Confidence = c.confidence === 'stated' && ev ? 'stated' : 'inferred';
    if (o.supports) {
      const s = ev ? o.supports(ev) : 'no';
      if (s === 'no') { if (o.strict) return null; ev = null; confidence = 'inferred'; }
      else if (s === 'weak') confidence = 'inferred';
    }
    if (o.needStated && confidence !== 'stated') return null;
    return { value: c.value, confidence, evidence: ev };
  };
  /** Choose between the AI's value and the rule reader's for one field. */
  const put = <K extends FieldKey>(key: K, a: Cand<ImportValues[K & keyof ImportValues]>, rule: ImportValues[K & keyof ImportValues] | undefined, ruleConfidence: Confidence = 'stated', same: (x: unknown, y: unknown) => boolean = (x, y) => x === y) => {
    const ruleHas = rule !== undefined && rule !== null && rule !== '';
    let info: FieldInfo | null = null;
    let value: unknown;
    if (a && ruleHas && same(a.value, rule)) { value = a.value; info = { confidence: a.confidence === 'stated' || (ruleConfidence === 'stated' && !a.evidence) ? 'stated' : 'inferred', evidence: a.evidence, source: 'both' }; }
    else if (a && ruleHas && a.confidence === 'stated' && RULE_FIRST.has(key)) {
      // Two readings of the same fact: keep the rule reader's, flag it to check and show the AI's beside it.
      value = rule; info = { confidence: 'inferred', evidence: null, source: 'rules', alt: { value: a.value as string | number, evidence: a.evidence } };
    }
    else if (a && (a.confidence === 'stated' || !ruleHas)) { value = a.value; info = { confidence: a.confidence, evidence: a.evidence, source: 'ai' }; }
    else if (ruleHas) { value = rule; info = { confidence: ruleConfidence, evidence: null, source: 'rules' }; }
    if (info) { (values as Record<string, unknown>)[key] = value; fields[key] = info; }
  };
  /** Is this amount written in the quote with the right period next to it, and not after a charge, deposit or fee? */
  const priceSupported = (amount: number, want: Period | null, ev: string) =>
    contextsOf(amount, text, ev).some((x) => periodAfter(x.after) === want && !notPriceBefore(x.before));

  // Sale or rent, and the price (converted to a monthly rent in code).
  let price: Cand<number> = null;
  let listing: Cand<'sale' | 'rent'> = ai.listing ? check(ai.listing, { supports: (ev) => yes(LISTING_WORDS[ai.listing!.value].test(ev)) }) : null;
  if (ai.price) {
    const { amount, period } = ai.price.value;
    const c = check({ ...ai.price, value: amount }, { number: amount, strict: true, supports: (ev) => yes(priceSupported(amount, PRICE_PERIOD[period] ?? null, ev)) });
    const isRent = period !== 'total';
    const monthly = period === 'pw' ? Math.round((amount * 52) / 12) : Math.round(amount);
    if (c && (isRent ? inRange(monthly, 50, 100_000) : inRange(monthly, 1_000, 100_000_000))) {
      price = { ...c, value: monthly };
      if (!listing || listing.value !== (isRent ? 'rent' : 'sale')) listing = { value: isRent ? 'rent' : 'sale', confidence: c.confidence, evidence: c.evidence };
    }
  }
  put('listing', listing, r.listing, 'inferred');
  // If the AI's verified reading says rent where the rule reader saw a sale price (or the reverse), the rule price is the wrong kind.
  if (values.listing && r.listing && values.listing !== r.listing && fields.listing?.source === 'ai') r.price = undefined;
  put('price', price, r.price);

  /** Text fields are kept only as written in the listing. */
  const str = (c: Cand<string>, max: number): Cand<string> => {
    if (!c || !quoteIn(c.value, text)) return null;
    const v = check(c); const t = v ? clean(v.value, max) : '';
    return v && t ? { ...v, value: t } : null;
  };
  put('title', str(ai.title, 120), r.title ? clean(r.title, 120) || undefined : undefined, 'stated');
  put('priceQualifier', str(ai.priceQualifier, 40), undefined);
  put('addressLine', str(ai.addressLine, 120), undefined);
  put('town', str(ai.town, 60), undefined);

  const pc = (() => {
    if (!ai.postcode) return null;
    const p = normalisePostcode(ai.postcode.value);
    if (!/^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/.test(p) || !text.toUpperCase().replace(/\s+/g, '').includes(p.replace(/\s/g, ''))) return null;
    const c = check({ ...ai.postcode, value: p });
    return c ? { ...c, confidence: 'stated' as const } : null; // it's written in the text (checked above)
  })();
  put('postcode', pc, r.postcode && POSTCODE_RE.test(r.postcode) ? normalisePostcode(r.postcode) : undefined);

  put('type', ai.type ? check(ai.type, { supports: (ev) => {
    const t = ai.type!.value;
    return yes(t === 'detached' ? TYPE_WORDS.detached.test(ev.replace(/semi[- ]?detached/gi, '')) : TYPE_WORDS[t].test(ev));
  } }) : null, r.type);
  put('tenure', ai.tenure ? check(ai.tenure, { supports: (ev) => {
    const sof = /share (of|in) (the )?freehold/i.test(ev);
    if (ai.tenure!.value === 'share-of-freehold') return yes(sof);
    if (ai.tenure!.value === 'freehold') return yes(!sof && /\bfreehold\b/i.test(ev));
    return /\bleasehold\b/i.test(ev) ? 'yes' : /\blease\b/i.test(ev) ? 'weak' : 'no';
  } }) : null, r.tenure);
  put('era', check(ai.era), undefined);
  put('condition', check(ai.condition), r.condition, 'inferred');

  // Auction terms raise a high-priority flag, so they need a quote that really says so (and isn't negated).
  const saleMethod = (() => {
    const c = ai.saleMethod;
    if (!c) return null;
    const m = c.value;
    if (m === 'auction' || m === 'modern method of auction') {
      if (!mention(text, 'auction')) return null;
      const words = m === 'auction' ? /\bauction/i : /modern method of auction|\bmmoa\b|reservation (fee|agreement)/i;
      return check(c, { needStated: true, strict: true, supports: (ev) => yes(words.test(ev) && !!mention(ev, 'auction')) });
    }
    return check(c, { supports: (ev) => yes((m === 'tender' ? /\btender\b/i : /private treaty/i).test(ev)) });
  })();
  put('saleMethod', saleMethod as Cand<SaleMethod>, undefined);

  put('epc', ai.epc ? check(ai.epc, { needStated: true, strict: true, supports: (ev) => yes(bandIn(ev, EPC_KEY, ai.epc!.value)) }) : null, r.epc);
  put('councilTax', ai.councilTax ? check(ai.councilTax, { needStated: true, strict: true, supports: (ev) => yes(bandIn(ev, COUNCIL_TAX_KEY, ai.councilTax!.value)) }) : null, r.councilTax);

  const count = (c: Raw['beds'], lo: number, hi: number, word: RegExp) => {
    if (!c || !Number.isInteger(c.value) || !inRange(c.value, lo, hi)) return null;
    if (c.value === 0 && /\bstudio\b/i.test(text)) return check(c, { supports: (ev) => yes(/\bstudio\b/i.test(ev)) });
    return check(c, { number: c.value, supports: (ev) => yes(numbersIn(ev).has(c.value) && word.test(ev)) });
  };
  put('beds', count(ai.beds, 0, 30, /\bbed/i), r.beds);
  put('baths', count(ai.baths, 1, 20, /\b(bath|shower|wc\b|en[- ]?suite)/i), r.baths);

  const lease = (() => {
    const c = ai.leaseYears;
    if (!c || !Number.isInteger(c.value) || !inRange(c.value, 1, 999)) return null;
    return check(c, { number: c.value, strict: true, supports: (ev) => {
      const ctx = contextsOf(c.value, text, ev).filter((x) => /^\s*-?\s*(years?|yrs?)\b/i.test(x.after));
      const near = (x: { after: string }) => `${ev} ${x.after}`;
      if (!ctx.some((x) => /lease|remaining|unexpired|left|to run|outstanding/i.test(near(x)) || /lease/i.test(x.before))) return 'no';
      if (ctx.some((x) => /remaining|unexpired|left|to run|outstanding|\bnew\b/i.test(near(x)))) return 'yes';
      // "a 125 year lease from 2015" is the original term, not the years left.
      if (/\b(from|since|in|granted|commencing|starting) (19|20)\d\d\b/i.test(ev) || ctx.every((x) => /^\s*-?\s*(years?|yrs?)\s*(lease\s*)?(from|commencing|starting|granted|beginning|dated)\b/i.test(x.after))) return 'no';
      return 'weak';
    } });
  })();
  put('leaseYears', lease, r.leaseYears);

  const area = (() => {
    if (!ai.floorArea) return null;
    const { amount, unit } = ai.floorArea.value;
    const m2 = unit === 'sqft' ? Math.round(amount * 0.0929) : Math.round(amount);
    if (!inRange(m2, 8, 5000)) return null;
    const c = check({ ...ai.floorArea, value: amount }, { number: amount, strict: true, supports: (ev) => yes(contextsOf(amount, text, ev).some((x) => UNIT_WORDS[unit].test(x.after))) });
    return c ? { ...c, value: m2 } : null;
  })();
  put('floorArea', area, r.floorArea, 'stated', (x, y) => Math.abs(Number(x) - Number(y)) <= 1);

  /** A charge: the amount, its period and the charge it belongs to must all be in the quote (or right after it). */
  const charge = (c: Raw['serviceCharge'], hi: number, zeroOk: boolean, key: string) => {
    if (!c) return null;
    const { amount, period } = c.value;
    const annual = Math.round(amount * (PERIOD_FACTOR[period] ?? 1));
    if (!inRange(annual, 0, hi)) return null;
    if (amount === 0) return zeroOk ? check({ ...c, value: 0 }) : null;
    const v = check({ ...c, value: amount }, { number: amount, strict: true, supports: (ev) => yes(contextsOf(amount, text, ev).some((x) => {
      const written = periodAfter(x.after);
      const periodOk = written === period || (written === null && period === 'year'); // charges are quoted annually unless they say otherwise
      return periodOk && (new RegExp(key, 'i').test(ev) || keyBefore(x.before, key));
    })) });
    return v ? { ...v, value: annual } : null;
  };
  put('serviceChargeAnnual', charge(ai.serviceCharge, 60_000, false, CHARGE_KEY.service), r.serviceChargeAnnual);
  put('groundRentAnnual', charge(ai.groundRent, 20_000, /\b(peppercorn|no ground rent|nil)\b/i.test(text), CHARGE_KEY.ground), r.groundRentAnnual);

  // Features: the rule reader's plus the AI's, only when written in the text and never about who the home suits.
  const aiFeatures = ai.features.slice(0, 20).map((f) => clean(f, 60)).filter((f) => groundedPhrase(f, text) && !steers(f));
  const feats = [...(r.features ?? []), ...aiFeatures].filter((f) => f.length >= 2 && !/£/.test(f));
  const seen = new Set<string>();
  values.features = feats.filter((f) => { const k = f.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 14);

  // The AI's own red flags.
  const aiFlags: RedFlag[] = [];
  const gaps = new Set<string>();
  ai.redFlags.slice(0, 8).forEach((f, i) => {
    const title = clean(f.title, 80); const detail = clean(f.detail, 260);
    if (f.kind === 'missing') {
      // Only a short list of material gaps, only when the text really doesn't mention them, in Streetkey's words.
      const gap = MISSING_TOPICS.find((g) => g.about.test(title) && (!g.when || g.when(values)));
      if (!gap || gaps.has(gap.id) || gap.mentioned.test(text)) return;
      gaps.add(gap.id);
      aiFlags.push({ id: `ai-gap-${gap.id}`, severity: 'low', title: gap.title, detail: gap.detail, evidence: null, source: 'ai' });
      return;
    }
    // "Stated" flags must quote the text, make no legal or demographic claims and use only figures in the text.
    if (title.length < 4) return;
    const ev = f.evidence && quoteIn(f.evidence, text) ? clean(f.evidence, 140) : null;
    if (!ev) return;
    const about = `${title} ${detail}`;
    if (steers(about) || LEGAL_CLAIM.test(about)) return;
    const topics = [...new Set([...topicsIn(ev), ...topicsIn(title)])];
    if (topics.length && topics.every((t) => !mention(text, t, values))) return; // "No admin fees", "flooded with light", "not subject to auction"
    const figures = [...about.matchAll(/£\s?([\d,.]+)\s?(k|m)?/gi)].map((m) => Number(m[1].replace(/,/g, '')) * (m[2]?.toLowerCase() === 'k' ? 1000 : m[2]?.toLowerCase() === 'm' ? 1e6 : 1));
    if (figures.some((n) => !numberIn(n, nums))) return;
    aiFlags.push({ id: `ai-${i}`, severity: f.severity, title, detail, evidence: ev, source: 'ai' });
  });
  const redFlags = combineFlags(values, text, aiFlags.slice(0, 5));
  const aiQuestions = ai.questionsToAsk.slice(0, 8).map((q) => noMoney(clean(q, 160))).filter((q) => q.length >= 8 && !steers(q) && !LEGAL_CLAIM.test(q));

  return {
    engine: 'ai', values, fields, found: foundOf(values), missing: missingOf(values), redFlags,
    questionsToAsk: combineQuestions(values, redFlags, aiQuestions), note: null,
  };
}

/** Read a pasted listing: AI with the rule reader as a safety net, or the rule reader alone if the AI fails. */
export async function extractImport(text: string, url: string, o: { userId: string | null }): Promise<ImportResult> {
  const safeUrl = /^https?:\/\/[^\s]+$/i.test(url.trim()) ? url.trim() : '';
  const site = (() => { try { return safeUrl ? new URL(safeUrl).hostname.replace(/^www\./, '') : null; } catch { return null; } })();
  try {
    const ai = await readWithAi(text, site, o.userId);
    return mergeExtraction(ai, text, safeUrl);
  } catch (e) {
    if (!(e instanceof AiError)) throw e;
    const res = rulesOnlyResult(text, safeUrl);
    res.note = `${e.userMessage} Streetkey’s built-in reader was used instead, so please check the details carefully.`;
    return res;
  }
}
