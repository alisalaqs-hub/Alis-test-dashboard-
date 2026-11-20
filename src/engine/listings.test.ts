import { describe, expect, it } from 'vitest';
import { BIDDING, complianceChecks, extractListing, FIXED_TERM_MESSAGE, inEngland, isDiscriminatory, lettingWording, lettingWordingMessage, paymentRequests, RENT_ADVANCE_MESSAGE, scamPhrases, sexOrDisabilityWording, TENANT_FEES, type ListingInput } from './listings';

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

/* ───────── wording checks for lets ───────── */
const RENT = 1600; // £369.23 a week: the deposit cap is five weeks' rent, £1,846
const worded = (text: string, rent = RENT) => lettingWording(text, rent).map((w) => w.id);
const LET: ListingInput = {
  listing: 'rent', addressLine: '14 Elm Road', town: 'London', postcode: 'E17 4QH', type: 'flat', tenure: 'freehold', beds: 2, baths: 1, floorArea: 60, price: RENT,
  epc: 'C', councilTax: 'B', features: [], photos: ['a', 'b', 'c'], source: { kind: 'landlord', name: '', licence: '', verified: false },
};
const failing = (description: string, over: Partial<ListingInput> = {}) => complianceChecks({ ...LET, ...over, description }).filter((c) => !c.ok).map((c) => `${c.id}:${c.severity}`);

describe('letting wording: deposits', () => {
  it('warns on a deposit stated above the cap, in weeks, months or pounds', () => {
    expect(worded('A deposit of two months’ rent is required.')).toEqual(['deposit-text']);
    expect(worded('6 weeks deposit.')).toEqual(['deposit-text']);
    expect(worded('Six weeks’ rent as a deposit.')).toEqual(['deposit-text']);
    expect(worded('Deposit: £2,500')).toEqual(['deposit-text']);
    expect(worded('£3,200 security deposit payable on signing')).toEqual(['deposit-text']);
    expect(worded('Deposit is equal to 8 weeks rent')).toEqual(['deposit-text']);
    expect(lettingWording('A deposit of two months’ rent is required.', RENT)[0].text).toBe('deposit of two months');
  });

  it('leaves a deposit within the cap alone', () => {
    expect(worded('Deposit of five weeks’ rent.')).toEqual([]);
    expect(worded('5 weeks deposit (£1,846).')).toEqual([]);
    expect(worded('Deposit £1,846.')).toEqual([]);
    expect(worded('Deposit of one month’s rent.')).toEqual([]);
    expect(worded('A month’s rent as deposit.')).toEqual([]);
    expect(worded('No deposit needed. Deposit-free option available.')).toEqual([]);
    // six weeks is the cap when the yearly rent is £50,000 or more
    expect(worded('6 weeks deposit.', 5000)).toEqual([]);
    expect(worded('7 weeks deposit.', 5000)).toEqual(['deposit-text']);
    // ruled out, or nothing to compare with
    expect(worded('We never ask for a deposit of two months’ rent.')).toEqual([]);
    expect(worded('Deposit of two months’ rent.', 0)).toEqual([]);
  });

  it('warns on a holding deposit above one week’s rent', () => {
    expect(worded('Holding deposit of two weeks’ rent to secure the flat.')).toEqual(['holding-deposit']);
    expect(worded('£500 holding deposit.')).toEqual(['holding-deposit']);
    expect(worded('Holding deposit: £400')).toEqual(['holding-deposit']);
    expect(worded('Holding deposit of one week’s rent.')).toEqual([]);
    expect(worded('Holding deposit £369.')).toEqual([]);
    expect(worded('1 week holding deposit, then 5 weeks deposit.')).toEqual([]);
    // both kinds in one advert
    expect(worded('Holding deposit £500. Deposit £2,500.').sort()).toEqual(['deposit-text', 'holding-deposit']);
    expect(lettingWordingMessage('holding-deposit', RENT)).toBe('In England a holding deposit can’t be more than one week’s rent (£369 here). Check this wording.');
    expect(lettingWordingMessage('deposit-text', RENT)).toBe('In England the most a landlord can take as a deposit is five weeks’ rent (£1,846 here). Check this wording.');
  });
});

