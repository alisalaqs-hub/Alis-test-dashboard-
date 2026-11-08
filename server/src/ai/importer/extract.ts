/**
 * "Check any listing" AI reader: turns listing text a person pasted from another website into
 * structured facts with provenance (stated / inferred + a quote), then merges them with
 * Streetkey's rule-based reader as a safety net.
 *
 * Grounding:
 *  - Only the pasted text is read. The link is never visited (we don't scrape other websites).
 *  - Quotes must appear in the text, and every number must be written in it; anything else is
 *    downgraded to "inferred" or dropped (prices, charges and bands are never inferred).
 *  - Unit conversions (per week → per month, sq ft → m², quarterly → annual) happen in code.
 *  - Red flags come from shared rules (src/lib/ai/importer.ts); the AI's own flags are kept only
 *    when they quote the listing or point at something genuinely missing.
 */
import { createHash } from 'node:crypto';
import { normalisePostcode, POSTCODE_RE, extractListing } from '../../../../src/engine/listings';
import {
  combineFlags, combineQuestions, foundOf, missingOf, rulesOnlyResult,
  type FieldInfo, type FieldKey, type ImportResult, type ImportValues, type RedFlag, type SaleMethod,
} from '../../../../src/lib/ai/importer';
import { AiError, cached, chatJSON, HOUSE_RULES, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { clean, noMoney, numberIn, numbersIn, quoteIn } from './validate';

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
  '- Extract only what the text says. Use confidence "stated" only when the value is written in the text, with a short exact quote as evidence. Use "inferred" when you deduce it from a clue in the text (for example "maisonette" means a flat), and quote the clue.',
  '- If a fact isn’t in the text, return null. Never guess prices, rents, charges, lease lengths, sizes, EPC ratings or council tax bands.',
  '- Give money exactly as written with its period; give floor area with its unit. Do not convert or calculate.',
  '- redFlags: things a buyer or renter should check. Use "missing" for important information that isn’t given (EPC, tenure, lease length, service charge, ground rent, council tax band) and "stated" for concerns written in the text (auction terms or fees, a short lease, cash buyers only, non-standard construction, cladding, shared ownership, probate, Japanese knotweed, flooding, letting fees, inviting offers above the rent, discriminatory wording). Quote the text for "stated" flags. Don’t include figures that aren’t in the text.',
  '- questionsToAsk: short, polite questions to fill the gaps or clear up the concerns.',
  '- Don’t describe who the home or area suits, and don’t comment on the people who live there.',
].join('\n');

type Raw = Extraction;
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 40);

