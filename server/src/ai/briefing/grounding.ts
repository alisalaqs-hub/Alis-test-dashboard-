/**
 * Figure grounding: every £ amount and percentage the AI writes must already appear in the
 * data it was given, as a figure of the same kind. Sentences (in prose) or whole items (in
 * lists) that quote a figure we can't find are dropped, so a briefing never shows an
 * invented price, rent, cost or rate.
 *
 * Matching is type-aware. Money figures are matched only against money in the data: £/GBP/
 * "pounds" figures written in text, metrics whose unit is £, and fields whose name says money
 * (price, rent, cost, value, GDV, budget, arrears…). Percentages are matched only against
 * percentages: "%"/"per cent"/"pc"/"percentage points" figures in text, metrics whose unit is
 * %, and fields named as rates (…Pct, rate, conversion, yield…), where a fraction up to 1 is
 * also read as a percentage (0.012 → 1.2%). Counts, days, scores, ids, labels' bare numbers
 * and dates never ground a £ or % figure.
 *
 * Within a kind, money matching tolerates formatting and rounding to the shown precision
 * ("£525,000", "£525k" and "£0.53m" all match 525000, within 5%); percentages tolerate
 * formatting only ("1.2%" matches 1.2 or 0.012, "1%" does not). Totals, differences and new
 * percentages the model works out itself do not match and are removed.
 */

export interface Figure { kind: 'money' | 'percent'; value: number; tol: number; text: string }

const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
// A multiplier must not run into another word or unit ("£2,650 m²" is not £2.65bn).
const SUFFIX = String.raw`(?:\s?(k|mn|m|bn|thousand|million|billion)(?![A-Za-z0-9²³_]))?`;
const DASH = String.raw`\s?(?:–|—|-|to)\s?`;
const NOT_PERCENT = String.raw`(?!\s?(?:%|per ?cent\b|pc\b|percentage\b|pp\b))`;

/** "£525k", "GBP 1,250", "£500–550k". */
const MONEY_RE = new RegExp(String.raw`(?:£|\bGBP\s?)\s?(${NUM})${SUFFIX}(?:${DASH}(?:£|GBP\s?)?\s?(${NUM})${SUFFIX})?`, 'gid');
/** "1,300 pounds", "1,250 GBP", "500k quid", "1,200 to 1,300 pounds" (not already led by £/GBP). */
const MONEY_POST_RE = new RegExp(String.raw`(?<!(?:£|GBP)\s?)(?<![\d.,])(${NUM})${SUFFIX}(?:${DASH}(${NUM})${SUFFIX})?\s?(?:pounds?(?:\s+sterling)?|quid|GBP)\b`, 'gid');
/** A bare 1,000+ number right after a price noun: "asking 525,000", "the price to 499,950", "rent to 1,300". */
const PRICE_NOUN = String.raw`(?:prices?|priced|asking|rents?|rental|offers?|valued|valuation|worth|gdv|costs?|budget|fees?|deposit|arrears)`;
const MONEY_NEAR_RE = new RegExp(String.raw`\b${PRICE_NOUN}\b(?:\s+[A-Za-z'’]+){0,3}?\s+(${NUM})${SUFFIX}${NOT_PERCENT}(?![\d,]|\.\d|\s?(?:pounds?|quid|GBP)\b)`, 'gid');
/** A bare number with a money multiplier, "cut to 499k", "a 1.2m GDV", unless it counts something ("4.2k views"). */
const COUNT_NOUN = String.raw`(?:views?|visitors?|visits?|impressions?|searches|users?|people|homes|households|units?|listings?|enquiries|sessions?|followers?|steps|words|miles|metres|meters|sq)`;
const MONEY_SUFFIX_RE = new RegExp(String.raw`(?<!(?:£|GBP)\s?)(?<![\d.,])(${NUM})\s?(k|mn|m|bn|million|billion)(?![A-Za-z0-9²³_])(?!\s?-?\s?${COUNT_NOUN}\b)`, 'gid');
const PERCENT_RE = new RegExp(String.raw`(${NUM})(?:${DASH}(${NUM}))?\s?(?:%|per ?cent\b|percentage points?\b|pp\b|pc\b)`, 'gid');
/** ISO-style dates and times are never figures ("2026-11-30" is not £2,026 or 30%). */
const DATE_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const WHOLE_NUM_RE = new RegExp(String.raw`^\s*-?(?:${NUM})\s*$`);

const decimals = (s: string) => (s.includes('.') ? s.split('.')[1].length : 0);
const toNum = (s: string) => Number.parseFloat(s.replace(/,/g, ''));

