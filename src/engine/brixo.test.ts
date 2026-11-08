import { describe, expect, it } from 'vitest';
import { PROPERTIES, getProperty } from '../data/properties';
import { engagementFor, insightsFor, totals, wilson, benchmark, PERIOD_DAYS } from './engagement';
import { valuationScenario, rentalScenario } from './valuation';
import { developmentOptions, residualAppraisal, suggestMix } from './development';
import { route } from '../ai/assistant';
import { propertySkills, ownerSkills, agentSkills } from '../ai/skills';
import { AGENTS } from '../ai/agents';
import { weeklyOwnerReport } from './reports';

const wal = getProperty('wal-001')!;

describe('engagement engine', () => {
  it('is deterministic and complete', () => {
    const a = engagementFor(wal); const b = engagementFor(wal);
    expect(a).toEqual(b);
    expect(a.days).toHaveLength(PERIOD_DAYS);
    const t = totals(a);
    expect(t.unique).toBeLessThanOrEqual(t.views);
  });
  it('wilson interval brackets the rate', () => {
    const w = wilson(10, 1000);
    expect(w.low).toBeLessThan(0.01); expect(w.high).toBeGreaterThan(0.01);
    expect(wilson(0, 0).p).toBe(0);
  });
  it('flags the Walthamstow story: high views, low conversion, lead-photo test', () => {
    const ids = insightsFor(wal).map((i) => i.id);
    expect(ids).toContain('conv-low');
    expect(ids).toContain('photo-test');
    expect(totals(engagementFor(wal)).views).toBeGreaterThan(benchmark(wal).avgViews);
  });
  it('every insight has evidence', () => {
    for (const p of PROPERTIES.filter((x) => x.listing !== 'rent')) for (const i of insightsFor(p)) expect(i.evidence.length).toBeGreaterThan(0);
  });
});

describe('valuation & development', () => {
  it('as-is below post-works and ordered ranges', () => {
    for (const p of PROPERTIES.filter((x) => x.listing === 'sale' && x.type !== 'commercial')) {
      const v = valuationScenario(p);
      expect(v.asIs.low).toBeLessThanOrEqual(v.asIs.mid); expect(v.asIs.mid).toBeLessThanOrEqual(v.asIs.high);
      expect(v.asIs.mid).toBeLessThan(v.postWorks.mid);
      expect(v.confidence).not.toBe('high');
    }
    expect(rentalScenario(getProperty('ley-014')!).evidence).toBe(1);
  });
  it('dev options respect constraints', () => {
    const flat = developmentOptions(getProperty('bri-005')!);
    expect(flat.find((o) => o.id === 'loft')!.status).toBe('not applicable');
    const croydon = developmentOptions(getProperty('cro-013')!).find((o) => o.id === 'subdivide')!;
    expect(croydon.units).toBeGreaterThanOrEqual(3);
    expect(croydon.status).toBe('needs planning permission');
    const office = developmentOptions(getProperty('wat-015')!).find((o) => o.id === 'classma')!;
    expect(office.status).toBe('constrained'); // Article 4
  });
  it('residual appraisal identity holds', () => {
    const r = residualAppraisal({ units: [{ key: '1b', count: 10, size: 50, price: 300_000 }], buildCostPerM2: 2500, netToGross: 0.8, feesPct: 0.1, contingencyPct: 0.05, financeRate: 0.08, months: 18, profitOnGdv: 0.2, salesPct: 0.02, cil: 50_000 });
    expect(r.gdv).toBe(3_000_000);
    expect(Math.round(r.gdv - r.build - r.fees - r.contingency - r.finance - r.sales - r.profit - r.cil)).toBe(Math.round(r.residual));
  });
  it('unit mix allocates exactly N units', () => {
    const mix = suggestMix(25, [{ key: 'studio', label: '', size: 37, price: 230e3, rent: 1300 }, { key: '1b', label: '', size: 50, price: 290e3, rent: 1550 }, { key: '2b', label: '', size: 70, price: 375e3, rent: 1900 }, { key: '3b', label: '', size: 86, price: 450e3, rent: 2300 }],
      [{ key: 'studio', demandIndex: 55, monthlyAbsorption: [0.5, 1] }, { key: '1b', demandIndex: 85, monthlyAbsorption: [1, 2] }, { key: '2b', demandIndex: 90, monthlyAbsorption: [1, 2.2] }, { key: '3b', demandIndex: 60, monthlyAbsorption: [0.3, 0.6] }]);
    expect(Object.values(mix).reduce((a, b) => a + b, 0)).toBe(25);
  });
});

