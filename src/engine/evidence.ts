/**
 * Official open data, as Streetkey uses it: sold prices (HM Land Registry Price Paid Data),
 * flood risk (Environment Agency) and energy certificates (EPC register).
 *
 * This file holds the shared shapes and the pure sums built on them (medians, ranges, the
 * worst flood band), so the website and the server always agree. No network code here.
 * Nothing in this file is a valuation: it summarises what nearby homes actually sold for.
 */
import type { PropertyType } from './refurb';

/* ───────────────────────── sold prices ───────────────────────── */

/** Land Registry property types ("other" covers commercial and unusual residential sales). */
export type SoldType = 'detached' | 'semi-detached' | 'terraced' | 'flat' | 'other';
export const SOLD_TYPE_LABEL: Record<SoldType, string> = { detached: 'Detached', 'semi-detached': 'Semi-detached', terraced: 'Terraced', flat: 'Flat or maisonette', other: 'Other' };

export interface SoldSale {
  /** Land Registry transaction id. */
  id: string;
  /** House name or number and street, e.g. "12 Example Road" or "Flat 2, 14 Example Road". */
  address: string;
  street: string | null;
  town: string | null;
  postcode: string;
  price: number;
  /** YYYY-MM-DD: the completion date recorded by HM Land Registry. */
  date: string;
  type: SoldType;
  newBuild: boolean;
  tenure: 'freehold' | 'leasehold' | null;
  /** Metres from the centre of the search to the centre of this sale's postcode (not to the building). */
  distanceM: number | null;
}

export interface SoldStats {
  /** Sales counted (standard residential sales in the window). */
  count: number;
  months: number;
  median: number | null;
  /** Lower and upper quartile: half of sales fall between them. */
  low: number | null;
  high: number | null;
  byType: { type: SoldType; count: number; median: number }[];
  /** Calendar years, oldest first, for a simple trend. */
  byYear: { year: number; count: number; median: number }[];
}

/** Official House Price Index for the local authority (HM Land Registry / ONS). */
export interface HpiSummary {
  district: string;
  /** YYYY-MM of the latest published month. */
  month: string;
  averagePrice: number;
  /** Change in the average price over 12 months, in percent. */
  annualChangePct: number | null;
  byType: { type: SoldType; averagePrice: number }[];
  /** Monthly average prices, oldest first (up to 24 months). */
  series: { month: string; averagePrice: number }[];
}

export const quantile = (sorted: number[], qv: number): number | null => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * qv, lo = Math.floor(pos), hi = Math.ceil(pos);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
};
const med = (xs: number[]) => quantile([...xs].sort((a, b) => a - b), 0.5)!;
const monthsAgo = (now: Date, months: number) => { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10); };

/** Summary of sales in the last `months` months (default 12) plus a year-by-year median for the trend. */
export function soldStats(sales: SoldSale[], opts: { months?: number; now?: Date } = {}): SoldStats {
  const months = opts.months ?? 12, now = opts.now ?? new Date();
  const since = monthsAgo(now, months);
  const recent = sales.filter((s) => s.date >= since);
  const prices = recent.map((s) => s.price).sort((a, b) => a - b);
  const types = (['detached', 'semi-detached', 'terraced', 'flat', 'other'] as SoldType[])
    .map((type) => { const xs = recent.filter((s) => s.type === type).map((s) => s.price); return { type, count: xs.length, median: xs.length ? med(xs) : 0 }; })
    .filter((t) => t.count > 0);
  const years = new Map<number, number[]>();
  for (const s of sales) { const y = Number(s.date.slice(0, 4)); if (!years.has(y)) years.set(y, []); years.get(y)!.push(s.price); }
  const byYear = [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, xs]) => ({ year, count: xs.length, median: med(xs) }));
  return { count: recent.length, months, median: quantile(prices, 0.5), low: quantile(prices, 0.25), high: quantile(prices, 0.75), byType: types, byYear };
}