describe('letting wording: rent in advance and fixed terms', () => {
  it('warns on rent in advance of two months or more', () => {
    expect(worded('Six months’ rent in advance required.')).toEqual(['rent-advance']);
    expect(worded('6 months rent upfront for applicants without a UK guarantor')).toEqual(['rent-advance']);
    expect(worded('Two months in advance.')).toEqual(['rent-advance']);
    expect(worded('12 months’ rent payable in advance')).toEqual(['rent-advance']);
    expect(worded('A year’s rent up front.')).toEqual(['rent-advance']);
    expect(worded('Rent in advance: 3 months')).toEqual(['rent-advance']);
    expect(RENT_ADVANCE_MESSAGE).toBe('Since 1 May 2026 landlords in England can’t ask for more than one month’s rent in advance. Check this wording.');
  });

  it('leaves one month in advance, and wording that rules it out, alone', () => {
    expect(worded('One month’s rent in advance.')).toEqual([]);
    expect(worded('Rent is payable monthly in advance.')).toEqual([]);
    expect(worded('1 month rent in advance and 5 weeks deposit')).toEqual([]);
    expect(worded('We never ask for six months’ rent in advance.')).toEqual([]);
    expect(worded('No more than one month’s rent in advance.')).toEqual([]);
  });

  it('warns on a fixed or minimum term', () => {
    expect(worded('Minimum 12 month fixed term.')).toEqual(['fixed-term']);
    expect(worded('Minimum term 6 months')).toEqual(['fixed-term']);
    expect(worded('12 months minimum')).toEqual(['fixed-term']);
    expect(worded('Min. tenancy of one year')).toEqual(['fixed-term']);
    expect(worded('Offered on a fixed-term tenancy.')).toEqual(['fixed-term']);
    expect(worded('Initial term of 12 months.')).toEqual(['fixed-term']);
    expect(worded('Six month fixed contract')).toEqual(['fixed-term']);
    expect(FIXED_TERM_MESSAGE).toBe('Since 1 May 2026 new tenancies in England run month to month, so a minimum fixed term can’t be required. Check this wording.');
  });

  it('leaves month-to-month wording alone', () => {
    expect(worded('No minimum term: the tenancy runs month to month.')).toEqual([]);
    expect(worded('There isn’t a fixed term.')).toEqual([]);
    expect(worded('The rent is fixed at £1,600 per calendar month.')).toEqual([]);
    expect(worded('5 mins walk to the station. Fixed wardrobes in both bedrooms.')).toEqual([]);
    expect(worded('Available long term.')).toEqual([]);
  });

  it('shows them as warnings on a let in England, never as blocks, and not on a sale', () => {
    expect(failing('Six months’ rent in advance required. Minimum 12 month fixed term. Deposit of two months’ rent. Holding deposit £500.'))
      .toEqual(['deposit-text:warn', 'holding-deposit:warn', 'rent-advance:warn', 'fixed-term:warn']);
    expect(failing('A bright flat. One month’s rent in advance, five weeks’ deposit.')).toEqual([]);
    expect(failing('Minimum 12 month fixed term.', { listing: 'sale', price: 400000 })).toEqual([]);
    // the rules are England's
    expect(inEngland('E17 4QH')).toBe(true);
    expect(inEngland('')).toBe(true);
    expect(inEngland('EH1 1YZ')).toBe(false);
    expect(inEngland('CF10 1EP')).toBe(false);
    expect(inEngland('BT1 1AA')).toBe(false);
    expect(failing('Six months’ rent in advance required. Minimum 12 month fixed term.', { postcode: 'EH1 1YZ' })).toEqual([]);
  });
});

describe('discriminatory wording', () => {
  it('refuses nationality requirements, like "No DSS"', () => {
    for (const t of ['British passport holders only', 'UK citizens only', 'British only', 'UK passport required', 'Must hold a British passport', 'EU nationals preferred', 'British citizens only', 'No DSS', 'Professionals only', 'no children'])
      expect(isDiscriminatory(t), t).toBe(true);
    expect(failing('A bright flat. British passport holders only.')).toEqual(['discrim:block']);
    expect(failing('UK citizens only.', { listing: 'sale', price: 400000 })).toEqual(['discrim:block']);
    // right-to-rent checks and plain mentions are fine
    for (const t of ['Right to rent checks apply to every adult.', 'Close to the British Museum.', 'A passport or other ID is needed for referencing.'])
      expect(isDiscriminatory(t), t).toBe(false);
  });

  it('no longer refuses "no students": students are not a protected group', () => {
    for (const t of ['No students.', 'Sorry, no students', 'Students not accepted', 'Not suitable for students', 'Non-students only']) expect(isDiscriminatory(t), t).toBe(false);
    expect(failing('A quiet flat. No students.')).toEqual([]);
    // still refused when a protected group is excluded in the same breath
    expect(isDiscriminatory('No DSS or students.')).toBe(true);
  });

  it('warns, without blocking, on sex-specific and disability wording', () => {
    for (const t of ['Would suit single female', 'Suit single female', 'Female only', 'Male only', 'Females only house share', 'All-female household', 'Female tenant preferred', 'Ladies only', 'Not suitable for wheelchair users', 'Unsuitable for disabled people', 'Not suitable for anyone with mobility issues', 'No males']) {
      expect(sexOrDisabilityWording(t), t).not.toBeNull();
      expect(isDiscriminatory(t), t).toBe(false);
    }
    expect(failing('Room in a shared house. Female only.')).toEqual(['sex-disability:warn']);
    expect(failing('Top-floor flat, not suitable for wheelchair users.')).toEqual(['sex-disability:warn']);
    // Turning disabled people away outright is refused, like "No DSS": it is not a matter of wording to check.
    for (const t of ['No disabled people']) expect(isDiscriminatory(t), t).toBe(true);
    // plain facts about the building are not flagged
    for (const t of ['No lift: the flat is on the third floor.', 'No wheelchair access to the upper floor.', 'No disabled parking bay.', 'Step-free access throughout.', 'The garage is ideal for a man cave.', 'Male and female toilets on each floor.'])
      expect(sexOrDisabilityWording(t), t).toBeNull();
  });
});
