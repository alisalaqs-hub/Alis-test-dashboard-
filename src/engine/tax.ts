/**
 * UK property transaction taxes — deterministic, no AI involvement.
 *
 * England & Northern Ireland: Stamp Duty Land Tax (SDLT)
 * Wales: Land Transaction Tax (LTT)
 * Scotland: Land and Buildings Transaction Tax (LBTT) + Additional Dwelling Supplement (ADS)
 *
 * Residential rates as configured below. RATES_EFFECTIVE records the
 * date the table was last reviewed. Tax rules change at fiscal events —
 * production must load these tables from a versioned, reviewed config
 * store, not code, and every output must cite the table version used.
 */

export type Nation = 'england' | 'wales' | 'scotland' | 'northern-ireland';
export type BuyerType = 'first-time' | 'home-mover' | 'additional';

export interface Band { upTo: number; rate: number }

export const RATES_EFFECTIVE = '2026-11-01 (review: SDLT rates from 1 Apr 2025; LTT from 11 Dec 2024; LBTT/ADS from 5 Dec 2024)';

const SDLT_STANDARD: Band[] = [
  { upTo: 125_000, rate: 0 },
  { upTo: 250_000, rate: 0.02 },
  { upTo: 925_000, rate: 0.05 },
  { upTo: 1_500_000, rate: 0.10 },
  { upTo: Infinity, rate: 0.12 },
];
/** First-time buyer relief: only available where price <= £500,000. */
const SDLT_FTB: Band[] = [
  { upTo: 300_000, rate: 0 },
  { upTo: 500_000, rate: 0.05 },
];
const SDLT_FTB_CAP = 500_000;
const SDLT_HIGHER_SURCHARGE = 0.05; // additional dwellings (from 31 Oct 2024)
const SDLT_NON_RESIDENT_SURCHARGE = 0.02;

const LTT_MAIN: Band[] = [
  { upTo: 225_000, rate: 0 },
  { upTo: 400_000, rate: 0.06 },
  { upTo: 750_000, rate: 0.075 },
  { upTo: 1_500_000, rate: 0.10 },
  { upTo: Infinity, rate: 0.12 },
];
const LTT_HIGHER: Band[] = [
  { upTo: 180_000, rate: 0.05 },
  { upTo: 250_000, rate: 0.085 },
  { upTo: 400_000, rate: 0.10 },
  { upTo: 750_000, rate: 0.125 },
  { upTo: 1_500_000, rate: 0.15 },
  { upTo: Infinity, rate: 0.17 },
];

const LBTT_MAIN: Band[] = [
  { upTo: 145_000, rate: 0 },
  { upTo: 250_000, rate: 0.02 },
  { upTo: 325_000, rate: 0.05 },
  { upTo: 750_000, rate: 0.10 },
  { upTo: Infinity, rate: 0.12 },
];
const LBTT_FTB: Band[] = [
  { upTo: 175_000, rate: 0 },
  { upTo: 250_000, rate: 0.02 },
  { upTo: 325_000, rate: 0.05 },
  { upTo: 750_000, rate: 0.10 },
  { upTo: Infinity, rate: 0.12 },
];
const LBTT_ADS = 0.08;

export interface TaxLine { from: number; to: number; rate: number; tax: number }
export interface TaxResult {
  tax: string;           // SDLT / LTT / LBTT
  total: number;
  effectiveRate: number;
  lines: TaxLine[];
  notes: string[];
}

function banded(price: number, bands: Band[], surcharge = 0): TaxLine[] {
  const lines: TaxLine[] = [];
  let lower = 0;
  for (const b of bands) {
    if (price <= lower) break;
    const top = Math.min(price, b.upTo);
    const slice = top - lower;
    const rate = b.rate + surcharge;
    lines.push({ from: lower, to: top, rate, tax: Math.floor(slice * rate) });
    lower = b.upTo;
  }
  return lines;
}

