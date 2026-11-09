import { describe, expect, it } from 'vitest';
import { bedroomRange, parseQuery, runSearch } from './search';
import { suggest } from './suggest';
import { PROPERTIES } from '../data/properties';
import { applyExtras, fromRules, modeOfQuery, savedFilters } from '../lib/ai/search';

describe('parseQuery price reading', () => {
  it('does not read bedroom counts or distances as prices', () => {
    expect(parseQuery('up to 4 beds in Leeds').maxPrice).toBeUndefined();
    expect(parseQuery('max 3 bedrooms').maxPrice).toBeUndefined();
    expect(parseQuery('under 2 miles from the station').maxPrice).toBeUndefined();
  });
  it('still reads real budgets', () => {
    expect(parseQuery('3 bed house under 450k').maxPrice).toBe(450_000);
    expect(parseQuery('max 3 bedrooms under £300,000').maxPrice).toBe(300_000);
    expect(parseQuery('budget of £250k').maxPrice).toBe(250_000);
    expect(parseQuery('flat to rent up to 1500 pcm').maxPrice).toBe(1500);
  });
});

describe('commute limits', () => {
  it('never counts an uncalculated journey time as meeting a limit', () => {
    const p = { ...PROPERTIES[0], id: 'tmp-live', commute: { to: 'Nearest centre', minutes: 0, mode: 'Not yet calculated' }, station: { name: 'Not yet calculated', walkMins: 0 } };
    const hits = runSearch(parseQuery('within 30 minutes of london'), [p]);
    expect(hits).toHaveLength(0);
  });
});

describe('bedroom ranges', () => {
  it('reads ceilings as ceilings, not as minimums', () => {
    expect(bedroomRange('up to 4 beds in Leeds')).toEqual({ max: 4 });
    expect(bedroomRange('max 3 bedrooms in Manchester')).toEqual({ max: 3 });
    expect(bedroomRange('no more than 3 bed')).toEqual({ max: 3 });
    expect(bedroomRange('at most 2 beds')).toEqual({ max: 2 });
    expect(bedroomRange('fewer than 4 bedrooms')).toEqual({ max: 3 });
    expect(parseQuery('up to 4 beds in Leeds').minBeds).toBeUndefined();
    expect(parseQuery('max 3 bedrooms in Manchester').minBeds).toBeUndefined();
  });
  it('still reads minimums and ranges', () => {
    expect(bedroomRange('3 bed house')).toEqual({ min: 3 });
    expect(bedroomRange('three-bedroom house')).toEqual({ min: 3 });
    expect(bedroomRange('2 to 3 beds')).toEqual({ min: 2, max: 3 });
    expect(bedroomRange('2-3 bed flat')).toEqual({ min: 2, max: 3 });
    expect(bedroomRange('3 bed, up to 4 beds')).toEqual({ min: 3, max: 4 });
    expect(parseQuery('3 bed house').minBeds).toBe(3);
  });
  it('shows "up to 4 beds" as one chip and finds homes with fewer bedrooms', () => {
    const r = fromRules('up to 4 beds in Leeds');
    expect(r.understood.map((c) => c.label)).toEqual(['To buy', 'Leeds', 'Up to 4 beds']);
    const hits = applyExtras(runSearch(r.query), r.extras);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.property.beds).toBeLessThanOrEqual(4);
  });
});

describe('rent and investment words', () => {
  it('recognises renting however it is phrased', () => {
    for (const t of ['flat to rent in Leeds', 'flat for rent in Leeds', '2 bed flat rental in Manchester', 'rentals in Bristol', 'flat to let', 'flat under 1200 pcm', '£900 per month']) expect(parseQuery(t).intent, t).toBe('rent');
  });
  it('does not mistake investing for renting', () => {
    for (const t of ['buy to let flat', 'buy-to-let in Leeds', 'flat to rent out in Leeds', 'HMO with tenants in place', 'good rental yield']) expect(parseQuery(t).intent, t).toBe('invest');
    expect(parseQuery('flat with strong rental demand').intent).not.toBe('rent');
    expect(parseQuery('house with a sitting tenant').intent).toBe('buy');
    expect(parseQuery('buy to let flat, tenants pay £1,100 pcm').intent).toBe('invest');
  });
  it('does not mistake buying a rental (or a home with tenants) for renting', () => {
    for (const t of ['rental property to buy in Leeds under £200k', 'buy a rental flat in Manchester', 'rental investment in Liverpool', 'buy a flat with tenants', 'flat for sale in Leeds, rental income £900 pcm']) {
      expect(parseQuery(t).intent, t).not.toBe('rent');
    }
    // A purchase budget is never shown as a monthly rent.
    const r = fromRules('rental property to buy in Leeds under £200k');
    expect(r.understood.map((c) => c.label)).toEqual(['Investment', 'Leeds', 'Under £200k']);
    expect(modeOfQuery(r.query)).toBe('invest');
    expect(fromRules('flat to rent, budget £200k').query.maxPrice).toBeUndefined();
    // Sharing with other tenants is still renting.
    expect(parseQuery('room in a house share with 3 other tenants').intent).toBe('rent');
  });
  it('reads weekly rents as renting, compared per calendar month', () => {
    expect(parseQuery('room near uni, £300 a week').intent).toBe('rent');
    expect(parseQuery('studio under 250pw')).toMatchObject({ intent: 'rent', maxPrice: 1083 });
    expect(fromRules('room near uni under £300 a week').understood.find((c) => c.key === 'maxPrice')?.label).toBe('Under £1,300 pcm');
  });
  it('never uses lookbehind (Safari before 16.4 cannot parse it and the site would not start)', () => {
    const sources = import.meta.glob<string>(['./search.ts', './suggest.ts', '../lib/ai/search.ts'], { query: '?raw', import: 'default', eager: true });
    expect(Object.keys(sources)).toHaveLength(3);
    for (const [f, src] of Object.entries(sources)) expect(src, f).not.toMatch(/\(\?<[=!]/);
  });
});

describe('search suggestions', () => {
  it('only mentions Streetkey AI when AI is available', () => {
    const off = suggest('3 bed house with a garden')[0];
    expect(off.kind).toBe('ai');
    expect(`${off.label} ${off.sub}`).not.toMatch(/AI/);
    expect(off.sub).toBe('Search for homes matching this');
    expect(suggest('3 bed house with a garden', 7, { ai: true })[0].sub).toMatch(/Streetkey AI/);
    const place = suggest('Croy').find((s) => s.kind === 'ai')!;
    expect(place.label).toBe('Search for “Croy”');
    expect(suggest('Croy', 7, { ai: true }).find((s) => s.kind === 'ai')!.label).toMatch(/ask Streetkey AI/);
  });
});

describe('saved search filters', () => {
  it('keeps what the person saw, within the ranges the server accepts', () => {
    const r = fromRules('2 bed flat to rent in Leeds under 1200 pcm with a 95% yield');
    const f = savedFilters({ ...r.query, unsupported: ['x'] }, { ...r.extras, mustHaves: ['balcony'] });
    expect(f.query).toMatchObject({ intent: 'rent', locations: ['Leeds'], types: ['flat'], minBeds: 2, maxPrice: 1200, unsupported: [] });
    expect(f.query.minYield).toBeUndefined(); // 95% is out of range
    expect(f.extras.mustHaves).toEqual(['balcony']);
    expect(modeOfQuery(f.query)).toBe('rent');
  });
});
