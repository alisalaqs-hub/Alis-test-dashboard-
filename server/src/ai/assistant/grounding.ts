/**
 * Grounding check for the assistant's prose: every money amount and percentage in a reply must
 * match a figure Streetkey produced (tool results, the page's property data) or one the person
 * wrote themselves, allowing for ordinary rounding. Anything else is treated as invented.
 *
 * Numbers are read with what kind of number they are, so an amount can only be grounded by an
 * amount (never by a count such as 3 bedrooms, 30m² or 12 weeks), and a percentage by a rate.
 * Money is recognised with £, "GBP", "pounds", k/m/bn and million-style suffixes, and amounts
 * written next to "pcm", "a month", "a year" and similar.
 *
 * Only Streetkey's own figures count as evidence: text a lister wrote (titles, towns, features,
 * descriptions, anything wrapped as <<<…>>>) and text that just echoes what the model asked for
 * (error messages, "understood" search summaries) never ground a figure. See engineOnly(). Nor do
 * the numbers the model chose as a tool's arguments and got straight back (a stamp duty price, a
 * mortgage loan and rate): see toolsEvidence().
 */

export interface Figure { raw: string; value: number; tol: number; kind: 'money' | 'pct' }
/** Numbers the evidence allows, by kind: amounts may only match `money`, percentages only `pct`. */
export interface Allowed { money: number[]; pct: number[] }

type Kind = 'money' | 'pct' | 'count' | 'plain';
interface Token { kind: Kind; value: number; unit: number; raw: string; /** Where the digits are in the text. */ at: number; len: number }

const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };
const NUM_RE = /\d(?:[\d,]*\d)?(?:\.\d+)?/g;

/** Part of a word, code or id ("E17", "sk-abc123", "gpt-5", "1.2.3"): not a figure. */
const IN_WORD = /(?:[A-Za-z_]-?|[\d.,])$/;
const CURRENCY_BEFORE = /(?:£|\bGBP)\s?$/i;
const PCT_AFTER = /^\s?(?:%|per ?cent\b)/i;
const MULT_AFTER = /^(?:(k|m|bn)(?![a-z\d²])|\s?(thousand|million|billion)\b)/i;
/** A bare "m" that means metres: "3m wide", "30m garden", "3m x 4m", "2.4m ceilings". */
const METRES_AFTER = /^m\s?(?:[x×]|by\b|wide|long|high|deep|tall|square|sq\b|garden|plot|frontage|ceilings?|rear|side|extension|from|away|of\b|in\b|to\b|apart|walk)/i;
const METRES_BEFORE = /(?:\dm?\s?[x×]|\bby)\s?$/i;
/** Inherited size for the first number of a range: "£480–520k". */
const RANGE_MULT = /^\s?(?:–|-|to)\s?£?\d(?:[\d,]*\d)?(?:\.\d+)?\s?(k|m|bn)(?![a-z\d²])/i;
const CURRENCY_AFTER = /^\s?(?:pounds?|quid|GBP)\b/i;
/** Always money: "950 pcm", "350 pw", "1,200 p.a.". */
const PERIOD_MONEY = /^\s?(?:pcm|p\.c\.m\.?|pw|p\/w|p\/m|p\.a\.|per annum)(?![a-z])/i;
/** Money when the amount is large enough to be one: "2,100 a month", "1800 per year". */
const PERIOD_WORDS = /^\s?(?:a|per|each)\s(?:calendar\s)?(?:month|week|year|annum)\b/i;
/** Counts and measures: never money or a rate. */
const UNIT_AFTER = /^[\s-]?(?:m²|m2\b|ft²|sq\.?\s?(?:m|ft|metres?|feet)\b|sqm\b|sqft\b|square\s(?:metres?|meters?|feet)|km\b|kms\b|miles?\b|mi\b|mins?\b|minutes?\b|hours?\b|hrs?\b|days?\b|weeks?\b|wks?\b|months?\b|years?\b|yrs?\b|beds?\b|bedrooms?\b|baths?\b|bathrooms?\b|storeys?\b|stories\b|floors?\b|rooms?\b|homes?\b|listings?\b|properties\b|results?\b|matches\b|comparables?\b|\/\s?\d|out of\b|stars?\b|points?\b)/i;