export function transactionTax(
  price: number,
  nation: Nation,
  buyer: BuyerType,
  opts: { nonResident?: boolean } = {},
): TaxResult {
  const notes: string[] = [];
  let lines: TaxLine[];
  let name: string;

  if (nation === 'england' || nation === 'northern-ireland') {
    name = 'SDLT';
    let surcharge = 0;
    if (buyer === 'additional') {
      surcharge += SDLT_HIGHER_SURCHARGE;
      notes.push('Higher rates for additional dwellings applied (+5%). May be reclaimable if replacing a main residence within 3 years.');
    }
    if (opts.nonResident) {
      surcharge += SDLT_NON_RESIDENT_SURCHARGE;
      notes.push('Non-resident surcharge applied (+2%).');
    }
    if (buyer === 'first-time' && price <= SDLT_FTB_CAP) {
      lines = banded(price, SDLT_FTB, surcharge);
      notes.push('First-time buyer relief applied (price ≤ £500,000).');
    } else {
      if (buyer === 'first-time') notes.push('First-time buyer relief unavailable: price exceeds £500,000.');
      lines = banded(price, SDLT_STANDARD, surcharge);
    }
    if (buyer === 'additional' && price < 40_000) {
      lines = [];
      notes.push('Purchases under £40,000 are not subject to the higher rates.');
    }
  } else if (nation === 'wales') {
    name = 'LTT';
    lines = banded(price, buyer === 'additional' ? LTT_HIGHER : LTT_MAIN);
    if (buyer === 'additional') notes.push('LTT higher residential rates applied.');
    if (buyer === 'first-time') notes.push('Wales has no first-time buyer relief; main rates apply.');
  } else {
    name = 'LBTT';
    lines = banded(price, buyer === 'first-time' ? LBTT_FTB : LBTT_MAIN);
    if (buyer === 'first-time') notes.push('LBTT first-time buyer relief applied (nil band to £175,000).');
    if (buyer === 'additional' && price >= 40_000) {
      const ads = Math.floor(price * LBTT_ADS);
      lines.push({ from: 0, to: price, rate: LBTT_ADS, tax: ads });
      notes.push('Additional Dwelling Supplement (8% of full price) applied.');
    }
  }

  const total = lines.reduce((s, l) => s + l.tax, 0);
  notes.push(`Rates table: ${RATES_EFFECTIVE}. Not tax advice — confirm with a conveyancer or HMRC/WRA/Revenue Scotland calculator.`);
  return { tax: name, total, effectiveRate: price ? total / price : 0, lines, notes };
}

/* ---------- Non-residential (commercial / mixed-use) ---------- */
const SDLT_NONRES: Band[] = [{ upTo: 150_000, rate: 0 }, { upTo: 250_000, rate: 0.02 }, { upTo: Infinity, rate: 0.05 }];
const LTT_NONRES: Band[] = [{ upTo: 225_000, rate: 0 }, { upTo: 250_000, rate: 0.01 }, { upTo: 1_000_000, rate: 0.05 }, { upTo: Infinity, rate: 0.06 }];
const LBTT_NONRES: Band[] = [{ upTo: 150_000, rate: 0 }, { upTo: 250_000, rate: 0.01 }, { upTo: Infinity, rate: 0.05 }];

export function nonResidentialTax(price: number, nation: Nation): TaxResult {
  const bands = nation === 'wales' ? LTT_NONRES : nation === 'scotland' ? LBTT_NONRES : SDLT_NONRES;
  const lines = banded(price, bands);
  const total = lines.reduce((s, l) => s + l.tax, 0);
  return { tax: nation === 'wales' ? 'LTT' : nation === 'scotland' ? 'LBTT' : 'SDLT', total, effectiveRate: price ? total / price : 0, lines, notes: ['Non-residential / mixed-use rates. VAT may also apply to commercial purchases (option to tax).', `Not tax advice — confirm with a conveyancer.`] };
}
