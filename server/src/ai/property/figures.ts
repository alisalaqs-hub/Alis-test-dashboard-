/**
 * Keeps AI wording honest about money: finds every amount of money in a piece of text (with or
 * without a "£") and checks it against the figures Streetkey's engines computed. Statements quoting
 * any other amount are removed (the model may round, but it may not invent, add up or "estimate"
 * new figures). Percentages can be checked the same way against the percentages that were computed.
 */
import { createHash } from 'node:crypto';

export interface MoneyMention { raw: string; value: number; precision: number }
export type PercentMention = MoneyMention;

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?`;
const UNIT = String.raw`(k|m|bn|million|thousand|billion)?`;
const MONEY_RE = new RegExp(String.raw`(?:£|\bGBP\s?)\s?${NUM}\s?${UNIT}(?![a-z])|\b${NUM}\s?${UNIT}\s?(?:pounds|quid|GBP)\b`, 'gi');
const RANGE_TAIL = new RegExp(String.raw`^\s?(?:-|–|—|to)\s?(£)?${NUM}\s?${UNIT}(?![a-z])`, 'i');

/**
 * Amounts written without a currency sign. The model is told to use "£", so these are the backstop
 * for when it doesn't: "8k", "1.2m", "9 grand", "12 thousand", and big plain numbers ("12,000", "15000").
 * A bare "m" right after a number is read as millions unless it is clearly a measurement ("4m high").
 */
const METRES_CONTEXT = String.raw`(?![\s-]?(?:(?:wide|long|deep|depth|high|height|tall|width|by|at|from|rear|side|single|double|extension|garden|frontage|headroom|ridge|span|via)\b|x\s?\d|×))`;
const BARE_UNIT_RE = new RegExp(String.raw`(?<![\w.,£])${NUM}(?:\s?(k|bn)|(m)${METRES_CONTEXT}|\s?(grand|thousand|million|billion))(?![a-z\d²³])`, 'gi');
const BARE_RANGE_HEAD = /(?<![\w.,£])(\d+)(?:\.(\d+))?\s?(?:-|–|—|to)\s?$/i;
/** What may follow a big plain number when it is not money: units, counts and percentages. */
const NOT_MONEY_AFTER = String.raw`(?!\s?(?:%|per\s?cent|percent|m²|m³|(?:m2|m|mm|cm|km|sq|sqm|ft|kw|kg|nr)\b|sq\.|square|metres?|meters?|feet|foot|kwh|mwh|tonnes?|litres?|miles?|homes?|houses?|propert|listings?|people|households?|units?|flats?|rooms?|days?|weeks?|months?|years?|hours?|minutes?|sales?|transactions?|enquir|photos?|words?|characters?|times\b))`;
const BIG_RE = new RegExp(String.raw`(?<![\w.,£€$])(\d{1,3}(?:,\d{3})+|[1-9]\d{3,})(?:\.(\d+))?(?!\d|,\d|\.\d|[a-z])${NOT_MONEY_AFTER}`, 'gi');

const PCT_RE = /(?<![\w.,])(\d+)(?:\.(\d+))?\s?(?:%|per\s?cent\b|percent\b)/gi;
const PCT_RANGE_HEAD = /(?<![\w.,])(\d+)(?:\.(\d+))?\s?(?:-|–|—|to)\s?$/i;

const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, grand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };

function parse(intPart: string, dec: string | undefined, unit: string | undefined) {
  const mult = MULT[(unit ?? '').toLowerCase()] ?? 1;
  const digits = intPart.replace(/,/g, '');
  const value = Number(`${digits}${dec ? `.${dec}` : ''}`) * mult;
  // How precisely the figure was written: "£12,000" could be a rounded £11,600; "£12,345" is exact.
  const precision = dec ? mult / 10 ** dec.length : mult * 10 ** Math.min(digits.match(/0*$/)![0].length, digits.length - 1);
  return { value, precision: Math.max(precision, 1) };
}

/** Every amount of money written in the text (including both ends of "£12–14k", and amounts written without "£"). */
export function moneyMentions(text: string): MoneyMention[] {
  const found: { at: number; m: MoneyMention }[] = [];
  const push = (at: number, m: MoneyMention) => found.push({ at, m });
  const spans: [number, number][] = [];
  const free = (a: number, b: number) => !spans.some(([x, y]) => a < y && b > x);

  for (const m of text.matchAll(MONEY_RE)) {
    const [raw, i1, d1, u1, i2, d2, u2] = m;
    const start = m.index ?? 0;
    const intPart = i1 ?? i2; const dec = i1 ? d1 : d2; let unit = i1 ? u1 : u2;
    const tail = text.slice(start + raw.length).match(RANGE_TAIL);
    let second: MoneyMention | null = null;
    let end = start + raw.length;
    if (tail && (tail[1] || tail[4] || unit || tail[2].replace(/,/g, '').length >= 2)) {
      if (!unit && tail[4]) unit = tail[4]; // "£12–14k" means £12k to £14k
      // A second end written with its own "£" is found by the main pattern; otherwise read it here.
      if (!tail[1]) { second = { raw: tail[0].trim(), ...parse(tail[2], tail[3], tail[4] ?? unit) }; end += tail[0].length; }
    }
    push(start, { raw, ...parse(intPart, dec, unit) });
    if (second) push(start + raw.length, second);
    spans.push([start, end]);
  }

  for (const m of text.matchAll(BARE_UNIT_RE)) {
    const start = m.index ?? 0; const end = start + m[0].length;
    if (!free(start, end)) continue;
    const unit = m[3] ?? m[4] ?? m[5];
    if (m[4] && /(?:×|\bx|\bby)\s?$/i.test(text.slice(Math.max(0, start - 4), start))) continue; // "6m × 4m": metres
    const head = text.slice(0, start).match(BARE_RANGE_HEAD); // "8 to 12k" means 8k to 12k
    if (head && free(start - head[0].length, start)) push(start - head[0].length, { raw: head[0].trim(), ...parse(head[1], head[2], unit) });
    push(start, { raw: m[0], ...parse(m[1], m[2], unit) });
    spans.push([start, end]);
  }

  for (const m of text.matchAll(BIG_RE)) {
    const start = m.index ?? 0; const end = start + m[0].length;
    if (!free(start, end)) continue;
    const [raw, intPart, dec] = m;
    if (!intPart.includes(',') && !dec && intPart.length === 4 && Number(intPart) >= 1800 && Number(intPart) <= 2100) continue; // a year
    push(start, { raw, ...parse(intPart, dec, undefined) });
    spans.push([start, end]);
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.m); // in the order they appear
}

/** Every percentage written in the text (including both ends of "15–20%"), as written: "4.1%" → 4.1. */
export function percentMentions(text: string): PercentMention[] {
  const out: PercentMention[] = [];
  const read = (raw: string, int: string, dec: string | undefined) => ({ raw, value: Number(`${int}${dec ? `.${dec}` : ''}`), precision: dec ? 10 ** -dec.length : 1 });
  for (const m of text.matchAll(PCT_RE)) {
    const head = text.slice(0, m.index ?? 0).match(PCT_RANGE_HEAD);
    if (head) out.push(read(head[0].trim(), head[1], head[2]));
    out.push(read(m[0], m[1], m[2]));
  }
  return out;
}

/**
 * Is a written amount one of the allowed figures, allowing for the rounding it was written with?
 * "£47k" or "£46,800" for £46,812 is fine; rounding is never allowed to move a figure by more than 5%.
 */
export function isAllowed(m: MoneyMention, allowed: number[]) {
  return allowed.some((a0) => {
    const a = Math.abs(a0);
    const tol = Math.max(Math.min(m.precision / 2, a * 0.05), a * 0.015, 0.5);
    return Math.abs(m.value - a) <= tol;
  });
}

/**
 * Is a written percentage one of the allowed percentages (in percent, e.g. 4.1 for 4.1%)?
 * Within 0.15 points, or the rounding it was written with ("4%" for 4.4%).
 */
export function isPercentAllowed(m: PercentMention, allowed: number[]) {
  const tol = Math.max(0.15, m.precision / 2) + 1e-9;
  return allowed.some((a) => Math.abs(m.value - Math.abs(a)) <= tol);
}

/** Every percentage written anywhere inside a JSON-able value (e.g. the DATA given to the model), in percent. */
export function percentsIn(v: unknown): number[] {
  if (typeof v === 'string') return percentMentions(v).map((m) => m.value);
  if (Array.isArray(v)) return v.flatMap(percentsIn);
  if (v && typeof v === 'object') return Object.values(v).flatMap(percentsIn);
  return [];
}

const hasUnsupported = (s: string, allowed: number[], pct?: number[]) =>
  moneyMentions(s).some((m) => !isAllowed(m, allowed)) || (!!pct && percentMentions(s).some((m) => !isPercentAllowed(m, pct)));

/** Tidy model text: no control characters, collapsed spaces, a length cap. */
export function clean(s: string, max = 600) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max).trim();
}

/** Removes sentences quoting amounts that aren't in `allowed` (and, when `pct` is given, percentages that aren't in it). */
export function scrubText(text: string, allowed: number[], max = 900, pct?: number[]): { text: string; removed: number } {
  let removed = 0;
  const lines = clean(text, max * 2).split('\n').map((line) => line.split(/(?<=[.!?])\s+/).filter((sentence) => {
    const bad = hasUnsupported(sentence, allowed, pct);
    if (bad) removed++;
    return !bad;
  }).join(' '));
  return { text: clean(lines.join('\n'), max), removed };
}

/** Drops list items quoting amounts that aren't in `allowed` (or percentages not in `o.pct`); trims, de-duplicates and caps the list. */
export function scrubList(items: string[], allowed: number[], o: { max?: number; maxLen?: number; pct?: number[] } = {}): { items: string[]; removed: number } {
  let removed = 0;
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of items) {
    const s = clean(raw, o.maxLen ?? 320);
    if (!s) continue;
    if (hasUnsupported(s, allowed, o.pct)) { removed++; continue; }
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); kept.push(s);
  }
  return { items: kept.slice(0, o.max ?? 5), removed };
}

/** Amounts of money written inside engine-produced text (assumptions, grant notes, allowances). */
export const figuresInText = (texts: string[]) => texts.flatMap((t) => moneyMentions(t).map((m) => m.value));

/** Finite numbers only (JSON turns Infinity into null; NaN must never reach a prompt). */
export const finite = (n: number) => (Number.isFinite(n) ? n : null);
export const round = (n: number, to = 1) => Math.round(n / to) * to;

/**
 * Who an AI answer is for, and how to charge their allowance. `charge` is called only when the model is
 * actually about to be called (after validation and a cache miss), so rejected forms and cached answers
 * never use up anyone's AI allowance.
 */
export interface AiMeta { userId: string | null; charge?: () => Promise<unknown> }

/** Stable cache key for a JSON-able value. */
export const hashOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 40);
