import { describe, expect, it } from 'vitest';
import { parseQuery, runSearch } from './search';
import { PROPERTIES } from '../data/properties';

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
