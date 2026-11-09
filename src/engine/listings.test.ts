import { describe, expect, it } from 'vitest';
import { BIDDING, complianceChecks, extractListing, paymentRequests, scamPhrases, TENANT_FEES } from './listings';

describe('listing rules without lookbehind', () => {
  it('never uses lookbehind (Safari before 16.4 cannot parse it and the site would not start)', () => {
    const sources = import.meta.glob<string>('./listings.ts', { query: '?raw', import: 'default', eager: true });
    expect(Object.keys(sources)).toHaveLength(1);
    for (const [f, src] of Object.entries(sources)) {
      expect(src, f).toMatch(/export const BIDDING/); // really the module's source
      expect(src, f).not.toMatch(/\(\?<[=!]/);
    }
  });

  it('ignores bidding and tenant-fee wording that says it is not done', () => {
    expect(BIDDING.test('No bidding: the rent is fixed.')).toBe(false);
    expect(BIDDING.test('Offers over £1,500 pcm considered.')).toBe(true);
    // A ruled-out mention doesn't hide a later one.
    expect(BIDDING.exec('No bidding wars. Best offers by Friday.')?.[0]).toBe('Best offers');
    expect(TENANT_FEES.test('We don’t charge admin fees, and there are no referencing fees.')).toBe(false);
    expect(TENANT_FEES.test('Admin fee of £200 on signing.')).toBe(true);
  });

  it('keeps the rule when the server copies the patterns (matchAll, replace, split)', () => {
    const Copy = BIDDING.constructor as RegExpConstructor;
    const all = new Copy(BIDDING, 'gi');
    expect([...'No bids. Best offers. Bids welcome.'.matchAll(all)].map((m) => [m[0], m.index])).toEqual([['Best offers', 9], ['Bids', 22]]);
    expect('No bids. Best offers.'.replace(all, '[$&]')).toBe('No bids. [Best offers].');
    expect('No bids. Best offers.'.split(BIDDING)).toEqual(['No bids. ', '.']);
  });

  it('does not warn about honest anti-scam payment wording', () => {
    expect(paymentRequests('We never take payment via Revolut.')).toEqual([]);
    expect(paymentRequests('We will never ask for a deposit by bank transfer.')).toEqual([]);
    expect(paymentRequests('We will never ask you for any payment before a viewing.')).toEqual([]);
    expect(paymentRequests('Never pay rent by bank transfer: pay through Streetkey.')).toEqual([]);
    // Still caught when it isn't ruled out.
    expect(paymentRequests('Pay the holding deposit via Revolut to secure it.').map((p) => p.label)).toEqual(['payment app']);
    expect(paymentRequests('No pets. Pay the deposit by bank transfer before viewing.').map((p) => p.label)).toEqual(['bank transfer', 'payment before viewing']);
    const base = { listing: 'rent' as const, addressLine: '14 Elm Road', town: 'London', postcode: 'E17 4QH', type: 'flat' as const, tenure: 'leasehold' as const, leaseYears: 100, beds: 1, baths: 1, floorArea: 40, price: 1200, epc: 'C', councilTax: 'B', serviceChargeAnnual: 0, features: [], photos: ['a', 'b', 'c'], source: { kind: 'landlord' as const, name: 'L', licence: '', verified: false } };
    expect(complianceChecks({ ...base, description: 'Viewings in person. We never take payment via Revolut, and we never ask for payment before a viewing.' }).filter((c) => !c.ok)).toEqual([]);
  });

  it('reads "keys posted" only when the sending is not ruled out', () => {
    expect(scamPhrases('The keys will never be posted: viewings are in person.')).toEqual([]);
    expect(scamPhrases('Keys are not posted or couriered.')).toEqual([]);
    expect(scamPhrases('The keys won’t be posted; they’ll be couriered to you.')).toEqual([{ label: 'keys sent by post', text: 'keys won’t be posted; they’ll be couriered' }]);
    expect(scamPhrases('I am abroad so the keys will be posted to you.').map((p) => p.label)).toEqual(['lister says they are abroad', 'keys sent by post']);
  });

  it('reads room counts and tenure the same way', () => {
    expect(extractListing('3bed 2bath flat').fields).toMatchObject({ beds: 3, baths: 2 });
    expect(extractListing('BEDROOMS x2 BATHROOMS x1').fields).toMatchObject({ beds: 2, baths: 1 });
    expect(extractListing('Sunbed and birdbath in the garden. 2x3 metre shed.').fields.beds).toBeUndefined();
    expect(extractListing('No share of freehold. Leasehold, 120 years remaining').fields.tenure).toBe('leasehold');
    expect(extractListing('Share of the freehold').fields.tenure).toBe('share-of-freehold');
    expect(extractListing('Not a leasehold: freehold').fields.tenure).toBe('freehold');
  });
});

describe('rental bidding wording', () => {
  it('treats "best and final offers" as inviting bids', () => {
    expect(BIDDING.test('Best and final offers by Friday')).toBe(true);
    expect(BIDDING.test('Please send your best and final offer.')).toBe(true);
    expect(BIDDING.test('No bidding wars here, fixed rent of £1,200 pcm')).toBe(false);
    expect(BIDDING.test('The best and finest finishes throughout')).toBe(false);
  });
});