function money(numText: string, suffix: string | undefined, raw: string): Figure {
  const mult = suffix ? MULT[suffix.toLowerCase()] ?? 1 : 1;
  const value = toNum(numText) * mult;
  const unit = 10 ** -decimals(numText) * mult;
  // Rounding tolerance: half the last shown digit, but never more than 5% of the figure.
  return { kind: 'money', value, tol: Math.min(unit / 2, Math.max(0.5, value * 0.05)) + 1e-6, text: raw };
}
function percent(numText: string, raw: string): Figure {
  // Percentages must be quoted as given: formatting differences only ("4.70%" for 4.7%, "0.45%"
  // for 0.0045), never rounding to a new figure ("5%" for 4.7% is not in the data).
  return { kind: 'percent', value: toNum(numText), tol: Math.min((10 ** -decimals(numText)) / 2, 0.05) + 1e-9, text: raw };
}

/** A bare number near a price word counts as money only when it looks like money (a multiplier, or 1,000+ that isn't a year). */
const looksLikeMoney = (numText: string, suffix: string | undefined) =>
  !!suffix || (toNum(numText) >= 1000 && !/^(?:19|20)\d{2}$/.test(numText));

/** £ and % figures quoted in a piece of text. */
export function figuresIn(text: string): Figure[] {
  const found = new Map<string, Figure>(); // keyed by kind and position, so overlapping patterns count once
  const add = (kind: Figure['kind'], at: number, f: Figure) => { const k = `${kind}:${at}`; if (!found.has(k)) found.set(k, f); };
  const at = (m: RegExpMatchArray, g: number) => m.indices?.[g]?.[0] ?? -1;
  const clean = text.replace(DATE_RE, (d) => ' '.repeat(d.length));
  for (const m of clean.matchAll(MONEY_RE)) {
    // "£500–550k": a multiplier on the second number applies to the first as well.
    const firstSuffix = m[2] ?? (m[3] ? m[4] : undefined);
    add('money', at(m, 1), money(m[1], firstSuffix, m[0]));
    if (m[3]) add('money', at(m, 3), money(m[3], m[4], m[0]));
  }
  for (const m of clean.matchAll(MONEY_POST_RE)) {
    const firstSuffix = m[2] ?? (m[3] ? m[4] : undefined);
    add('money', at(m, 1), money(m[1], firstSuffix, m[0]));
    if (m[3]) add('money', at(m, 3), money(m[3], m[4], m[0]));
  }
  for (const m of clean.matchAll(MONEY_NEAR_RE)) {
    if (looksLikeMoney(m[1], m[2])) add('money', at(m, 1), money(m[1], m[2], m[0]));
  }
  for (const m of clean.matchAll(MONEY_SUFFIX_RE)) add('money', at(m, 1), money(m[1], m[2], m[0]));
  for (const m of clean.matchAll(PERCENT_RE)) {
    add('percent', at(m, 1), percent(m[1], m[0]));
    if (m[2]) add('percent', at(m, 2), percent(m[2], m[0]));
  }
  return [...found.entries()].sort((a, b) => Number(a[0].split(':')[1]) - Number(b[0].split(':')[1])).map(([, f]) => f);
}

/* ───────────── what kind of figure a field or metric holds ───────────── */

type FigureClass = 'money' | 'percent' | 'none';

const PERCENT_WORDS = new Set(['pct', 'percent', 'percentage', 'rate', 'rates', 'conversion', 'yield', 'yields', 'occupancy', 'margin', 'share', 'ratio', 'ltv', 'growth', 'apr', 'roi', 'irr']);
const MONEY_WORDS = new Set([
  'price', 'prices', 'priced', 'rent', 'rents', 'rental', 'cost', 'costs', 'value', 'values', 'gdv', 'residual', 'budget', 'arrears',
  'fee', 'fees', 'deposit', 'deposits', 'income', 'profit', 'spend', 'spending', 'revenue', 'asking', 'offer', 'offers', 'valuation',
  'quote', 'quotes', 'gbp', 'pounds', 'capex', 'bill', 'bills', 'charge', 'charges', 'payment', 'payments', 'premium', 'tax', 'sdlt',
  'levy', 'mortgage', 'loan', 'debt', 'equity', 'cash', 'finance', 'amount', 'contingency', 'cil', 'headroom', 'allowance', 'roll', 'savings',
]);
/** Counts and time spans: a field like priceChanges or daysUntilDue is never money or a rate. */
const NEUTRAL_WORDS = new Set([
  'date', 'dates', 'day', 'days', 'due', 'year', 'years', 'month', 'months', 'week', 'weeks', 'hour', 'hours', 'count', 'number',
  'qty', 'id', 'ids', 'age', 'beds', 'bedrooms', 'baths', 'bathrooms', 'views', 'visitors', 'enquiries', 'saves', 'photos', 'changes',
  'listings', 'units', 'score', 'rank', 'viewings', 'requests', 'items',
]);
const SKIP_KEYS = new Set(['id', 'ids', 'relatedIds', 'ref', 'refs']);