describe('assistants & agents', () => {
  const cases: [string, string][] = [
    ['Is this property overpriced?', 'overpriced'], ['How much could I rent this property for?', 'rent'], ['What are the likely refurbishment costs?', 'refurb'],
    ['What would this house look like with a modern kitchen?', 'kitchen'], ['Could I extend this property?', 'extend'], ['What are the financial risks?', 'risk'],
    ['How does this compare to similar properties?', 'compare'], ['Would this be a good investment?', 'invest'],
  ];
  it.each(cases)('property: %s', (q, id) => expect(route(propertySkills, wal, q).skill).toBe(id));
  it('owner and agent routing', () => {
    expect(route(ownerSkills, wal, 'Why is my house not selling?').skill).toBe('not-selling');
    expect(route(ownerSkills, wal, 'Should I consider reducing the asking price?').skill).toBe('reduce');
    expect(route(ownerSkills, wal, 'Would refurbishing the kitchen improve marketability?').skill).toBe('kitchen-roi');
    const ctx = { listings: PROPERTIES.filter((p) => p.listing !== 'rent' && p.type !== 'commercial') };
    expect(route(agentSkills, ctx, 'Which properties are underperforming this week?').skill).toBe('underperf');
    expect(route(agentSkills, ctx, 'Which listings have high engagement but low conversion?').skill).toBe('high-low');
    expect(route(agentSkills, ctx, 'Prepare a report for the owner of 15 High Street.').skill).toBe('owner-report');
    expect(route(agentSkills, ctx, 'Suggest improvements to my five weakest listings').skill).toBe('improve');
    expect(route(agentSkills, ctx, 'What are buyers most interested in across my portfolio?').skill).toBe('interests');
  });
  it('agents run, and consequential actions are flagged', () => {
    for (const a of AGENTS) { const r = a.run(); expect(r.findings.length).toBeGreaterThan(0); expect(r.toolsCalled.length).toBeGreaterThan(0); }
    expect(AGENTS.find((a) => a.id === 'buyer')!.run().proposals.every((p) => p.consequential)).toBe(true);
  });
  it('report contains privacy note and draft label', () => {
    const r = weeklyOwnerReport(wal, 'agent-draft');
    expect(r).toContain('DRAFT'); expect(r).toContain('suppressed');
  });
});

import { parseQuery, runSearch } from './search';
describe('search — BRIXO examples', () => {
  it('Croydon conversion', () => {
    const h = runSearch(parseQuery('Find me properties in Croydon that could potentially be converted into multiple flats.'));
    expect(h.map((x) => x.property.id)).toContain('cro-013');
    expect(h.every((x) => x.property.town.includes('Croydon'))).toBe(true);
  });
  it('2-bed flat, low service charge', () => {
    const h = runSearch(parseQuery('Find me a two-bedroom flat with good rental demand, low service charges and potential for refurbishment.'));
    expect(h[0].property.id).toBe('ley-014');
  });
  it('office conversion only returns commercial', () => {
    const h = runSearch(parseQuery('Office building near London suitable for office-to-residential conversion'));
    expect(h.length).toBeGreaterThan(0);
    expect(h.every((x) => x.property.type === 'commercial')).toBe(true);
  });
});

import { analyse, breakEven, DEFAULT_INVESTMENT } from './investment';
import { nonResidentialTax } from './tax';
describe('investment additions', () => {
  it('non-residential SDLT £1.45m = £62,000', () => { expect(nonResidentialTax(1_450_000, 'england').total).toBe(62_000); });
  it('break-even rent gives ~zero cash flow', () => {
    const i = { ...DEFAULT_INVESTMENT, strategy: 'btl' as const };
    const be = breakEven(i);
    expect(Math.abs(analyse({ ...i, monthlyRent: be.rent }).monthlyCashflow)).toBeLessThan(1);
    const f = { ...DEFAULT_INVESTMENT, strategy: 'flip' as const };
    expect(Math.abs(analyse({ ...f, gdv: breakEven(f).salePrice }).flipProfit)).toBeLessThan(5);
  });
});

