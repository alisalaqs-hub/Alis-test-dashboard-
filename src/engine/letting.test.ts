import { describe, expect, it } from 'vitest';
import { availableText, cleanLetting, dateText, depositCap, depositCapText, depositWarning, isIsoDate, lettingLine, lettingRows, weeklyRent } from './letting';
import { buildListing, complianceChecks, type ListingInput } from './listings';

const TODAY = '2026-11-19';

describe('letting details', () => {
  it('never uses lookbehind (the module loads with the site)', () => {
    const sources = import.meta.glob<string>('./letting.ts', { query: '?raw', import: 'default', eager: true });
    expect(Object.keys(sources)).toHaveLength(1);
    for (const src of Object.values(sources)) {
      expect(src).toMatch(/export function depositCap/);
      expect(src).not.toMatch(/\(\?<[=!]/);
    }
  });

  it('works out the deposit cap for England: five weeks’ rent, or six from £50,000 a year', () => {
    expect(weeklyRent(1600)).toBeCloseTo(369.23, 2);
    expect(depositCap(1600)).toMatchObject({ weeks: 5 });
    expect(depositCap(1600)!.amount).toBeCloseTo(1846.15, 2);
    // £4,166.67 a month is £50,000.04 a year: six weeks. £4,166 a month is £49,992: five.
    expect(depositCap(4166)!.weeks).toBe(5);
    expect(depositCap(4166.67)!.weeks).toBe(6);
    expect(depositCap(5000)).toMatchObject({ weeks: 6 });
    expect(depositCap(5000)!.amount).toBeCloseTo(6923.08, 2);
    expect(depositCap(0)).toBeNull();
    expect(depositCapText(1600)).toBe('In England the most a landlord can take as a deposit is five weeks’ rent (£1,846 here).');
    expect(depositCapText(5000)).toBe('In England the most a landlord can take as a deposit is six weeks’ rent (£6,923 here).');
  });

  it('warns only for a deposit above the cap', () => {
    expect(depositWarning(1846, 1600)).toBeNull();
    expect(depositWarning(1846.15, 1600)).toBeNull();
    expect(depositWarning(1847, 1600)).toBe('In England the most a landlord can take as a deposit is five weeks’ rent (£1,846 here).');
    expect(depositWarning(3200, 1600)).toMatch(/five weeks’ rent \(£1,846 here\)/);
    expect(depositWarning(6900, 5000)).toBeNull();
    expect(depositWarning(7000, 5000)).toMatch(/six weeks’ rent \(£6,923 here\)/);
    // nothing to compare yet: no rent, or no deposit
    expect(depositWarning(2000, 0)).toBeNull();
    expect(depositWarning(null, 1600)).toBeNull();
    expect(depositWarning(0, 1600)).toBeNull();
  });

  it('says when a home is available: now when the date is empty or has passed', () => {
    expect(availableText(null, { today: TODAY })).toBe('Available now');
    expect(availableText('', { today: TODAY })).toBe('Available now');
    expect(availableText('2026-11-01', { today: TODAY })).toBe('Available now');
    expect(availableText(TODAY, { today: TODAY })).toBe('Available now');
    expect(availableText('2026-12-01', { today: TODAY })).toBe('Available from 1 December 2026');
    expect(availableText('2026-12-01', { short: true, today: TODAY })).toBe('Available 1 Dec');
    expect(availableText('2027-01-05', { short: true, today: TODAY })).toBe('Available 5 Jan 2027');
    expect(availableText('not a date', { today: TODAY })).toBe('Available now');
    expect(dateText('2026-12-01')).toBe('1 December 2026');
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('01/12/2026')).toBe(false);
  });

  it('keeps only valid letting details, and the HMO licence only for an HMO', () => {
    expect(cleanLetting({ deposit: '1800', availableFrom: '2026-12-01', furnished: 'furnished', petsConsidered: true, billsIncluded: false, maxOccupants: 4, letType: 'hmo', hmoLicence: 'licensed', epcExemption: true }))
      .toEqual({ deposit: 1800, availableFrom: '2026-12-01', furnished: 'furnished', petsConsidered: true, billsIncluded: false, maxOccupants: 4, letType: 'hmo', hmoLicence: 'licensed', epcExemption: true });
    expect(cleanLetting({ letType: 'whole', hmoLicence: 'licensed', furnished: 'sort of', deposit: -5, maxOccupants: 2.5, availableFrom: 'soon', epcExemption: false, extra: 'x' })).toEqual({ letType: 'whole' });
    expect(cleanLetting({})).toBeNull();
    expect(cleanLetting(null)).toBeNull();
    expect(cleanLetting('furnished')).toBeNull();
  });

  it('words the letting details for the listing page: rows only for what is known', () => {
    const full = { listing: 'rent', epc: { current: 'F' }, letting: { deposit: 1800, availableFrom: '2026-12-01', furnished: 'part-furnished' as const, petsConsidered: true, billsIncluded: true, maxOccupants: 4, letType: 'hmo' as const, hmoLicence: 'applied' as const, epcExemption: true } };
    expect(lettingRows(full, TODAY)).toEqual([
      { label: 'Deposit', value: '£1,800' }, { label: 'Available from', value: '1 December 2026' }, { label: 'Furnishing', value: 'Part furnished' },
      { label: 'Pets', value: 'Considered' }, { label: 'Bills', value: 'Included in the rent' }, { label: 'Maximum occupants', value: '4' },
      { label: 'Let type', value: 'House in multiple occupation (HMO)' }, { label: 'HMO licence', value: 'Licence applied for' },
      { label: 'Energy rating', value: 'F (registered exemption)' },
    ]);
    // an unticked "pets considered" says nothing; bills not included is an answer; the exemption only shows for F or G
    expect(lettingRows({ listing: 'rent', epc: 'C', letting: { furnished: 'unfurnished', petsConsidered: false, billsIncluded: false, epcExemption: true } }, TODAY)).toEqual([
      { label: 'Available from', value: 'Now' }, { label: 'Furnishing', value: 'Unfurnished' }, { label: 'Bills', value: 'Not included' },
    ]);
    expect(lettingRows({ listing: 'rent', letting: { deposit: 0 } }, TODAY)[0]).toEqual({ label: 'Deposit', value: 'No deposit' });
    // nothing for a sale, or a rental with no details
    expect(lettingRows({ listing: 'sale', letting: full.letting }, TODAY)).toEqual([]);
    expect(lettingRows({ listing: 'rent' }, TODAY)).toEqual([]);
    expect(lettingRows({ listing: 'rent', letting: null }, TODAY)).toEqual([]);
  });

  it('gives search cards a short line', () => {
    expect(lettingLine({ listing: 'rent', letting: { availableFrom: '2026-12-01', furnished: 'furnished' } }, TODAY)).toBe('Available 1 Dec · Furnished');
    expect(lettingLine({ listing: 'rent', letting: { furnished: 'unfurnished' } }, TODAY)).toBe('Available now · Unfurnished');
    expect(lettingLine({ listing: 'rent', letting: { availableFrom: '2026-01-01', petsConsidered: true } }, TODAY)).toBe('Available now');
    expect(lettingLine({ listing: 'sale', letting: { furnished: 'furnished' } }, TODAY)).toBe('');
    expect(lettingLine({ listing: 'rent' }, TODAY)).toBe('');
  });
});