/** "maintenanceSpend12m" → ["maintenance", "spend"]; words after "per" are a denominator ("rentPerM2" is rent). */
function keyWords(name: string): string[] {
  const words = name.replace(/\([^)]*\)/g, ' ') // labels: "Professional fees (12%)" is about fees
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.filter((w, i) => w !== 'per' && words[i - 1] !== 'per');
}
export function classify(name: string): FigureClass | null {
  const words = keyWords(name);
  if (words.some((w) => NEUTRAL_WORDS.has(w))) return 'none';
  if (words.some((w) => PERCENT_WORDS.has(w))) return 'percent';
  if (words.some((w) => MONEY_WORDS.has(w))) return 'money';
  return null;
}
function classifyUnit(unit: string): FigureClass {
  if (/£|\bgbp\b|pounds?/i.test(unit)) return 'money';
  if (/%|per ?cent|\bpct\b|percentage/i.test(unit)) return 'percent';
  return 'none';
}

interface Pools { money: number[]; percent: number[] }

function collect(data: unknown, cls: FigureClass | null, into: Pools): void {
  if (typeof data === 'number') {
    if (!Number.isFinite(data)) return;
    const n = Math.abs(data);
    if (cls === 'money') into.money.push(n);
    else if (cls === 'percent') { into.percent.push(n); if (n <= 1) into.percent.push(n * 100); }
  } else if (typeof data === 'string') {
    for (const f of figuresIn(data)) into[f.kind].push(Math.abs(f.value));
    // A field that holds only a number as text ("525000") counts like the number itself.
    if ((cls === 'money' || cls === 'percent') && WHOLE_NUM_RE.test(data)) collect(toNum(data.trim()), cls, into);
  } else if (Array.isArray(data)) {
    for (const v of data) collect(v, cls, into);
  } else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    // A metric: { label, value, unit? }. The unit decides; otherwise the label's words.
    if (typeof o.label === 'string' && 'value' in o) {
      const valueCls = typeof o.unit === 'string' && o.unit.trim() ? classifyUnit(o.unit) : classify(o.label) ?? cls;
      collect(o.value, valueCls, into);
      collect(o.label, null, into); // explicit £/% figures in a label still count; bare numbers never do
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      if (SKIP_KEYS.has(k)) continue;
      if (k === 'label' || k === 'title' || k === 'name') { collect(v, null, into); continue; }
      collect(v, classify(k) ?? cls, into);
    }
  }
}

/** The money and percentage figures present in some data, by kind. */
export function figurePools(data: unknown): Pools {
  const pools: Pools = { money: [], percent: [] };
  collect(data, null, pools);
  return { money: [...new Set(pools.money)], percent: [...new Set(pools.percent)] };
}

export class Grounding {
  private readonly pools: Pools;
  checked = 0;
  dropped = 0;
  constructor(data: unknown) { this.pools = figurePools(data); }

  /** Is this figure in the data, as the same kind of figure (allowing for formatting and rounding)? */
  matches(f: Figure): boolean {
    return this.pools[f.kind].some((n) => Math.abs(n - f.value) <= f.tol);
  }
  /** True when every £/% figure in the text is grounded and it makes no prohibited claim. */
  ok(text: string): boolean {
    const figs = figuresIn(text);
    this.checked += figs.length;
    return figs.every((f) => this.matches(f)) && !PROHIBITED.test(text);
  }
  /** Prose: keep only the sentences that pass. */
  prose(text: string): string {
    const kept = sentences(text).filter((s) => { const good = this.ok(s); if (!good) this.dropped++; return good; });
    return kept.join(' ').trim();
  }
  /** Lists: keep only the items whose every text passes. */
  list<T>(items: T[], texts: (t: T) => string[]): T[] {
    return items.filter((it) => { const good = texts(it).every((t) => this.ok(t)); if (!good) this.dropped++; return good; });
  }
  get report() { return { checked: this.checked, dropped: this.dropped }; }
}

/**
 * Claims Streetkey never makes (Consumer Protection from Unfair Trading Regulations / DMCC Act
 * misleading-claims rules, and no advice): guarantees, certainty about sale or letting outcomes,
 * or presenting an estimate as a valuation or professional advice.
 */
export const PROHIBITED = /\b(guarantee[ds]?|risk[- ]free|certain to (?:sell|let)|will definitely|(?:this|it) is (?:a|your) (?:formal )?valuation|(?:financial|legal|tax) advice to)\b/i;

/** Split prose into sentences without breaking decimals ("£1.45m") or common abbreviations. */
export function sentences(text: string): string[] {
  return text.replace(/\s+/g, ' ').trim()
    .split(/(?<!\b(?:e\.g|i\.e|etc|approx|vs|incl)\.)(?<=[.!?])\s+(?=[A-Z0-9£"“‘(])/)
    .map((s) => s.trim()).filter(Boolean);
}
