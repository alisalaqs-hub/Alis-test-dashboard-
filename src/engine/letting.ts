/**
 * Letting details on rental listings: what a landlord states (deposit, when it is available, furnishing and
 * so on), how those are worded for the public, and the deposit cap.
 *
 * Shared by the listing form, the listing page, search cards and the server, so it has no imports and, like
 * src/engine/listings.ts, never uses regex lookbehind (Safari before 16.4 can't parse it).
 *
 * The deposit cap is the rule for England (Tenant Fees Act 2019): five weeks' rent when the yearly rent is
 * under £50,000 and six weeks' rent when it is £50,000 or more. It is a warning for the lister, never a block.
 */

export const FURNISHINGS = ['furnished', 'part-furnished', 'unfurnished'] as const;
export const LET_TYPES = ['whole', 'room', 'hmo'] as const;
export const HMO_LICENCES = ['licensed', 'applied', 'not-required'] as const;
export type Furnishing = (typeof FURNISHINGS)[number];
export type LetType = (typeof LET_TYPES)[number];
export type HmoLicence = (typeof HMO_LICENCES)[number];

/** Letting details for a rental. Every field is optional: only what the lister has said is kept and shown. */
export interface Letting {
  /** The tenancy deposit, in pounds. */
  deposit?: number | null;
  /** The first day it can be moved into, as YYYY-MM-DD. Empty or in the past: available now. */
  availableFrom?: string | null;
  furnished?: Furnishing | null;
  petsConsidered?: boolean | null;
  billsIncluded?: boolean | null;
  maxOccupants?: number | null;
  /** The whole property, a room in a shared home, or a house in multiple occupation. */
  letType?: LetType | null;
  /** Asked only for a house in multiple occupation. */
  hmoLicence?: HmoLicence | null;
  /** The lister says a registered exemption allows an EPC rating of F or G. */
  epcExemption?: boolean | null;
}

export const FURNISHING_LABEL: Record<Furnishing, string> = { furnished: 'Furnished', 'part-furnished': 'Part furnished', unfurnished: 'Unfurnished' };
export const LET_TYPE_LABEL: Record<LetType, string> = { whole: 'Whole property', room: 'Room in a shared home', hmo: 'House in multiple occupation (HMO)' };
export const HMO_LICENCE_LABEL: Record<HmoLicence, string> = { licensed: 'Licensed', applied: 'Licence applied for', 'not-required': 'Licence not required' };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Whether a string is a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
/** Today as YYYY-MM-DD, in the reader's own time zone. */
export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "1 December 2026" (or "1 Dec" / "1 Dec 2027" in the short form, which leaves out the current year). */
export function dateText(iso: string, o: { short?: boolean; today?: string } = {}): string {
  const m = ISO_DATE.exec(iso);
  if (!m) return '';
  const month = MONTHS[Number(m[2]) - 1] ?? '';
  const day = Number(m[3]);
  if (!o.short) return `${day} ${month} ${m[1]}`;
  const thisYear = (o.today ?? todayIso()).slice(0, 4);
  return `${day} ${month.slice(0, 3)}${m[1] === thisYear ? '' : ` ${m[1]}`}`;
}
/** Whether the home can be moved into now: no date given, or the date is today or has passed. */
export const availableNow = (availableFrom: string | null | undefined, today = todayIso()) => !isIsoDate(availableFrom) || availableFrom <= today;
/** "Available now" or "Available 1 Dec" (short), "Available from 1 December 2026" (long). */
export function availableText(availableFrom: string | null | undefined, o: { short?: boolean; today?: string } = {}): string {
  const today = o.today ?? todayIso();
  if (availableNow(availableFrom, today)) return 'Available now';
  return o.short ? `Available ${dateText(availableFrom!, { short: true, today })}` : `Available from ${dateText(availableFrom!)}`;
}

export const gbpWhole = (n: number) => `£${Math.floor(n).toLocaleString('en-GB')}`;
/** Weekly rent from a monthly rent: monthly × 12 ÷ 52. */
export const weeklyRent = (monthlyRent: number) => (monthlyRent * 12) / 52;

const WEEKS_WORD: Record<number, string> = { 5: 'five', 6: 'six' };
/** The most a landlord in England can take as a deposit for this monthly rent (null until there is a rent). */
export function depositCap(monthlyRent: number): { weeks: 5 | 6; amount: number } | null {
  if (!(monthlyRent > 0) || !Number.isFinite(monthlyRent)) return null;
  const weeks = monthlyRent * 12 >= 50_000 ? 6 : 5;
  return { weeks, amount: weeklyRent(monthlyRent) * weeks };
}
/** Whether an amount is above a cap by more than half a penny (so a deposit of exactly the cap, however it is worked out, is fine). */
export const aboveCap = (amount: number, cap: number) => amount - cap > 0.005;
/** "In England the most a landlord can take as a deposit is five weeks’ rent (£1,846 here)." */
export function depositCapText(monthlyRent: number): string | null {
  const cap = depositCap(monthlyRent);
  return cap ? `In England the most a landlord can take as a deposit is ${WEEKS_WORD[cap.weeks]} weeks’ rent (${gbpWhole(cap.amount)} here).` : null;
}
/** The warning for a deposit above the cap, or null when it is within it (or there is no rent or deposit to compare). */
export function depositWarning(deposit: number | null | undefined, monthlyRent: number): string | null {
  const cap = depositCap(monthlyRent);
  if (deposit == null || !cap || !(deposit > 0) || !aboveCap(deposit, cap.amount)) return null;
  return depositCapText(monthlyRent);
}

