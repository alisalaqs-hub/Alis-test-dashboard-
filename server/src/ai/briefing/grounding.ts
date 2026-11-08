/**
 * Figure grounding: every £ amount and percentage the AI writes must already appear in the
 * data it was given. Sentences (in prose) or whole items (in lists) that quote a figure we
 * can't find are dropped, so a briefing never shows an invented price, rent, cost or rate.
 *
 * Matching is tolerant of formatting and rounding only: "£525,000", "£525k" and "£0.53m"
 * all match 525000; "1.2%" matches 1.2 or a fraction of 0.012. Totals, differences and
 * new percentages the model works out itself do not match and are removed.
 */

export interface Figure { kind: 'money' | 'percent'; value: number; tol: number; text: string }

const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
// A multiplier must not run into another word or unit ("£2,650 m²" is not £2.65bn).
const SUFFIX = String.raw`(?:\s?(k|mn|m|bn|thousand|million|billion)(?![A-Za-z0-9²³_]))?`;
const DASH = String.raw`\s?(?:–|—|-|to)\s?`;
const MONEY_RE = new RegExp(String.raw`(?:£|\bGBP\s?)\s?(${NUM})${SUFFIX}(?:${DASH}(?:£|GBP\s?)?\s?(${NUM})${SUFFIX})?`, 'gi');
const PERCENT_RE = new RegExp(String.raw`(${NUM})(?:${DASH}(${NUM}))?\s?(?:%|per ?cent\b|percentage points?\b|pp\b)`, 'gi');
const BARE_RE = new RegExp(NUM, 'g');

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
  return { kind: 'percent', value: toNum(numText), tol: (10 ** -decimals(numText)) / 2 + 1e-9, text: raw };
}

/** £ and % figures quoted in a piece of text. */
export function figuresIn(text: string): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(MONEY_RE)) {
    // "£500–550k": a multiplier on the second number applies to the first as well.
    const firstSuffix = m[2] ?? (m[3] ? m[4] : undefined);
    out.push(money(m[1], firstSuffix, m[0]));
    if (m[3]) out.push(money(m[3], m[4], m[0]));
  }
  for (const m of text.matchAll(PERCENT_RE)) {
    out.push(percent(m[1], m[0]));
    if (m[2]) out.push(percent(m[2], m[0]));
  }
  return out;
}

/** Every number present in some data (numbers, and numbers written inside strings). */
export function numbersIn(data: unknown, into: number[] = []): number[] {
  if (typeof data === 'number' && Number.isFinite(data)) into.push(data);
  else if (typeof data === 'string') {
    for (const f of figuresIn(data)) into.push(f.value);
    for (const m of data.matchAll(BARE_RE)) into.push(toNum(m[0]));
  } else if (Array.isArray(data)) for (const v of data) numbersIn(v, into);
  else if (data && typeof data === 'object') for (const v of Object.values(data)) numbersIn(v, into);
  return into;
}

export class Grounding {
  private readonly nums: number[];
  checked = 0;
  dropped = 0;
  constructor(data: unknown) { this.nums = [...new Set(numbersIn(data).map((n) => Math.abs(n)))]; }

  /** Is this figure in the data (allowing for formatting and rounding)? */
  matches(f: Figure): boolean {
    if (f.kind === 'money') return this.nums.some((n) => Math.abs(n - f.value) <= f.tol);
    return this.nums.some((n) => Math.abs(n - f.value) <= f.tol || Math.abs(n * 100 - f.value) <= f.tol);
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
