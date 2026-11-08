import { describe, expect, it } from 'vitest';
import { transactionTax } from './tax';
import { DEFAULT_INPUT, estimateRefurb, regionFromPostcode, scenarios, boqCsv, compareQuotes } from './refurb';
import { analyse, DEFAULT_INVESTMENT, sensitivity } from './investment';
import { parseQuery, runSearch } from './search';
import { dealScore } from './insights';
import { PROPERTIES } from '../data/properties';

describe('transaction tax', () => {
  it('SDLT standard residential £300k = £5,000', () => {
    expect(transactionTax(300_000, 'england', 'home-mover').total).toBe(5_000);
  });
  it('SDLT first-time buyer £450k = £7,500', () => {
    expect(transactionTax(450_000, 'england', 'first-time').total).toBe(7_500);
  });
  it('SDLT FTB relief lost above £500k', () => {
    expect(transactionTax(510_000, 'england', 'first-time').total).toBe(transactionTax(510_000, 'england', 'home-mover').total);
  });
  it('SDLT additional dwelling £300k = £20,000', () => {
    expect(transactionTax(300_000, 'england', 'additional').total).toBe(20_000);
  });
  it('LTT main £300k = £4,500', () => {
    expect(transactionTax(300_000, 'wales', 'home-mover').total).toBe(4_500);
  });
  it('LBTT £300k = £4,600, plus 8% ADS for additional', () => {
    expect(transactionTax(300_000, 'scotland', 'home-mover').total).toBe(4_600);
    expect(transactionTax(300_000, 'scotland', 'additional').total).toBe(4_600 + 24_000);
  });
});

describe('refurb engine', () => {
  it('maps postcodes to regions', () => {
    expect(regionFromPostcode('E17 4QH')).toBe('outer-london');
    expect(regionFromPostcode('M14 5RB')).toBe('north-west');
    expect(regionFromPostcode('CF24 3BW')).toBe('wales');
    expect(regionFromPostcode('G41 3SL')).toBe('scotland');
    expect(regionFromPostcode('SW1A 1AA')).toBe('central-london');
  });
  it('produces an ordered, internally consistent estimate', () => {
    const e = estimateRefurb(DEFAULT_INPUT);
    const sum = e.measuredWorks + e.preliminaries + e.overheadsProfit + e.contingency + e.professionalFees;
    expect(Math.abs(sum - e.subtotalExVat)).toBeLessThan(5);
    expect(e.low).toBeLessThan(e.total);
    expect(e.high).toBeGreaterThan(e.total);
    expect(e.total).toBeGreaterThan(60_000);
    expect(e.total).toBeLessThan(220_000);
  });
  it('budget < standard < premium', () => {
    const [b, s, p] = scenarios(DEFAULT_INPUT).map((x) => x.estimate.total);
    expect(b).toBeLessThan(s);
    expect(s).toBeLessThan(p);
  });
  it('London costs more than the North East for the same scope', () => {
    const ldn = estimateRefurb(DEFAULT_INPUT).total;
    const ne = estimateRefurb({ ...DEFAULT_INPUT, postcode: 'NE6 1AA' }).total;
    expect(ldn).toBeGreaterThan(ne * 1.2);
  });
  it('BoQ CSV & quote comparison', () => {
    const e = estimateRefurb(DEFAULT_INPUT);
    expect(boqCsv(e).split('\n').length).toBe(e.lines.length + 8);
    const [c] = compareQuotes(e, [{ contractor: 'X', programmeWeeks: 10, verified: true, lines: { Kitchen: 1 } }]);
    expect(c.missing.length).toBe(e.byTrade.length - 1);
  });
});

describe('investment', () => {
  it('BTL yields are sane', () => {
    const r = analyse({ ...DEFAULT_INVESTMENT, strategy: 'btl', refurbCost: 0 });
    expect(r.grossYield).toBeCloseTo((2450 * 12) / 435000, 4);
    expect(r.acquisition.tax).toBe(transactionTax(435_000, 'england', 'additional').total);
  });
  it('BRRR returns money left in less than cash before refinance', () => {
    const r = analyse(DEFAULT_INVESTMENT);
    expect(r.refinanceLoan).toBeCloseTo(575_000 * 0.75);
    expect(r.moneyLeftIn).toBeLessThan(r.acquisition.total - r.loan + DEFAULT_INVESTMENT.refurbCost + 20_000);
  });
  it('flip profit falls as refurb overruns', () => {
    const s = sensitivity({ ...DEFAULT_INVESTMENT, strategy: 'flip' });
    expect(s.rows[0].cells[2]).toBeGreaterThan(s.rows[5].cells[2]);
  });
});

describe('search', () => {
  it('parses the flagship query', () => {
    const q = parseQuery('Find me a three-bedroom house within 45 minutes of central London, under £500,000, with potential for a loft conversion and refurbishment profit of £60,000.');
    expect(q.minBeds).toBe(3);
    expect(q.maxPrice).toBe(500_000);
    expect(q.maxCommuteMins).toBe(45);
    expect(q.wantsLoft).toBe(true);
    expect(q.minRefurbProfit).toBe(60_000);
    const hits = runSearch(q);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].property.id).toBe('wal-001');
  });
  it('rent intent only returns lettings', () => {
    expect(runSearch(parseQuery('2 bed flat to rent in Nottingham')).every((h) => h.property.listing === 'rent')).toBe(true);
  });
  it('deal scores bounded', () => {
    for (const p of PROPERTIES) { const d = dealScore(p); expect(d.total).toBeGreaterThanOrEqual(0); expect(d.total).toBeLessThanOrEqual(100); }
  });
});