/** The exemption only matters, and is only shown, when the rating is F or G. */
export const epcNeedsExemption = (epc: string | null | undefined) => /^[FG]$/i.test((epc ?? '').trim());

const isOneOf = <T extends string>(values: readonly T[], v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);
/**
 * Letting details as they are stored and shown: known values only, in one order. Anything that isn't a
 * valid value is dropped; the HMO licence is kept only for a house in multiple occupation. Null when nothing is known.
 */
export function cleanLetting(raw: unknown): Letting | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: Letting = {};
  const deposit = typeof r.deposit === 'number' ? r.deposit : typeof r.deposit === 'string' && r.deposit.trim() ? Number(r.deposit) : NaN;
  if (Number.isFinite(deposit) && deposit >= 0 && deposit <= 1_000_000) out.deposit = Math.round(deposit * 100) / 100;
  if (isIsoDate(r.availableFrom)) out.availableFrom = r.availableFrom;
  if (isOneOf(FURNISHINGS, r.furnished)) out.furnished = r.furnished;
  if (typeof r.petsConsidered === 'boolean') out.petsConsidered = r.petsConsidered;
  if (typeof r.billsIncluded === 'boolean') out.billsIncluded = r.billsIncluded;
  const occupants = typeof r.maxOccupants === 'number' ? r.maxOccupants : typeof r.maxOccupants === 'string' && r.maxOccupants.trim() ? Number(r.maxOccupants) : NaN;
  if (Number.isInteger(occupants) && occupants >= 1 && occupants <= 50) out.maxOccupants = occupants;
  if (isOneOf(LET_TYPES, r.letType)) out.letType = r.letType;
  if (out.letType === 'hmo' && isOneOf(HMO_LICENCES, r.hmoLicence)) out.hmoLicence = r.hmoLicence;
  if (r.epcExemption === true) out.epcExemption = true;
  return Object.keys(out).length ? out : null;
}

/** What the listing page and search cards need to word the letting details. */
export interface LetFacts { listing: string; price?: number; letting?: Letting | null; epc?: { current: string } | string | null }

export interface LettingRow { label: string; value: string }
/**
 * The letting details as label and value rows for the listing page, only for what is known. An unticked
 * "pets considered" says nothing (tenants can ask), so it has no row.
 */
export function lettingRows(p: LetFacts, today = todayIso()): LettingRow[] {
  const l = p.listing === 'rent' ? p.letting : null;
  if (!l) return [];
  const rows: LettingRow[] = [];
  if (l.deposit != null) rows.push({ label: 'Deposit', value: l.deposit > 0 ? `£${l.deposit.toLocaleString('en-GB', { maximumFractionDigits: 2 })}` : 'No deposit' });
  rows.push({ label: 'Available from', value: availableNow(l.availableFrom, today) ? 'Now' : dateText(l.availableFrom!) });
  if (l.furnished) rows.push({ label: 'Furnishing', value: FURNISHING_LABEL[l.furnished] });
  if (l.petsConsidered) rows.push({ label: 'Pets', value: 'Considered' });
  if (l.billsIncluded != null) rows.push({ label: 'Bills', value: l.billsIncluded ? 'Included in the rent' : 'Not included' });
  if (l.maxOccupants != null) rows.push({ label: 'Maximum occupants', value: String(l.maxOccupants) });
  if (l.letType) rows.push({ label: 'Let type', value: LET_TYPE_LABEL[l.letType] });
  if (l.letType === 'hmo' && l.hmoLicence) rows.push({ label: 'HMO licence', value: HMO_LICENCE_LABEL[l.hmoLicence] });
  const epc = (typeof p.epc === 'string' ? p.epc : p.epc?.current ?? '').toUpperCase();
  if (l.epcExemption && epcNeedsExemption(epc)) rows.push({ label: 'Energy rating', value: `${epc} (registered exemption)` });
  return rows;
}

/** A short line for search cards: "Available 1 Dec · Furnished", "Available now · Unfurnished". Empty for sales or when nothing is known. */
export function lettingLine(p: LetFacts, today = todayIso()): string {
  const l = p.listing === 'rent' ? p.letting : null;
  if (!l) return '';
  return [availableText(l.availableFrom, { short: true, today }), l.furnished ? FURNISHING_LABEL[l.furnished] : ''].filter(Boolean).join(' · ');
}