/** Streetkey's property types → the Land Registry type used to pick like-for-like sales. */
export function soldTypeFor(t: PropertyType | string | null | undefined): SoldType | null {
  switch (t) {
    case 'terraced': return 'terraced';
    case 'semi-detached': return 'semi-detached';
    case 'detached': return 'detached';
    case 'bungalow': return 'detached'; // Land Registry has no bungalow type; most are recorded as detached or semi-detached
    case 'flat': return 'flat';
    default: return null;
  }
}

export interface EvidenceRange {
  /** What the range is built from. */
  basis: 'same-type' | 'all-types' | 'none';
  type: SoldType | null;
  count: number;
  months: number;
  low: number | null;
  mid: number | null;
  high: number | null;
  /** Never 'high': sold prices don't record size or condition. */
  confidence: 'low' | 'medium';
  /** Where the asking price sits against the middle half of local sales. */
  position: 'below' | 'within' | 'above' | 'unknown';
  /** Asking price against the median, as a fraction (0.08 = 8% above). */
  askingVsMid: number | null;
  /** Plain-English steps, safe to show. */
  method: string[];
}

/**
 * Where an asking price sits against nearby sold prices. Uses like-for-like property types when
 * there are at least 5 such sales in the window, otherwise all nearby homes (flagged as weaker).
 * It widens from 24 to 36 months when evidence is thin. Not a valuation.
 */
export function evidenceRange(sales: SoldSale[], subject: { type?: SoldType | null; price?: number | null }, opts: { now?: Date } = {}): EvidenceRange {
  const now = opts.now ?? new Date();
  const none: EvidenceRange = { basis: 'none', type: subject.type ?? null, count: 0, months: 24, low: null, mid: null, high: null, confidence: 'low', position: 'unknown', askingVsMid: null, method: ['There aren’t enough recent sold prices nearby to give a range.'] };
  for (const months of [24, 36]) {
    const recent = sales.filter((s) => s.date >= monthsAgo(now, months) && s.type !== 'other');
    const same = subject.type ? recent.filter((s) => s.type === subject.type) : [];
    const pool = same.length >= 5 ? same : recent.length >= 5 ? recent : null;
    if (!pool) continue;
    const basis = pool === same ? 'same-type' as const : 'all-types' as const;
    const prices = pool.map((s) => s.price).sort((a, b) => a - b);
    const low = quantile(prices, 0.25)!, mid = quantile(prices, 0.5)!, high = quantile(prices, 0.75)!;
    const price = subject.price ?? null;
    const position = price == null ? 'unknown' as const : price < low ? 'below' as const : price > high ? 'above' as const : 'within' as const;
    const what = basis === 'same-type' ? `${SOLD_TYPE_LABEL[subject.type!].toLowerCase()} homes` : 'homes of all types';
    return {
      basis, type: subject.type ?? null, count: pool.length, months, low, mid, high,
      confidence: basis === 'same-type' && pool.length >= 10 ? 'medium' : 'low', position,
      askingVsMid: price != null && mid ? (price - mid) / mid : null,
      method: [
        `${pool.length} ${what} sold nearby in the last ${months} months (HM Land Registry).`,
        'The range is the middle half of those sale prices; the midpoint is the median.',
        ...(basis === 'all-types' ? ['There were too few sales of the same property type, so all types are included: treat it as a rough guide.'] : []),
        'Sold prices don’t record size, bedrooms or condition, so a larger or newly renovated home can sit above the range and a smaller or unmodernised one below it. Not a valuation.',
      ],
    };
  }
  return none;
}

/* ───────────────────────── flood risk ───────────────────────── */

