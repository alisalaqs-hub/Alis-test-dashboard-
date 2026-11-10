import { describe, expect, it } from 'vitest';
import { epcExpired, evidenceRange, isEpcBand, parseBand, quantile, soldStats, soldTypeFor, worstBand, type SoldSale, type SoldType } from './evidence';

const NOW = new Date('2026-11-10T12:00:00Z');
const sale = (price: number, date: string, type: SoldType = 'terraced', id = `${price}-${date}-${type}`): SoldSale =>
  ({ id, address: '1 Test Road', street: 'Test Road', town: 'London', postcode: 'E17 4PP', price, date, type, newBuild: false, tenure: 'freehold', distanceM: 100 });

describe('sold price summaries', () => {
  it('finds quartiles by interpolation', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([100], 0.25)).toBe(100);
    expect(quantile([100, 200, 300, 400], 0.5)).toBe(250);
    expect(quantile([100, 200, 300, 400], 0.25)).toBe(175);
    expect(quantile([100, 200, 300, 400, 500], 0.75)).toBe(400);
  });

  it('summarises the last 12 months and gives a year-by-year median', () => {
    const sales = [sale(500_000, '2026-10-01'), sale(600_000, '2026-03-01'), sale(300_000, '2026-01-15', 'flat'), sale(400_000, '2025-11-01'), sale(450_000, '2024-06-01'), sale(350_000, '2024-02-01')];
    const s = soldStats(sales, { now: NOW });
    expect(s.count).toBe(3); // 2025-11-01 is just outside the 12 months to 10 Nov 2026
    expect(s.median).toBe(500_000);
    expect([s.low, s.high]).toEqual([400_000, 550_000]);
    expect(s.byType).toEqual([{ type: 'terraced', count: 2, median: 550_000 }, { type: 'flat', count: 1, median: 300_000 }]);
    expect(s.byYear).toEqual([{ year: 2024, count: 2, median: 400_000 }, { year: 2025, count: 1, median: 400_000 }, { year: 2026, count: 3, median: 500_000 }]);
    expect(soldStats([], { now: NOW })).toMatchObject({ count: 0, median: null, low: null, high: null, byType: [], byYear: [] });
  });

  it('maps Streetkey property types to Land Registry ones', () => {
    expect(['terraced', 'semi-detached', 'detached', 'bungalow', 'flat', 'commercial', undefined].map((t) => soldTypeFor(t))).toEqual(['terraced', 'semi-detached', 'detached', 'detached', 'flat', null, null]);
  });
});

describe('where an asking price sits against sold prices', () => {
  const terraces = [500, 520, 540, 560, 580, 600, 620, 640, 660, 680].map((k, i) => sale(k * 1000, `2026-0${(i % 9) + 1}-10`));
  const flats = [300, 310, 320].map((k) => sale(k * 1000, '2026-05-01', 'flat'));

  it('uses like-for-like sales when there are enough', () => {
    const r = evidenceRange([...terraces, ...flats], { type: 'terraced', price: 700_000 }, { now: NOW });
    expect(r).toMatchObject({ basis: 'same-type', count: 10, months: 24, low: 545_000, mid: 590_000, high: 635_000, position: 'above', confidence: 'medium' });
    expect(r.askingVsMid).toBeCloseTo(0.186, 2);
    expect(r.method[0]).toBe('10 terraced homes sold nearby in the last 24 months (HM Land Registry).');
    expect(r.method.join(' ')).toMatch(/Not a valuation/);
    expect(evidenceRange(terraces, { type: 'terraced', price: 600_000 }, { now: NOW }).position).toBe('within');
    expect(evidenceRange(terraces, { type: 'terraced', price: 500_000 }, { now: NOW }).position).toBe('below');
    expect(evidenceRange(terraces, { type: 'terraced' }, { now: NOW })).toMatchObject({ position: 'unknown', askingVsMid: null });
  });

  it('falls back to all nearby homes, flagged as weaker, when the same type is rare', () => {
    const r = evidenceRange([...terraces, ...flats], { type: 'flat', price: 320_000 }, { now: NOW });
    expect(r).toMatchObject({ basis: 'all-types', count: 13, confidence: 'low', position: 'below' });
    expect(r.method.join(' ')).toMatch(/too few sales of the same property type/);
  });

  it('never calls itself confident on thin evidence, widens to 36 months, and says when there is nothing', () => {
    expect(evidenceRange(terraces.slice(0, 6), { type: 'terraced', price: 550_000 }, { now: NOW }).confidence).toBe('low');
    const old = [1, 2, 3, 4, 5].map((n) => sale(400_000 + n * 10_000, `2024-0${n}-01`));
    expect(evidenceRange(old, { type: 'terraced', price: 430_000 }, { now: NOW })).toMatchObject({ months: 36, count: 5, basis: 'same-type' });
    expect(evidenceRange(old.slice(0, 3), { type: 'terraced', price: 430_000 }, { now: NOW })).toMatchObject({ basis: 'none', low: null, mid: null, high: null, position: 'unknown' });
    // commercial and unusual sales never count
    expect(evidenceRange(terraces.map((s) => ({ ...s, type: 'other' as const })), { type: 'terraced', price: 1 }, { now: NOW }).basis).toBe('none');
  });
});

describe('flood bands and energy certificates', () => {
  it('reads Environment Agency bands and picks the most serious', () => {
    expect(['High', 'Medium', 'Low', 'Very low', 'VERY LOW ', 'none', '', null].map(parseBand)).toEqual(['high', 'medium', 'low', 'very low', 'very low', null, null, null]);
    expect(worstBand(['low', 'very low', null, 'medium'])).toBe('medium');
    expect(worstBand(['very low', 'high', 'low'])).toBe('high');
    expect(worstBand([null, undefined])).toBeNull();
    expect(worstBand([])).toBeNull();
  });

  it('knows a certificate lasts ten years', () => {
    expect(epcExpired('2016-11-09', NOW)).toBe(true);
    expect(epcExpired('2016-11-11', NOW)).toBe(false);
    expect(epcExpired(null, NOW)).toBe(false);
    expect(['A', 'G', 'H', 'a', '', null].map(isEpcBand)).toEqual([true, true, false, false, false, false]);
  });
});
