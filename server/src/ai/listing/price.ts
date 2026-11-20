/**
 * Price guide for sellers. The range is computed in code from real sold prices nearby (HM Land Registry);
 * the model only explains it and suggests positioning, and may not introduce new figures.
 *
 * There is no guide without that evidence: a sale with too few recent sold prices nearby gets a plain "we
 * can't check this price yet", and a let gets none at all (there is no real source of rents to compare with).
 * Nothing here is worked out from example listings.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { evidenceRange, SOLD_TYPE_LABEL, soldTypeFor } from '../../../../src/engine/evidence';
import { config } from '../../config';
import { soldAround } from '../../data/official';
import { lookupPostcode } from '../../data/postcodes';
import { cached, chatJSON, HOUSE_RULES, untrusted } from '../core';
import { S, type Infer } from '../schema';
import { CONDITIONS, PROPERTY_TYPES } from '../../services/listings';
import { gbpText, typeWord } from './facts';
import { isStated, moneyMatchesIn, sentences } from './wording';

export const PriceGuideBody = z.object({
  postcode: z.string().trim().min(2).max(10).regex(/^[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?$/i, 'Enter a UK postcode or postcode district, e.g. E17 or E17 4QH.'),
  type: z.enum(PROPERTY_TYPES),
  beds: z.coerce.number().int().min(0).max(30),
  floorArea: z.coerce.number().min(10, 'Add the floor area (m²) to get a price guide.').max(10_000),
  condition: z.enum(CONDITIONS).default('fair'),
  channel: z.enum(['sale', 'rent']),
  askingPrice: z.preprocess((v) => (v === '' || v === 0 ? null : v), z.coerce.number().positive().max(100_000_000).nullable()).optional(),
});
export type PriceGuideIn = z.infer<typeof PriceGuideBody>;

/** What the price guide says when it has nothing real to compare with. */
export const NO_SALE_EVIDENCE = 'We can’t check this price yet: there aren’t enough recent sold prices near this postcode.';
export const NO_RENT_EVIDENCE = 'We don’t check rents: there is no record of what homes nearby actually let for to compare with.';

export interface PriceRange {
  low: number; high: number; mid: number;
  /**
   * What the range is: the middle half of real HM Land Registry sold prices nearby. evidence is always 'sales' and
   * demo always false (kept so the website can tell this answer from older servers'); perM2 is 0, as sold prices
   * don't record size.
   */
  basis: { n: number; scope: string; perM2: number; method: string; evidence: 'sales'; demo: false };
  position: 'below' | 'within' | 'above' | null;
  /** Asking price vs the middle of the range, whole per cent (computed here, so the narrative may quote it). */
  askingVsMidPct: number | null;
}

/**
 * The range from real sold prices: the middle half of what similar homes nearby sold for in the last two to three
 * years (HM Land Registry). Sales only, and only when official data is switched on and there is enough evidence;
 * otherwise null, and there is no price guide.
 */
export async function officialPriceRange(i: PriceGuideIn): Promise<PriceRange | null> {
  if (i.channel !== 'sale' || config.data.disabled) return null;
  const place = await lookupPostcode(i.postcode);
  if (!place) return null;
  const sold = await soldAround(place, { years: 3 });
  if (sold.coverage !== 'england-wales') return null;
  const type = soldTypeFor(i.type);
  const r = evidenceRange(sold.sales, { type, price: i.askingPrice ?? null });
  if (r.basis === 'none' || r.low == null || r.mid == null || r.high == null) return null;
  const what = r.basis === 'same-type' && type ? `${SOLD_TYPE_LABEL[type].toLowerCase()} homes` : 'homes of all types';
  return {
    low: r.low, high: r.high, mid: r.mid,
    basis: {
      n: r.count, scope: `within about ${sold.radiusM} m of ${place.label}`, perM2: 0, evidence: 'sales', demo: false,
      method: `The middle half of the prices paid for ${r.count} ${what} sold within about ${sold.radiusM} m in the last ${r.months} months (HM Land Registry sold prices).`,
    },
    position: r.position === 'unknown' ? null : r.position,
    askingVsMidPct: r.askingVsMid == null ? null : Math.round(r.askingVsMid * 100),
  };
}

const Narrative = S.obj({
  explanation: S.str('2 or 3 sentences explaining what the range is based on'),
  position: S.str('1 or 2 sentences on where the asking price sits; empty string if there is no asking price'),
  advice: S.arr(S.str('One short, practical positioning suggestion'), '2 to 4 items'),
});
export type NarrativeT = Infer<typeof Narrative>;

/** £ figures (and percentages) in the narrative that aren't the range ends or the asking price. */
export function strayFigures(n: NarrativeT, allowedMoney: number[], allowedPct: number[]): string[] {
  const text = [n.explanation, n.position, ...n.advice].join(' \n ');
  const bad: string[] = [];
  // Exact figures only (£525k for 525,000 is fine; £528,000 is not, however close).
  for (const a of moneyMatchesIn(text)) if (!allowedMoney.some((m) => isStated(a, m))) bad.push(gbpText(a.amount));
  for (const m of text.matchAll(/(-?\d+(?:\.\d+)?)\s?(%|per ?cent)/gi)) { const p = Math.abs(Number(m[1])); if (!allowedPct.includes(p)) bad.push(`${m[1]}%`); }
  return bad;
}

