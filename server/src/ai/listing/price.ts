/**
 * Price guide for sellers and landlords. The range is computed in code from Streetkey's
 * area evidence (src/engine/listings.ts, the same method as the listing form's price check);
 * the model only explains it and suggests positioning, and may not introduce new figures.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PROPERTIES } from '../../../../src/data/properties';
import { evidenceRange, SOLD_TYPE_LABEL, soldTypeFor } from '../../../../src/engine/evidence';
import { config } from '../../config';
import { soldAround } from '../../data/official';
import { lookupPostcode } from '../../data/postcodes';
import { areaEvidence } from '../../../../src/engine/listings';
import { regionFromPostcode } from '../../../../src/engine/refurb';
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

/** Condition adjustment applied to refurbished £/m² (matches the listing form's price check). */
export const CONDITION_ADJ: Record<(typeof CONDITIONS)[number], number> = { good: 0.97, fair: 0.9, poor: 0.8, derelict: 0.68 };

/** The engine's rent per m² falls back to sale values at this gross yield when a region has no rental comparables. */
export const ASSUMED_YIELD_PCT = 4.5;

/**
 * Demonstration lettings in the postcode's region: the comparables areaEvidence() averages for rent per m²
 * (the same filter as src/engine/listings.ts, counted here so the basis says what the rent really comes from).
 */
export function rentalComparables(postcode: string): number {
  const region = regionFromPostcode(postcode);
  return PROPERTIES.filter((p) => p.listing === 'rent' && !p.source && regionFromPostcode(p.postcode) === region).length;
}

export interface PriceRange {
  low: number; high: number; mid: number;
  /** evidence: which comparables the £/m² comes from ('assumed-yield' = sale values at ASSUMED_YIELD_PCT, no rental comparables). */
  /** demo: false when the range is the middle half of real HM Land Registry sold prices nearby (perM2 is then 0: sold prices don't record size). */
  basis: { n: number; scope: string; perM2: number; method: string; evidence: 'sales' | 'rentals' | 'assumed-yield'; demo: boolean };
  position: 'below' | 'within' | 'above' | null;
  /** Asking price vs the middle of the range, whole per cent (computed here, so the narrative may quote it). */
  askingVsMidPct: number | null;
}