/** Value and the precision it was written to: "£485k" → 485,000 ± 500; "£1,800" → 1,800 ± 50. */
function parse(num: string, suffix: string | undefined) {
  const [int, dec] = num.split('.');
  const digits = int.replace(/,/g, '');
  const mult = suffix ? MULT[suffix.toLowerCase()] ?? 1 : 1;
  const value = Number(`${digits}${dec ? `.${dec}` : ''}`) * mult;
  const zeros = dec ? 0 : (digits.match(/0+$/)?.[0].length ?? 0);
  const unit = (dec ? 10 ** -dec.length : /^0+$/.test(digits) ? 1 : 10 ** zeros) * mult;
  return { value, unit };
}

/** Every number in a piece of text, with what kind of number it is. */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const before = text.slice(Math.max(0, start - 5), start);
    if (IN_WORD.test(before) && !CURRENCY_BEFORE.test(before)) continue;
    let after = text.slice(end, end + 32);
    const currency = CURRENCY_BEFORE.exec(before);
    const prefix = currency ? currency[0] : '';
    if (PCT_AFTER.test(after)) {
      const { value, unit } = parse(m[0], undefined);
      out.push({ kind: 'pct', value, unit, raw: `${m[0]}${PCT_AFTER.exec(after)![0]}`.trim(), at: start, len: m[0].length });
      continue;
    }
    let suffix: string | undefined;
    let consumed = '';
    const mult = MULT_AFTER.exec(after);
    if (mult) {
      const letter = mult[1];
      if (letter?.toLowerCase() === 'm' && !currency && (METRES_AFTER.test(after) || METRES_BEFORE.test(before))) continue; // metres
      suffix = letter ?? mult[2];
      consumed = mult[0];
      after = after.slice(consumed.length);
    } else if (currency) {
      suffix = RANGE_MULT.exec(after)?.[1];
    }
    const { value, unit } = parse(m[0], suffix);
    if (!Number.isFinite(value)) continue;
    const raw = (tail = '') => `${prefix}${m[0]}${consumed}${tail}`.trim();
    const tok = (kind: Kind, tail = ''): Token => ({ kind, value, unit, raw: raw(tail), at: start, len: m[0].length });
    if (currency || suffix) { out.push(tok('money')); continue; }
    const cur = CURRENCY_AFTER.exec(after);
    if (cur) { out.push(tok('money', cur[0])); continue; }
    const period = PERIOD_MONEY.exec(after);
    if (period) { out.push(tok('money', period[0])); continue; }
    const words = PERIOD_WORDS.exec(after);
    if (words && (m[0].includes(',') || value >= 100)) { out.push(tok('money', words[0])); continue; }
    if (UNIT_AFTER.test(after) || /^\/$/.test(before.slice(-1))) { out.push(tok('count')); continue; }
    if (/^[A-Za-z]/.test(after)) continue; // "3rd", "5RB": part of a word
    out.push(tok('plain'));
  }
  return out;
}

const tolFor = (t: Token) => (t.kind === 'money' ? Math.min(t.unit / 2, Math.max(0.5, t.value * 0.04)) : Math.min(t.unit / 2, Math.max(0.05, t.value * 0.04)));

/** Money amounts and percentages written in a piece of text. */
export function figuresIn(text: string): Figure[] {
  return tokens(text).filter((t): t is Token & { kind: 'money' | 'pct' } => t.kind === 'money' || t.kind === 'pct')
    .map((t) => ({ raw: t.raw, value: t.value, kind: t.kind, tol: tolFor(t) }));
}

/** JSON keys whose numbers are counts or measures (never money, never a rate). */
const COUNT_KEY = /^(?:beds|baths|storeys|weeks|weeksOnSite|years|days|minutes|walkMins|score|dealScore|outOf|soldComparables|totalMatches|leaseYears|distanceKm|distanceM|areaM2|floorAreaM2|daysOnMarket|widthM|lengthM|evidenceCount)$/i;
/** JSON keys whose numbers are rates (percentages or fractions). */
const PCT_KEY = /(?:pct|percent|rate|yield)$/i;

/**
 * Keys whose values are not Streetkey's figures: what a lister wrote about a home, and text that
 * echoes the model's own tool arguments (an error naming the id it asked for, the search it ran).
 */
const NOT_EVIDENCE_KEY = /^(?:title|town|street|features|description|source|error|understood|notSupportedYet|notFound)$/;
/** Untrusted blocks made by untrusted(): they can't nest (markers inside are collapsed). */
const UNTRUSTED_BLOCK = /<<<[\s\S]*?(?:>>>|$)/g;

