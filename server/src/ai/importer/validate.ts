/**
 * Checks that what the model "read" is really in the pasted text: quotes must appear in it and
 * numbers must be written in it. Anything that fails is downgraded or dropped, so people only see
 * figures that came from the listing itself.
 */
import { normText } from '../../../../src/lib/ai/importer';

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

/* ───────────── does the quote support the value? ───────────── */
const close = (x: number, n: number) => Math.abs(x - n) < 0.01 || (n >= 10 && Math.round(x) === n);

/** Numbers written with digits, where they sit (end = end of the digits, so "67 m²" keeps "m²" after it). */
function numberTokens(s: string) {
  const out: { values: number[]; start: number; end: number }[] = [];
  for (const m of s.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s*(k|m|million|bn)\b)?/g)) {
    const n = Number.parseFloat(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);
    if (!Number.isFinite(n)) continue;
    const values = [n];
    if (m[3] === 'k') values.push(Math.round(n * 1000));
    if (m[3] === 'm' || m[3] === 'million') values.push(Math.round(n * 1_000_000));
    const start = m.index ?? 0;
    out.push({ values, start, end: start + m[1].length + (m[2] ? m[2].length + 1 : 0) });
  }
  return out;
}

export interface NumberContext { before: string; after: string }
/**
 * Where an amount is written, for checking its unit, period and what it belongs to. When the quote can be
 * found in the text, only the amount inside the quote counts; otherwise (a lightly paraphrased quote that
 * still contains the amount) every place it's written does. `before` is ~48 characters before the number;
 * `after` runs to the next number or £ sign. Both are lower-case with line breaks kept.
 */
export function contextsOf(amount: number, text: string, evidence: string | null): NumberContext[] {
  const body = normText(text);
  const flat = body.replace(/\n/g, ' '); // same positions; matches squash(text)
  const hits = numberTokens(body).filter((t) => t.values.some((v) => close(v, amount)));
  if (!hits.length) return [];
  let pick = hits;
  if (evidence) {
    const q = squash(evidence).replace(/^(\.\.\.|…)+|(\.\.\.|…)+$/g, '').trim();
    const spans: [number, number][] = [];
    if (q.length >= 2) for (let at = flat.indexOf(q); at >= 0 && spans.length < 20; at = flat.indexOf(q, at + 1)) spans.push([at, at + q.length]);
    if (spans.length) pick = hits.filter((t) => spans.some(([a, b]) => t.start >= a && t.end <= b));
    else if (![...numbersIn(evidence)].some((x) => close(x, amount))) return [];
  }
  return pick.map((t) => {
    const rest = body.slice(t.end, t.end + 48);
    const cut = rest.search(/£|\d/);
    return { before: body.slice(Math.max(0, t.start - 48), t.start), after: cut >= 0 ? rest.slice(0, cut) : rest };
  });
}

/**
 * Does the quote give this band straight after the keyword ("EPC rating: C", "Council tax band D")?
 * The first single letter after the keyword must be the band, so "EPC: C (potential B)" supports C, not B.
 */
export function bandIn(quote: string, key: RegExp, letter: string): boolean {
  for (const m of quote.matchAll(new RegExp(key.source, 'gi'))) {
    const from = (m.index ?? 0) + m[0].length;
    const after = quote.slice(from, from + 40).split(/[.;\n]/)[0];
    for (const l of after.matchAll(/(?:^|[^A-Za-z])([A-Za-z])(?![A-Za-z])/g)) {
      if (l[1] === 'a') continue; // the article, not a band
      if (l[1].toUpperCase() === letter.toUpperCase()) return true;
      break;
    }
  }
  return false;
}

const STOP = new Set(['the', 'and', 'with', 'for', 'from', 'into', 'its', 'this', 'that', 'very', 'fully', 'newly', 'recently', 'well', 'own', 'plus', 'near', 'close', 'has', 'have', 'are']);
/** Is a short phrase (an AI "feature") written in the text, or are all its content words? */
export function groundedPhrase(phrase: string, text: string): boolean {
  if (quoteIn(phrase, text)) return true;
  const words = new Set(squash(text).split(/[^a-z0-9]+/).filter(Boolean));
  const has = (w: string) => words.has(w) || words.has(w.replace(/e?s$/, '')) || words.has(`${w}s`) || words.has(`${w}es`);
  const content = squash(phrase).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  return content.length > 0 && content.every(has);
}

/**
 * Wording about who a home suits, or about schools, safety, crime or communities. Streetkey never adds it
 * (Equality Act 2010: no demographic steering), even when the listing itself says it.
 */
const STEER_PEOPLE = /\byoung (professionals?|couples?|famil(y|ies))\b|\bprofessionals only\b|\bfamilies\b|\bfamily[- ](home|area|neighbourhood|friendly|street)\b|\b(retirees?|retired|pensioners?|elderly|older (people|residents|buyers))\b|\bcouples?\b|\bstudents?\b|\bdownsizers?\b|\bfirst[- ]time buyers?\b|\b(children|kids)\b|\bschools?\b|\bcatchment\b|\bsafe (area|neighbourhood|street|location|place)\b|\bcrime\b|\bcommunity\b|\b(ethnic\w*|religio\w*|church(es)?|mosques?|synagogues?|temples?|gurdwaras?)\b/i;
const STEER_SUITS = /\b(ideal|perfect|suits?|suited|great) for\b/i;
export const steers = (s: string) => STEER_PEOPLE.test(s) || STEER_SUITS.test(s);
/** Legal conclusions are left to the rules' careful wording (and to a solicitor), never to the model's free text. */
export const LEGAL_CLAIM = /\b(illegal(ly)?|unlawful(ly)?|breach(es|ed|ing)?|criminal|offences?|fraud(ulent)?|scams?|sue|lawsuits?|prosecut\w*|non[- ]compliant|banned|prohibited)\b/i;