import { suggest } from './suggest';
describe('smart search box', () => {
  it('place-only queries work (town and postcode district)', () => {
    expect(runSearch(parseQuery('Croydon')).every((h) => h.property.town.includes('Croydon'))).toBe(true);
    expect(runSearch(parseQuery('Croydon')).length).toBeGreaterThan(0);
    const e17 = runSearch(parseQuery('E17'));
    expect(e17.length).toBe(1); expect(e17[0].property.id).toBe('wal-001');
    expect(runSearch(parseQuery('3 bed in M14')).every((h) => h.property.district === 'M14')).toBe(true);
  });
  it('£ amounts are not mistaken for postcodes', () => {
    expect(parseQuery('under £500k').districts).toEqual([]);
  });
  it('suggests places, listings and AI', () => {
    expect(suggest('Croy')[0]).toMatchObject({ kind: 'place', label: 'Croydon' });
    expect(suggest('3 bed house with a garden under £450k')[0].kind).toBe('ai');
    expect(suggest('cr0').some((s) => s.kind === 'place' && s.label === 'CR0')).toBe(true);
  });
});

import { parseBLM, extractListing, complianceChecks, dedupe, buildListing, externalSearchLinks } from './listings';
import { SAMPLE_BLM, SAMPLE_AGENT, SAMPLE_PASTE } from '../data/sampleFeed';
import { baseListings } from '../data/properties';
describe('listing supply', () => {
  it('parses the BLM feed, rejecting bad rows', () => {
    const r = parseBLM(SAMPLE_BLM, SAMPLE_AGENT);
    expect(r.version).toBe('3');
    expect(r.accepted).toHaveLength(4);
    expect(r.rejected.map((x) => x.ref).sort()).toEqual(['LVH005', 'LVH006']);
    const flat = r.accepted.find((p) => p.id.endsWith('lvh002'))!;
    expect(flat.tenure).toBe('leasehold'); expect(flat.leaseYears).toBe(125); expect(flat.serviceChargeAnnual).toBe(1400); expect(flat.epc.current).toBe('C');
    expect(r.accepted.find((p) => p.id.endsWith('lvh004'))!.listing).toBe('rent');
  });
  it('merges the feed duplicate into the existing listing', () => {
    const { accepted } = parseBLM(SAMPLE_BLM, SAMPLE_AGENT);
    const base = baseListings().map((b) => ({ ...b }));
    const { merged, duplicates } = dedupe([...base, ...accepted]);
    expect(duplicates).toHaveLength(1);
    expect(merged.find((p) => p.id === 'wal-001')!.alsoListedBy).toContain(`${SAMPLE_AGENT} (agent feed)`);
  });
  it('extracts a pasted listing', () => {
    const e = extractListing(SAMPLE_PASTE, 'https://www.example-portal.co.uk/listing/123');
    expect(e.fields).toMatchObject({ price: 375000, beds: 2, baths: 1, postcode: 'SE22 8JL', tenure: 'leasehold', leaseYears: 89, epc: 'D', councilTax: 'C', serviceChargeAnnual: 950, listing: 'sale', type: 'flat' });
    expect(e.fields.floorArea).toBe(67);
    expect(e.missing).toEqual([]);
    expect(extractListing('£1,250 pcm one bed flat').fields).toMatchObject({ listing: 'rent', price: 1250, beds: 1 });
  });
  it('blocks discriminatory and bidding rental ads', () => {
    const base = { listing: 'rent' as const, addressLine: 'x', town: 'London', postcode: 'E17 4QH', type: 'flat' as const, tenure: 'leasehold' as const, leaseYears: 100, beds: 1, baths: 1, floorArea: 40, price: 1200, epc: 'C', councilTax: 'B', serviceChargeAnnual: 0, features: [], source: { kind: 'landlord' as const, name: 'L', licence: '', verified: false } };
    expect(complianceChecks({ ...base, description: 'No DSS, professionals only' }).find((c) => c.id === 'discrim')!.ok).toBe(false);
    expect(complianceChecks({ ...base, description: 'Offers over asking considered' }).find((c) => c.id === 'bidding')!.ok).toBe(false);
    expect(complianceChecks({ ...base, epc: 'F' }).find((c) => c.id === 'epc-let')!.ok).toBe(false);
    expect(complianceChecks({ ...base, photos: ['a', 'b', 'c'] }).filter((c) => !c.ok)).toHaveLength(0);
    expect(buildListing(base).nation).toBe('england');
  });
  it('deep links', () => {
    expect(externalSearchLinks('Croydon', 'sale').map((l) => l.site)).toEqual(['Rightmove', 'Zoopla', 'OnTheMarket']);
    expect(externalSearchLinks('', 'sale')).toEqual([]);
  });
});