/**
 * The parts of a tool result (or the page's property data) that come from Streetkey's engines:
 * lister-written fields and untrusted blocks removed. Used as the evidence for the grounding check
 * and for the correction pass, so a figure in a listing's description can never vouch for a reply.
 */
export function engineOnly(v: unknown, depth = 0): unknown {
  if (depth > 10) return null;
  if (v == null) return v;
  if (typeof v === 'string') return v.includes('<<<') ? v.replace(UNTRUSTED_BLOCK, ' ').trim() || null : v;
  if (Array.isArray(v)) return v.map((x) => engineOnly(x, depth + 1));
  if (typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !NOT_EVIDENCE_KEY.test(k)).map(([k, x]) => [k, engineOnly(x, depth + 1)]));
  }
  return v;
}

/**
 * Defaults the tools tell the model to use when the person gives none ("use 25 if not given").
 * They are Streetkey's stated assumptions, so they may be quoted even though they arrive as arguments.
 */
const ARG_DEFAULTS: Record<string, Record<string, number>> = {
  investment_check: { depositPct: 25, ratePct: 5 },
  mortgage_payment: { ratePct: 5, years: 25 },
  design_cost: { widthM: 3, lengthM: 4 },
};
/** Figures a tool works out directly from one argument and hands back (loan to value is 100 − deposit). */
const DERIVED: Record<string, Record<string, (v: number) => number>> = {
  investment_check: { depositPct: (d) => 100 - d },
};

/**
 * The numbers the model chose as a tool's arguments: numeric arguments, and amounts and rates written
 * in text arguments (a search query's budget or minimum yield), plus what the tool derives straight
 * from them. Documented defaults, and figures `accepted` vouches for (the person's own words, the page
 * home's engine data, another engine output), are not echoes.
 * A model following instructions planted in listing text could pass a lister's figure as an argument
 * (stamp_duty with the lister's "valuation" as the price, mortgage_payment with their "rent" as the
 * loan) and quote it back as checked, so these are never evidence on their own.
 */
export function echoedArgs(tool: string, args: unknown, accepted: (n: number) => boolean = () => false): number[] {
  const out: number[] = [];
  const defaults = ARG_DEFAULTS[tool] ?? {};
  const derived = DERIVED[tool] ?? {};
  const add = (n: number) => { if (Number.isFinite(n) && n !== 0 && !accepted(n)) { out.push(n); return true; } return false; };
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 4 || v == null) return;
    if (typeof v === 'number') {
      if (defaults[key] !== v && add(v) && derived[key]) out.push(derived[key](v));
      return;
    }
    // In text, only what reads as a figure: "£450k", "9.7%", "450000", "9.7" (not "2 bed", "flat for 2").
    if (typeof v === 'string') {
      for (const t of tokens(v.slice(0, 600))) if (t.kind === 'money' || t.kind === 'pct' || (t.kind === 'plain' && (t.value >= 100 || !Number.isInteger(t.value)))) add(t.value);
      return;
    }
    if (Array.isArray(v)) { for (const x of v.slice(0, 20)) walk(x, key, depth + 1); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1);
  };
  walk(args, '', 0);
  return out.filter((n) => Number.isFinite(n) && n !== 0);
}

/** The same number, allowing only for the rounding a tool applies to its own argument (Math.round on a price or loan). */
const sameNumber = (n: number, e: number) => Math.abs(Math.abs(n) - Math.abs(e)) <= Math.max(0.005, Math.abs(e) * 1e-4, Math.abs(e) >= 100 ? 0.5 : 0);

/** Removes every number equal to an echoed argument (fields become null; digits in text become "…"). */
function withoutEchoes(v: unknown, echoes: number[], depth = 0): unknown {
  if (!echoes.length || depth > 10 || v == null) return v;
  const echoed = (n: number) => echoes.some((e) => sameNumber(n, e));
  if (typeof v === 'number') return echoed(v) ? null : v;
  if (typeof v === 'string') {
    const hits = tokens(v).filter((t) => echoed(t.value));
    if (!hits.length) return v;
    let s = v;
    for (const t of hits.reverse()) s = `${s.slice(0, t.at)}…${s.slice(t.at + t.len)}`;
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => withoutEchoes(x, echoes, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, withoutEchoes(x, echoes, depth + 1)]));
  return v;
}

export interface ToolCall { name: string; args: unknown; result: unknown }