/** Environment Agency long-term risk bands (chance of flooding in any year). */
export type FloodBand = 'high' | 'medium' | 'low' | 'very low';
export const FLOOD_BAND_MEANING: Record<FloodBand, string> = {
  high: 'greater than 3.3% chance each year',
  medium: 'between 1% and 3.3% chance each year',
  low: 'between 0.1% and 1% chance each year',
  'very low': 'less than 0.1% chance each year',
};
const BAND_ORDER: FloodBand[] = ['very low', 'low', 'medium', 'high'];
/** The most serious of several bands (null when none were found). */
export function worstBand(bands: (FloodBand | null | undefined)[]): FloodBand | null {
  let worst: FloodBand | null = null;
  for (const b of bands) if (b && (worst == null || BAND_ORDER.indexOf(b) > BAND_ORDER.indexOf(worst))) worst = b;
  return worst;
}
/** "Very low" → 'very low' etc.; anything unrecognised → null. */
export function parseBand(s: unknown): FloodBand | null {
  const v = String(s ?? '').trim().toLowerCase();
  return (BAND_ORDER as string[]).includes(v) ? (v as FloodBand) : null;
}

export interface FloodSource {
  /** Risk at the location itself (within about 15 m of the point checked). */
  here: FloodBand;
  /** The highest risk mapped within about 100 m. */
  nearby: FloodBand;
}
export interface FloodWarning {
  /** 1 severe flood warning, 2 flood warning, 3 flood alert, 4 warning no longer in force. */
  level: 1 | 2 | 3 | 4;
  severity: string;
  area: string;
  message: string;
  changedAt: string | null;
}
export interface FloodResult {
  /** 'england' when the Environment Agency maps cover the location; otherwise nothing below is filled in. */
  coverage: 'england' | 'not-covered';
  country: string | null;
  /** Rivers and the sea, taking flood defences into account. null = the map couldn't be read just now. */
  riversAndSea: FloodSource | null;
  /** Surface water (heavy rain that can't drain away). */
  surfaceWater: FloodSource | null;
  /** The more serious of the two "here" bands. */
  overall: FloodBand | null;
  /** Current flood alerts and warnings within about 5 km. */
  warnings: FloodWarning[];
  /** Flood warning or alert areas that include places within about 1 km. */
  warningAreas: string[];
  /** True when the location is a postcode centre or an approximate point rather than the building itself. */
  approximate: boolean;
  checkedAt: string;
}

/* ───────────────────────── energy certificates ───────────────────────── */

export type EpcBand = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export interface EpcSummary {
  certificateNumber: string;
  /** Address as recorded on the certificate. */
  address: string;
  postcode: string;
  band: EpcBand | null;
  registeredOn: string | null;
}
export interface EpcCertificate extends EpcSummary {
  score: number | null;
  potentialBand: EpcBand | null;
  potentialScore: number | null;
  floorAreaM2: number | null;
  dwellingType: string | null;
  /** Certificates are valid for 10 years from registration. */
  expired: boolean;
  /** Yearly heating, hot water and lighting cost on the certificate, when given (£). */
  yearlyCost: { current: number | null; potential: number | null };
  /** Recommended improvements on the certificate: indicative cost (as printed, e.g. "£100 - £350") and typical yearly saving (£). */
  improvements: { cost: string | null; saving: number | null }[];
}
export const isEpcBand = (s: unknown): s is EpcBand => typeof s === 'string' && /^[A-G]$/.test(s);
export const epcExpired = (registeredOn: string | null, now = new Date()) => {
  if (!registeredOn) return false;
  const d = new Date(registeredOn); d.setUTCFullYear(d.getUTCFullYear() + 10);
  return d.getTime() < now.getTime();
};

/* ───────────────────────── attribution (must be shown wherever the data is) ───────────────────────── */

export const ATTRIBUTION = {
  landRegistry: 'Contains HM Land Registry data © Crown copyright and database right 2026. This data is licensed under the Open Government Licence v3.0.',
  environmentAgency: 'Contains Environment Agency information © Environment Agency and/or database right. Licensed under the Open Government Licence v3.0.',
  epc: 'Energy certificate data from the Ministry of Housing, Communities and Local Government, licensed under the Open Government Licence v3.0. Address data © Royal Mail and Ordnance Survey, used for the permitted purpose of promoting understanding of energy efficiency in the building sale and rental markets.',
  postcodes: 'Postcode locations from postcodes.io: contains OS data © Crown copyright and database right, Royal Mail data © Royal Mail copyright and database right, and National Statistics data © Crown copyright and database right.',
} as const;
