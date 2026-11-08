/**
 * Checks that what the model "read" is really in the pasted text: quotes must appear in it and
 * numbers must be written in it. Anything that fails is downgraded or dropped, so people only see
 * figures that came from the listing itself.
 */
const WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, single: 1, double: 2 };

/** Lower-case, straight quotes, single spaces: for forgiving "is this quote in the text" checks. */
export const squash = (s: string) => s.toLowerCase().replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

/** Does the quote (ignoring case, spacing and quote styles, and a trailing "…") appear in the text? */
export function quoteIn(quote: string | null | undefined, text: string): boolean {
  if (!quote) return false;
  const qt = squash(quote).replace(/^(\.\.\.|…)+|(\.\.\.|…)+$/g, '').trim();
  if (qt.length < 2) return false;
  const body = squash(text);
  if (body.includes(qt)) return true;
  // Allow light paraphrase of punctuation: compare letters and digits only.
  const strip = (s: string) => s.replace(/[^a-z0-9£]+/g, '');
  return strip(qt).length >= 3 && strip(body).includes(strip(qt));
}

/** Every number written in the text: "£375,000" → 375000, "£1.2m" → 1200000, "450k" → 450000, "three" → 3. */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  const t = text.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(k|m|million|bn)?\b/g)) {
    const n = Number.parseFloat(m[1]);
    if (!Number.isFinite(n)) continue;
    out.add(n);
    if (m[2] === 'k') out.add(Math.round(n * 1000));
    if (m[2] === 'm' || m[2] === 'million') out.add(Math.round(n * 1_000_000));
  }
  for (const [w, n] of Object.entries(WORDS)) if (new RegExp(`\\b${w}\\b`).test(t)) out.add(n);
  return out;
}

/** Is this number written in the text (allowing for rounding of decimals)? */
export const numberIn = (n: number, nums: Set<number>) => nums.has(n) || [...nums].some((x) => Math.abs(x - n) < 0.01 || (n >= 10 && Math.round(x) === n));

/** A clean single-line string, without control characters, cut to length. */
export function clean(s: unknown, max: number): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Remove money figures the model may have added to free text (prices come from engines, not the model). */
export const noMoney = (s: string) => s.replace(/(about|around|roughly|approx\.?|approximately|c\.)?\s*£\s?\d[\d,.]*\s?(k|m|bn|million)?\b(\s*(per|a|\/)\s*(m²|m2|sq ?m|lm|metre|month|year|week))?/gi, '').replace(/\(\s*\)/g, '').replace(/\s+([,.;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