/**
 * What each tool call contributes as evidence: its engine output (engineOnly) without the numbers the
 * model chose as its arguments, wherever the tool echoes them: stamp_duty's price (and the top of its
 * last band), mortgage_payment's loan, rate and term (and a 0% loan's total repaid), investment_check's
 * deposit, loan to value and rate, design_cost's room size, a search's budget or minimum yield.
 * An argument still counts when `trusted` (the person's own messages, the page home's engine data) or
 * another engine output has the same figure; then what the tool derives from it counts too.
 */
export function toolsEvidence(calls: ToolCall[], trusted: unknown): { tool: string; result: unknown }[] {
  const engine = calls.map((c) => engineOnly(c.result));
  // First, every output without any of its echoes: what Streetkey's engines said on their own.
  const strict = calls.map((c, i) => withoutEchoes(engine[i], echoedArgs(c.name, c.args)));
  const base = numbersIn([trusted, strict]);
  const known = [...base.money, ...base.pct];
  const accepted = (n: number) => known.some((k) => sameNumber(k, n));
  return calls.map((c, i) => ({ tool: c.name, result: withoutEchoes(engine[i], echoedArgs(c.name, c.args, accepted)) }));
}

/** Every number the evidence allows, by kind: numbers themselves and numbers written inside strings (never inside <<<…>>> blocks). */
export function numbersIn(v: unknown, out: Allowed = { money: [], pct: [] }, depth = 0, key = ''): Allowed {
  if (depth > 8 || v == null) return out;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || COUNT_KEY.test(key)) return out;
    const n = Math.abs(v);
    if (!PCT_KEY.test(key)) out.money.push(n);
    out.pct.push(n);
    return out;
  }
  if (typeof v === 'string') {
    if (v.startsWith('/')) return out; // internal links: ids and query strings, not figures
    // Listing text wrapped as data is never evidence. Dates ("2024-05", "2026-11-09T…") are not figures.
    const text = v.replace(UNTRUSTED_BLOCK, ' ').replace(/\b\d{4}-\d{2}(?:-\d{2})?(?:T[\d:.]+Z?)?\b/g, ' ');
    for (const t of tokens(text)) {
      if (t.kind === 'money' || t.kind === 'plain') out.money.push(t.value);
      if (t.kind === 'pct' || t.kind === 'plain') out.pct.push(t.value);
    }
    return out;
  }
  if (Array.isArray(v)) { for (const x of v) numbersIn(x, out, depth + 1, key); return out; }
  if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) numbersIn(x, out, depth + 1, k);
  return out;
}

const matches = (f: Figure, allowed: Allowed) => {
  if (f.value === 0 || (f.kind === 'pct' && f.value === 100)) return true;
  if (f.kind === 'money') return allowed.money.some((a) => Math.abs(a - f.value) <= f.tol);
  return allowed.pct.some((a) => Math.abs(a - f.value) <= f.tol || Math.abs(a * 100 - f.value) <= f.tol);
};

/** Figures in `text` that don't match any allowed number. */
export function ungrounded(text: string, allowed: Allowed): string[] {
  return [...new Set(figuresIn(text).filter((f) => !matches(f, allowed)).map((f) => f.raw))];
}

/**
 * Removes the sentences `drop` rejects, keeping list structure (a list item goes when all its sentences do).
 * Every sentence is judged on its own: a hedged sentence ("…, not a valuation") never shields an
 * unhedged one written on the same line. Lines with nothing removed are kept exactly as written.
 */
export function dropSentences(text: string, drop: (sentence: string) => boolean): { text: string; removed: number } {
  let removed = 0;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) { out.push(line); continue; }
    const m = line.match(/^(\s*(?:[-•*]|\d+\.)\s+)?([\s\S]*)$/)!;
    const parts = m[2].split(/(?<=[.!?])\s+(?=[A-Z£(*"“‘'])/);
    const kept = parts.filter((s) => {
      const bad = drop(s);
      if (bad) removed++;
      return !bad;
    });
    if (kept.length === parts.length) out.push(line);
    else if (kept.length) out.push(`${m[1] ?? ''}${kept.join(' ')}`);
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

/** Removes the sentences that carry unchecked figures, keeping list structure. */
export function stripUngrounded(text: string, allowed: Allowed): { text: string; removed: number } {
  return dropSentences(text, (s) => ungrounded(s, allowed).length > 0);
}
