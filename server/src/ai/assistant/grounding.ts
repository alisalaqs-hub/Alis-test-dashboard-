/**
 * Grounding check for the assistant's prose: every £ amount and percentage in a reply must
 * match a figure Streetkey produced (tool results, the page's property data) or one the person
 * wrote themselves, allowing for ordinary rounding. Anything else is treated as invented.
 */

export interface Figure { raw: string; value: number; tol: number; kind: 'money' | 'pct' }

const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };
const MONEY_RE = /£\s?(\d[\d,]*)(?:\.(\d+))?(?:\s?(k|m|bn)(?![a-z])|\s(thousand|million|billion)\b)?/gi;
const PCT_RE = /(\d[\d,]*)(?:\.(\d+))?\s?(?:%|per ?cent\b)/gi;
/** Any number in free text (tool strings, the person's messages), with an optional size suffix. */
const ANY_RE = /(\d[\d,]*)(?:\.(\d+))?\s?(k|m|bn|thousand|million|billion)?(?![a-z\d])/gi;

/** Value and the precision it was written to: "£485k" → 485,000 ± 500; "£1,800" → 1,800 ± 50. */
function parse(int: string, dec: string | undefined, suffix: string | undefined) {
  const digits = int.replace(/,/g, '');
  const mult = suffix ? MULT[suffix.toLowerCase()] ?? 1 : 1;
  const value = Number(`${digits}${dec ? `.${dec}` : ''}`) * mult;
  const zeros = dec ? 0 : (digits.match(/0+$/)?.[0].length ?? 0);
  const unit = (dec ? 10 ** -dec.length : /^0+$/.test(digits) ? 1 : 10 ** zeros) * mult;
  return { value, unit };
}

/** £ amounts and percentages written in a piece of text. */
export function figuresIn(text: string): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(MONEY_RE)) {
    const { value, unit } = parse(m[1], m[2], m[3] ?? m[4]);
    if (Number.isFinite(value)) out.push({ raw: m[0].trim(), value, kind: 'money', tol: Math.min(unit / 2, Math.max(0.5, value * 0.04)) });
  }
  for (const m of text.matchAll(PCT_RE)) {
    const { value, unit } = parse(m[1], m[2], undefined);
    if (Number.isFinite(value)) out.push({ raw: m[0].trim(), value, kind: 'pct', tol: Math.min(unit / 2, Math.max(0.05, value * 0.04)) });
  }
  return out;
}

/** Every number found in a value: numbers themselves and numbers written inside strings. */
export function numbersIn(v: unknown, out: number[] = [], depth = 0): number[] {
  if (depth > 8 || v == null) return out;
  if (typeof v === 'number') { if (Number.isFinite(v)) out.push(Math.abs(v)); return out; }
  if (typeof v === 'string') {
    for (const m of v.matchAll(ANY_RE)) {
      const { value } = parse(m[1], m[2], m[3]);
      if (Number.isFinite(value)) out.push(value);
      if (m[3]) { const bare = Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`); if (Number.isFinite(bare)) out.push(bare); }
    }
    return out;
  }
  if (Array.isArray(v)) { for (const x of v) numbersIn(x, out, depth + 1); return out; }
  if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) numbersIn(x, out, depth + 1);
  return out;
}

const matches = (f: Figure, allowed: number[]) =>
  f.value === 0 || (f.kind === 'pct' && f.value === 100) ||
  allowed.some((a) => Math.abs(a - f.value) <= f.tol || (f.kind === 'pct' && Math.abs(a * 100 - f.value) <= f.tol));

/** Figures in `text` that don't match any allowed number. */
export function ungrounded(text: string, allowed: number[]): string[] {
  return [...new Set(figuresIn(text).filter((f) => !matches(f, allowed)).map((f) => f.raw))];
}

/** Removes the sentences that carry unchecked figures, keeping list structure. */
export function stripUngrounded(text: string, allowed: number[]): { text: string; removed: number } {
  let removed = 0;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!ungrounded(line, allowed).length) { out.push(line); continue; }
    const m = line.match(/^(\s*(?:[-•*]|\d+\.)\s+)?([\s\S]*)$/)!;
    const kept = m[2].split(/(?<=[.!?])\s+(?=[A-Z£(*"“‘'])/).filter((s) => {
      const bad = ungrounded(s, allowed).length > 0;
      if (bad) removed++;
      return !bad;
    });
    if (kept.length) out.push(`${m[1] ?? ''}${kept.join(' ')}`);
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}