/** Drops sentences that still contain figures we didn't supply. */
function dropFigures(n: NarrativeT, allowedMoney: number[], allowedPct: number[]): NarrativeT {
  const ok = (s: string) => strayFigures({ explanation: s, position: '', advice: [] }, allowedMoney, allowedPct).length === 0;
  const clean = (t: string) => sentences(t).filter(ok).join(' ');
  return { explanation: clean(n.explanation), position: clean(n.position), advice: n.advice.filter(ok) };
}

/**
 * Time budget for one price-guide request: Netlify synchronous functions must answer within 30 seconds,
 * so both model calls share one deadline, and the retry is skipped when too little time is left.
 * (Mutable so tests can shorten it.)
 */
export const PRICE_TIMING = { budgetMs: 22_000, minRetryMs: 8_000 };

/**
 * The AI explanation, validated: only low, high and asking may appear as £ figures. Regenerates once (time allowing), then drops figures.
 * meta.charge is called only when the model is about to be asked (not for a cached explanation), to charge the AI allowance.
 */
export async function priceNarrative(i: PriceGuideIn, range: PriceRange, meta: { userId?: string | null; deadline?: number; charge?: () => Promise<unknown> }): Promise<{ narrative: NarrativeT; regenerated: boolean; dropped: boolean }> {
  const deadline = meta.deadline ?? Date.now() + PRICE_TIMING.budgetMs;
  const allowedMoney = [range.low, range.high, ...(i.askingPrice ? [i.askingPrice] : [])];
  const allowedPct = range.askingVsMidPct != null ? [Math.abs(range.askingVsMidPct)] : [];
  const facts = [
    'Listing: for sale',
    `Property: ${i.beds}-bedroom ${typeWord(i.type)}, ${Math.round(i.floorArea)} m², ${i.condition} condition`,
    `Streetkey indicative range: ${gbpText(range.low)} to ${gbpText(range.high)}`,
    `Basis: ${range.basis.method} These are real sold prices, but they don’t record floor area, bedrooms or condition.`,
    i.askingPrice ? `Asking price: ${gbpText(i.askingPrice)} (${range.position} the range; ${Math.abs(range.askingVsMidPct ?? 0)}% ${(range.askingVsMidPct ?? 0) >= 0 ? 'above' : 'below'} its middle)` : 'Asking price: not set yet',
  ].join('\n');
  const system = [
    HOUSE_RULES,
    'You explain Streetkey’s indicative price range to a private seller and suggest how to position the listing.',
    `The only £ figures you may write are ${allowedMoney.map((m) => gbpText(m)).join(', ')}. ${allowedPct.length ? `The only percentage you may write is ${allowedPct[0]}%.` : 'Do not write any percentage.'} Do not calculate or estimate any other figure (no other prices, rents, yields, costs or percentages).`,
    'The range is the middle half of real nearby sold prices, which don’t record size, bedrooms or condition. It shows the local market, not the value of this home: say so once, briefly. A larger or newly renovated home can fairly sit above it and a smaller or unmodernised one below it.',
    'Do not suggest pressure tactics or misleading price claims.',
    'Advice should be practical: presentation, photos, accurate details, realistic pricing, reviewing interest after a few weeks. British English, no emojis.',
  ].join('\n');
  const ask = (extra?: string) => chatJSON<NarrativeT>([
    { role: 'system', content: system },
    { role: 'user', content: `${untrusted('price_facts', facts)}${extra ? `\n\n${extra}` : ''}` },
  ], Narrative, 'listing_price_narrative', { purpose: 'listing.price_guide', userId: meta.userId, role: 'fast', maxTokens: 1200, effort: 'low', timeoutMs: Math.max(0, deadline - Date.now()) });

  const key = `listing.price:${createHash('sha256').update(JSON.stringify([i.channel, i.type, i.beds, Math.round(i.floorArea), i.condition, range.low, range.high, i.askingPrice ?? null, range.basis.method])).digest('hex')}`;
  return cached(key, 6 * 3600, async () => {
    await meta.charge?.();
    let narrative = tidy(await ask());
    let regenerated = false, dropped = false;
    let bad = strayFigures(narrative, allowedMoney, allowedPct);
    if (bad.length && deadline - Date.now() >= PRICE_TIMING.minRetryMs) {
      regenerated = true;
      narrative = tidy(await ask(`Your previous answer used figures that are not allowed (${bad.slice(0, 4).join(', ')}). Rewrite it using only the permitted figures, or none.`));
      bad = strayFigures(narrative, allowedMoney, allowedPct);
    }
    // Not enough time to ask again, or the retry still added figures: drop the sentences that contain them.
    if (bad.length) { narrative = dropFigures(narrative, allowedMoney, allowedPct); dropped = true; }
    if (!narrative.explanation) narrative.explanation = `This range is based on ${range.basis.method.charAt(0).toLowerCase()}${range.basis.method.slice(1)} It is indicative only, not a valuation.`;
    if (!i.askingPrice) narrative.position = '';
    return { narrative, regenerated, dropped };
  });
}

function tidy(n: NarrativeT): NarrativeT {
  return { explanation: n.explanation.trim().slice(0, 800), position: n.position.trim().slice(0, 500), advice: n.advice.map((a) => a.trim().slice(0, 240)).filter(Boolean).slice(0, 4) };
}