/**
 * The range from real sold prices: the middle half of what similar homes nearby sold for in the last two to three
 * years (HM Land Registry). Sales only, and only when official data is switched on and there is enough evidence;
 * otherwise null, and the caller falls back to priceRange() below.
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

export function priceRange(i: PriceGuideIn): PriceRange | null {
  const ev = areaEvidence(i.postcode);
  if (!ev) return null;
  const rent = i.channel === 'rent';
  const perM2 = rent ? ev.rentPerM2 : ev.refurbishedPerM2 * CONDITION_ADJ[i.condition];
  const step = rent ? 25 : 1000;
  const r = (n: number) => Math.round(n / step) * step;
  const low = r(perM2 * i.floorArea * 0.92), high = r(perM2 * i.floorArea * 1.08), mid = r(perM2 * i.floorArea);
  const ask = i.askingPrice ?? null;
  const area = `±8% for ${Math.round(i.floorArea)} m²`;
  const s = (n: number) => (n === 1 ? '' : 's');
  let basis: PriceRange['basis'];
  if (!rent) {
    basis = { n: ev.n, scope: ev.scope, perM2: Math.round(perM2), evidence: 'sales', demo: true,
      method: `Average refurbished value per m² from ${ev.n} demonstration comparable${s(ev.n)} in ${ev.scope}, adjusted for ${i.condition} condition, ${area}.` };
  } else {
    const lets = rentalComparables(i.postcode);
    basis = lets
      ? { n: lets, scope: 'the wider region', perM2: Math.round(perM2), evidence: 'rentals', demo: true,
        method: `Average rent per m² from ${lets} demonstration rental comparable${s(lets)} in the wider region, ${area}.` }
      : { n: 0, scope: ev.scope, perM2: Math.round(perM2), evidence: 'assumed-yield', demo: true,
        method: `Average asking price per m² of ${ev.n} demonstration sale comparable${s(ev.n)} in ${ev.scope}, turned into a monthly rent at an assumed ${ASSUMED_YIELD_PCT}% gross yield (there are no rental comparables for this region yet), ${area}.` };
  }
  return {
    low, high, mid, basis,
    position: ask == null ? null : ask > high ? 'above' : ask < low ? 'below' : 'within',
    askingVsMidPct: ask == null || !mid ? null : Math.round(((ask - mid) / mid) * 100),
  };
}

const Narrative = S.obj({
  explanation: S.str('2 or 3 sentences explaining what the range is based on'),
  position: S.str('1 or 2 sentences on where the asking price sits; empty string if there is no asking price'),
  advice: S.arr(S.str('One short, practical positioning suggestion'), '2 to 4 items'),
});
export type NarrativeT = Infer<typeof Narrative>;

const fmt = (n: number, rent: boolean) => (rent ? `${gbpText(n)} per month` : gbpText(n));

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

const BIDDING = /\b(offers? (over|above|in excess)|bids?|bidding|highest offer|best offer|negotiable)\b/i;

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
  const rent = i.channel === 'rent';
  const deadline = meta.deadline ?? Date.now() + PRICE_TIMING.budgetMs;
  const allowedMoney = [range.low, range.high, ...(i.askingPrice ? [i.askingPrice] : [])];
  const real = !range.basis.demo;
  const allowedPct = [...(real ? [] : [8]), ...(range.basis.evidence === 'assumed-yield' ? [ASSUMED_YIELD_PCT] : []), ...(range.askingVsMidPct != null ? [Math.abs(range.askingVsMidPct)] : [])];
  const facts = [
    `Listing: ${rent ? 'to let (monthly rent)' : 'for sale'}`,
    `Property: ${i.beds}-bedroom ${typeWord(i.type)}, ${Math.round(i.floorArea)} m², ${i.condition} condition`,
    `Streetkey indicative range: ${fmt(range.low, rent)} to ${fmt(range.high, rent)}`,
    real
      ? `Basis: ${range.basis.method} These are real sold prices, but they don’t record floor area, bedrooms or condition.`
      : `Basis: ${range.basis.method} The comparables are demonstration data, not sold prices.`,
    i.askingPrice ? `Asking ${rent ? 'rent' : 'price'}: ${fmt(i.askingPrice, rent)} (${range.position} the range; ${Math.abs(range.askingVsMidPct ?? 0)}% ${(range.askingVsMidPct ?? 0) >= 0 ? 'above' : 'below'} its middle)` : `Asking ${rent ? 'rent' : 'price'}: not set yet`,
  ].join('\n');
  const system = [
    HOUSE_RULES,
    'You explain Streetkey’s indicative price range to a private seller or landlord and suggest how to position the listing.',
    `The only £ figures you may write are ${allowedMoney.map((m) => gbpText(m)).join(', ')}. The only percentages you may write are ${allowedPct.map((p) => `${p}%`).join(', ')}. Do not calculate or estimate any other figure (no other prices, rents, yields, costs or percentages).`,
    real
      ? 'The range is the middle half of real nearby sold prices, which don’t record size, bedrooms or condition. It shows the local market, not the value of this home: say so once, briefly. A larger or newly renovated home can fairly sit above it and a smaller or unmodernised one below it.'
      : 'It is an indicative range from limited demonstration evidence, not a valuation: say so once, briefly.',
    rent ? 'This is a letting: the rent must be advertised as one fixed monthly figure. Never suggest inviting offers, bids or a rent that is negotiable upwards.' : 'Do not suggest pressure tactics or misleading price claims.',
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
    if (rent) narrative = { ...narrative, advice: narrative.advice.filter((a) => !BIDDING.test(a)), position: sentences(narrative.position).filter((s) => !BIDDING.test(s)).join(' ') };
    if (!narrative.explanation) narrative.explanation = `This range is based on ${range.basis.method.charAt(0).toLowerCase()}${range.basis.method.slice(1)} It is indicative only, not a valuation.`;
    if (!i.askingPrice) narrative.position = '';
    return { narrative, regenerated, dropped };
  });
}

function tidy(n: NarrativeT): NarrativeT {
  return { explanation: n.explanation.trim().slice(0, 800), position: n.position.trim().slice(0, 500), advice: n.advice.map((a) => a.trim().slice(0, 240)).filter(Boolean).slice(0, 4) };
}
