/**
 * Listing facts as the AI listing tools receive them (the ListProperty form fields), plus the
 * statements code derives from them. Material information is written here, from the facts,
 * never by the model; the model only words the description around it.
 */
import { z } from 'zod';
import { POSTCODE_RE } from '../../../../src/engine/listings';
import { CONDITIONS, ERAS, PROPERTY_TYPES } from '../../services/listings';

/** Empty strings from form fields mean "not given". */
const blank = (v: unknown) => (v === '' || v === undefined ? null : v);
const optNum = (max: number, min = 0) => z.preprocess(blank, z.coerce.number().min(min).max(max).nullable()).optional();
const optInt = (max: number, min = 0) => z.preprocess(blank, z.coerce.number().int().min(min).max(max).nullable()).optional();
const optEnum = <T extends readonly [string, ...string[]]>(values: T) => z.preprocess(blank, z.enum(values).nullable()).optional();

export const FactsSchema = z.object({
  channel: z.enum(['sale', 'rent']),
  type: z.enum(PROPERTY_TYPES),
  beds: z.coerce.number().int().min(0).max(30),
  baths: z.coerce.number().int().min(0).max(30),
  floorArea: optNum(10_000),
  title: z.preprocess(blank, z.string().trim().max(120).nullable()).optional(),
  town: z.preprocess(blank, z.string().trim().max(80).nullable()).optional(),
  /** Outward code (e.g. E17). A full postcode is accepted and reduced to its outward code before any AI sees it. */
  district: z.preprocess(blank, z.string().trim().max(8).nullable()).optional(),
  postcode: z.preprocess(blank, z.string().trim().max(10).nullable()).optional(),
  tenure: optEnum(['freehold', 'leasehold', 'share-of-freehold'] as const),
  leaseYears: optInt(999, 1),
  epc: z.preprocess((v) => (typeof v === 'string' ? blank(v.trim().toUpperCase()) : blank(v)), z.string().regex(/^[A-G]$/, 'EPC rating is a letter A–G.').nullable()).optional(),
  councilTax: z.preprocess((v) => (typeof v === 'string' ? blank(v.trim().toUpperCase()) : blank(v)), z.string().regex(/^([A-I]|EXEMPT)$/, 'Council tax band is a letter A–H (I in Wales).').nullable()).optional(),
  condition: optEnum(CONDITIONS),
  era: optEnum(ERAS),
  features: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  price: optNum(100_000_000),
  serviceCharge: optNum(1_000_000),
  groundRent: optNum(1_000_000),
});
export type Facts = z.infer<typeof FactsSchema>;

const OUTWARD_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/;
/** The outward code only (never the full postcode) for anything sent to the model. */
export function outwardCode(f: Pick<Facts, 'district' | 'postcode'>): string | null {
  for (const v of [f.district, f.postcode]) {
    if (!v) continue;
    const s = v.toUpperCase().trim();
    const m = s.match(POSTCODE_RE);
    if (m) return m[1].toUpperCase();
    const head = s.split(/\s+/)[0];
    if (OUTWARD_RE.test(head)) return head;
  }
  return null;
}

export const gbpText = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
export const sqft = (m2: number) => Math.round(m2 * 10.764);
const TYPE_WORD: Record<Facts['type'], string> = { terraced: 'terraced house', 'semi-detached': 'semi-detached house', detached: 'detached house', flat: 'flat', bungalow: 'bungalow', commercial: 'commercial property' };
export const typeWord = (t: Facts['type']) => TYPE_WORD[t];
const TENURE_WORD = { freehold: 'Freehold', leasehold: 'Leasehold', 'share-of-freehold': 'Share of freehold' } as const;
const CONDITION_WORD: Record<string, string> = { good: 'good condition', fair: 'fair condition (some updating may suit)', poor: 'needs modernisation', derelict: 'needs major works' };
const ERA_WORD: Record<string, string> = { 'pre-1919': 'built before 1919', '1919-1944': 'built between 1919 and 1944', '1945-1979': 'built between 1945 and 1979', '1980-1999': 'built between 1980 and 1999', '2000+': 'built in 2000 or later' };