const LET: ListingInput = {
  listing: 'rent', addressLine: '14 Elm Road', town: 'London', postcode: 'E17 4QH', type: 'flat', tenure: 'freehold', beds: 2, baths: 1, floorArea: 60, price: 1600,
  epc: 'C', councilTax: 'B', features: [], photos: ['a', 'b', 'c'], description: 'A bright two-bedroom flat.', source: { kind: 'landlord', name: '', licence: '', verified: false },
};
const failing = (over: Partial<ListingInput>) => complianceChecks({ ...LET, ...over }, { minPhotos: 1 }).filter((c) => !c.ok).map((c) => `${c.id}:${c.severity}`);

describe('letting details on a listing', () => {
  it('puts them on a rental and never on a sale', () => {
    const letting = { deposit: 1800, furnished: 'furnished' as const, letType: 'whole' as const };
    expect(buildListing({ ...LET, letting }).letting).toEqual(letting);
    expect(buildListing({ ...LET, listing: 'sale', price: 400000, letting }).letting).toBeUndefined();
    expect(buildListing(LET).letting).toBeUndefined();
  });

  it('warns about a deposit above the cap, without blocking', () => {
    expect(failing({ letting: { deposit: 1800 } })).toEqual([]);
    expect(failing({ letting: { deposit: 3200 } })).toEqual(['deposit-cap:warn']);
    expect(complianceChecks({ ...LET, letting: { deposit: 3200 } }).find((c) => c.id === 'deposit-cap')!.message).toBe('In England the most a landlord can take as a deposit is five weeks’ rent (£1,846 here).');
    // six weeks from £50,000 a year
    expect(failing({ price: 5000, letting: { deposit: 6900 } })).toEqual([]);
    expect(failing({ price: 5000, letting: { deposit: 7000 } })).toEqual(['deposit-cap:warn']);
    // the cap is England's: a home in Scotland or Wales isn't checked against it; a sale never is
    expect(failing({ postcode: 'EH1 1YZ', letting: { deposit: 3200 } })).toEqual([]);
    expect(failing({ postcode: 'CF10 1EP', letting: { deposit: 3200 } })).toEqual([]);
    expect(failing({ listing: 'sale', price: 400000, letting: { deposit: 999999 } })).toEqual([]);
  });

  it('lifts the EPC block for a let rated F or G when a registered exemption is declared', () => {
    expect(failing({ epc: 'F' })).toEqual(['epc-let:block']);
    expect(failing({ epc: 'G', letting: { epcExemption: false } })).toEqual(['epc-let:block']);
    expect(failing({ epc: 'F', letting: { epcExemption: true } })).toEqual([]);
    expect(failing({ epc: 'G', letting: { epcExemption: true } })).toEqual([]);
    expect(complianceChecks({ ...LET, epc: 'F' }).find((c) => c.id === 'epc-let')!.message).toMatch(/EPC E or better.*registered exemption/);
  });

  it('never asks a let for tenure, lease length or charges', () => {
    expect(failing({ tenure: 'leasehold', leaseYears: undefined, serviceChargeAnnual: undefined })).toEqual([]);
    expect(failing({ tenure: undefined as unknown as ListingInput['tenure'] })).toEqual([]);
    // a sale still is
    expect(failing({ listing: 'sale', price: 400000, tenure: 'leasehold' })).toEqual(['lease:block', 'charges:warn']);
  });
});