/** Ask the model (cached by text, so the same paste isn't paid for twice). */
async function readWithAi(text: string, site: string | null, userId: string | null): Promise<Raw> {
  return cached(`import.extract:v1:${sha(`${site ?? ''}\n${text}`)}`, 6 * 3600, () => chatJSON<Raw>([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Website the person copied this from (for reference only; it has not been visited): ${site ?? 'not given'}\n\n${untrusted('listing', text, MAX_TEXT)}` },
  ], ExtractSchema, 'listing_extract', { purpose: 'import.extract', userId, role: 'fast', maxTokens: 3000 }));
}

/* ───────────── merging ───────────── */
type Cand<T> = { value: T; confidence: 'stated' | 'inferred'; evidence: string | null } | null;
const PERIOD_FACTOR: Record<string, number> = { year: 1, 'half-year': 2, quarter: 4, month: 12 };
const inRange = (n: number, lo: number, hi: number) => Number.isFinite(n) && n >= lo && n <= hi;

/**
 * Merge the AI's reading with the rule-based reader.
 * Exported for tests; `text` is what the person pasted.
 */
export function mergeExtraction(ai: Raw, text: string, url: string): ImportResult {
  const rx = extractListing(text, url);
  const r = rx.fields;
  const nums = numbersIn(text);
  const values: ImportValues = { features: [] };
  const fields: ImportResult['fields'] = {};
  if (r.sourceSite) values.sourceSite = r.sourceSite;

  /** Verify a candidate's quote; a "stated" value without a verifiable quote becomes "inferred". */
  const check = <T>(c: Cand<T>, o: { needStated?: boolean; number?: number | null; allowNumberOutsideText?: boolean } = {}): Cand<T> => {
    if (!c) return null;
    const ev = c.evidence && quoteIn(c.evidence, text) ? clean(c.evidence, 140) : null;
    let confidence = c.confidence === 'stated' && ev ? 'stated' : 'inferred';
    if (o.number != null && !numberIn(o.number, nums)) {
      if (!o.allowNumberOutsideText) return null; // never show a figure that isn't in the listing
      confidence = 'inferred';
    }
    if (o.needStated && confidence !== 'stated') return null;
    return { value: c.value, confidence: confidence as 'stated' | 'inferred', evidence: ev };
  };
  /** Choose between the AI's value and the rule reader's for one field. */
  const put = <K extends FieldKey>(key: K, a: Cand<ImportValues[K & keyof ImportValues]>, rule: ImportValues[K & keyof ImportValues] | undefined, ruleConfidence: 'stated' | 'inferred' = 'stated', same: (x: unknown, y: unknown) => boolean = (x, y) => x === y) => {
    const ruleHas = rule !== undefined && rule !== null && rule !== '';
    let info: FieldInfo | null = null;
    let value: unknown;
    if (a && ruleHas && same(a.value, rule)) { value = a.value; info = { confidence: a.confidence === 'stated' || ruleConfidence === 'stated' ? 'stated' : 'inferred', evidence: a.evidence, source: 'both' }; }
    else if (a && (a.confidence === 'stated' || !ruleHas)) { value = a.value; info = { confidence: a.confidence, evidence: a.evidence, source: 'ai' }; }
    else if (ruleHas) { value = rule; info = { confidence: ruleConfidence, evidence: null, source: 'rules' }; }
    if (info) { (values as Record<string, unknown>)[key] = value; fields[key] = info; }
  };

  // Sale or rent, and the price (converted to a monthly rent in code).
  let price: Cand<number> = null;
  let listing: Cand<'sale' | 'rent'> = check(ai.listing);
  if (ai.price) {
    const { amount, period } = ai.price.value;
    const c = check({ ...ai.price, value: amount }, { number: amount });
    const isRent = period !== 'total';
    const monthly = period === 'pw' ? Math.round((amount * 52) / 12) : Math.round(amount);
    if (c && (isRent ? inRange(monthly, 50, 100_000) : inRange(monthly, 1_000, 100_000_000))) {
      price = { ...c, value: monthly };
      if (!listing || listing.value !== (isRent ? 'rent' : 'sale')) listing = { value: isRent ? 'rent' : 'sale', confidence: c.confidence, evidence: c.evidence };
    }
  }
  // If the rule reader saw a different kind of price (rent vs sale), trust the AI only when its quote checked out.
  put('listing', listing, r.listing, 'inferred');
  if (values.listing && r.listing && values.listing !== r.listing && fields.listing?.source === 'ai') r.price = undefined;
  put('price', price, r.price);

  const str = (c: Cand<string>, max: number): Cand<string> => { const v = check(c); const t = v ? clean(v.value, max) : ''; return v && t ? { ...v, value: t } : null; };
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

  put('type', check(ai.type), r.type);
  put('tenure', check(ai.tenure), r.tenure);
  put('era', check(ai.era), undefined);
  put('condition', check(ai.condition), r.condition, 'inferred');
  put('saleMethod', check(ai.saleMethod) as Cand<SaleMethod>, undefined);
  put('epc', check(ai.epc, { needStated: true }), r.epc);
  put('councilTax', check(ai.councilTax, { needStated: true }), r.councilTax);

  const int = (c: Raw['beds'], lo: number, hi: number) => {
    if (!c || !Number.isInteger(c.value) || !inRange(c.value, lo, hi)) return null;
    if (c.value === 0 && /\bstudio\b/i.test(text)) return check(c);
    return check(c, { number: c.value });
  };
  put('beds', int(ai.beds, 0, 30), r.beds);
  put('baths', int(ai.baths, 1, 20), r.baths);
  put('leaseYears', int(ai.leaseYears, 1, 999), r.leaseYears);

  const area = (() => {
    if (!ai.floorArea) return null;
    const { amount, unit } = ai.floorArea.value;
    const m2 = unit === 'sqft' ? Math.round(amount * 0.0929) : Math.round(amount);
    if (!inRange(m2, 8, 5000)) return null;
    const c = check({ ...ai.floorArea, value: amount }, { number: amount });
    return c ? { ...c, value: m2 } : null;
  })();
  put('floorArea', area, r.floorArea, 'stated', (x, y) => Math.abs(Number(x) - Number(y)) <= 1);

  const charge = (c: Raw['serviceCharge'], hi: number, zeroOk: boolean) => {
    if (!c) return null;
    const { amount, period } = c.value;
    const annual = Math.round(amount * (PERIOD_FACTOR[period] ?? 1));
    if (!inRange(annual, 0, hi)) return null;
    if (amount === 0) return zeroOk ? check({ ...c, value: 0 }) : null;
    const v = check({ ...c, value: amount }, { number: amount });
    return v ? { ...v, value: annual } : null;
  };
  put('serviceChargeAnnual', charge(ai.serviceCharge, 60_000, false), r.serviceChargeAnnual);
  put('groundRentAnnual', charge(ai.groundRent, 20_000, /\b(peppercorn|no ground rent|nil)\b/i.test(text)), undefined);

  // Features: the rule reader's plus the AI's (short, deduplicated).
  const feats = [...(r.features ?? []), ...ai.features.map((f) => clean(f, 60))].filter((f) => f.length >= 2 && !/£/.test(f));
  const seen = new Set<string>();
  values.features = feats.filter((f) => { const k = f.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 14);

  // The AI's own red flags: "stated" ones must quote the text; any money figure must be in the text.
  const aiFlags: RedFlag[] = ai.redFlags.slice(0, 8).flatMap((f, i): RedFlag[] => {
    const title = clean(f.title, 80); const detail = clean(f.detail, 260);
    if (title.length < 4) return [];
    const ev = f.evidence && quoteIn(f.evidence, text) ? clean(f.evidence, 140) : null;
    if (f.kind === 'stated' && !ev) return [];
    const figures = [...`${title} ${detail}`.matchAll(/£\s?([\d,.]+)\s?(k|m)?/gi)].map((m) => Number(m[1].replace(/,/g, '')) * (m[2]?.toLowerCase() === 'k' ? 1000 : m[2]?.toLowerCase() === 'm' ? 1e6 : 1));
    if (figures.some((n) => !numberIn(n, nums))) return [];
    return [{ id: `ai-${i}`, severity: f.severity, title, detail, evidence: ev, source: 'ai' }];
  }).slice(0, 5);
  const redFlags = combineFlags(values, text, aiFlags);
  const aiQuestions = ai.questionsToAsk.slice(0, 8).map((q) => noMoney(clean(q, 160))).filter((q) => q.length >= 8);

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