/** The facts as plain lines for the prompt (outward code only). */
export function factLines(f: Facts): string {
  const area = outwardCode(f);
  const lines = [
    `Listing: ${f.channel === 'rent' ? 'to let' : 'for sale'}`,
    f.price ? (f.channel === 'rent' ? `Rent: ${gbpText(f.price)} per calendar month (fixed)` : `Asking price: ${gbpText(f.price)}`) : 'Price: not given',
    `Property type: ${typeWord(f.type)}`,
    `Bedrooms: ${f.beds}${f.beds === 0 ? ' (studio)' : ''}; bathrooms: ${f.baths}`,
    f.floorArea ? `Floor area: ${Math.round(f.floorArea)} m² (about ${sqft(f.floorArea)} sq ft)` : 'Floor area: not given',
    `Location: ${[f.town, area].filter(Boolean).join(', ') || 'not given'}`,
    f.tenure ? `Tenure: ${TENURE_WORD[f.tenure]}${f.tenure !== 'freehold' && f.leaseYears ? `, ${f.leaseYears} years remaining on the lease` : ''}` : 'Tenure: not given',
    f.serviceCharge != null && f.tenure !== 'freehold' ? `Service charge: ${gbpText(f.serviceCharge)} a year` : '',
    f.groundRent != null && f.tenure !== 'freehold' ? `Ground rent: ${gbpText(f.groundRent)} a year` : '',
    `EPC rating: ${f.epc ?? 'not given'}`,
    `Council tax band: ${f.councilTax ? (f.councilTax === 'EXEMPT' ? 'exempt' : f.councilTax) : 'not given'}`,
    f.condition ? `Condition: ${CONDITION_WORD[f.condition]}` : '',
    f.era ? `Age: ${ERA_WORD[f.era]} (do not name a specific architectural period unless stated elsewhere)` : '',
    f.title ? `Seller's working title: ${f.title}` : '',
    `Features: ${f.features.length ? f.features.join('; ') : 'none listed'}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/** Material information statements derived only from the facts (NTS Parts A/B where known). */
export function materialInfo(f: Facts): string[] {
  const out: string[] = [];
  if (f.price) out.push(f.channel === 'rent' ? `Rent: ${gbpText(f.price)} per calendar month (fixed)` : `Asking price: ${gbpText(f.price)}`);
  if (f.tenure) {
    let t = `Tenure: ${TENURE_WORD[f.tenure]}`;
    if (f.tenure !== 'freehold' && f.leaseYears) t += ` (${f.leaseYears} years remaining on the lease)`;
    out.push(t);
  }
  if (f.tenure && f.tenure !== 'freehold') {
    if (f.serviceCharge != null) out.push(`Service charge: ${gbpText(f.serviceCharge)} a year`);
    if (f.groundRent != null) out.push(`Ground rent: ${gbpText(f.groundRent)} a year`);
  }
  if (f.councilTax) out.push(f.councilTax === 'EXEMPT' ? 'Council tax: exempt' : `Council tax band: ${f.councilTax}`);
  if (f.epc) out.push(`EPC rating: ${f.epc}`);
  out.push(`Property type: ${typeWord(f.type).replace(/^./, (c) => c.toUpperCase())}`);
  out.push(`Bedrooms: ${f.beds}; bathrooms: ${f.baths}`);
  if (f.floorArea) out.push(`Floor area: approx. ${Math.round(f.floorArea)} m² (${sqft(f.floorArea)} sq ft)`);
  return out;
}

/** Material information that is missing from the facts (checked in code, not by the model). */
export function missingFacts(f: Facts): string[] {
  const m: string[] = [];
  if (!f.price) m.push(f.channel === 'rent' ? 'Monthly rent' : 'Asking price');
  if (!f.epc) m.push('EPC rating (legally required before marketing)');
  if (!f.councilTax) m.push('Council tax band');
  if (!f.tenure) m.push('Tenure');
  if (f.tenure === 'leasehold' && !f.leaseYears) m.push('Years remaining on the lease');
  if (f.tenure && f.tenure !== 'freehold' && f.serviceCharge == null) m.push('Annual service charge');
  if (f.tenure === 'leasehold' && f.groundRent == null) m.push('Annual ground rent');
  if (!f.floorArea) m.push('Floor area');
  if (!f.town && !outwardCode(f)) m.push('Town or postcode district');
  if (f.channel === 'rent') m.push('Deposit amount (material information for lettings)');
  return m;
}

/** Money amounts the seller stated: the only £ figures AI text may contain. */
export function statedMoney(f: Facts): number[] {
  return [f.price, f.serviceCharge, f.groundRent].filter((n): n is number => n != null && n > 0);
}

/** Plain numbers the facts (and the seller's own notes) contain: the only figures AI text may use. */
export function statedNumbers(f: Facts, extraText: string[] = []): number[] {
  const nums = new Set<number>([f.beds, f.baths]);
  if (f.floorArea) { nums.add(Math.round(f.floorArea)); nums.add(f.floorArea); }
  if (f.leaseYears) nums.add(f.leaseYears);
  for (const n of statedMoney(f)) nums.add(n);
  for (const e of f.era?.match(/\d{4}/g) ?? []) nums.add(Number(e));
  for (const t of [f.title ?? '', f.town ?? '', ...f.features, ...extraText]) for (const n of numbersIn(t)) nums.add(n);
  return [...nums];
}

/** Numbers written with digits in a piece of text (1,250 → 1250; 2.5 → 2.5). Codes such as E17 or M25 are skipped. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z\d.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![A-Za-z\d.,])\d+(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
