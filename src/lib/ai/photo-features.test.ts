import { describe, expect, it } from 'vitest';
import { PROPERTIES } from '../../data/properties';
import type { SearchHit } from '../../engine/search';
import { dtoToProperty } from '../listingAdapter';
import type { ListingDTO } from '../apiTypes';
import { applyExtras, mustHavesIn } from './search';

const dto = (photos: ListingDTO['photos']): ListingDTO => ({
  ref: 'sk-abc1234', status: 'live', channel: 'sale', title: 'A home', addressLine: 'Elm Road', town: 'London', postcode: 'E17', district: 'E17', lat: null, lng: null, type: 'terraced',
  tenure: 'freehold', leaseYears: null, beds: 3, baths: 1, floorArea: 92, era: null, condition: null, price: 525000, priceQualifier: null, epc: 'D', councilTax: 'C', serviceChargeAnnual: null,
  groundRentAnnual: null, features: ['Garden'], description: null, photos, source: { kind: 'owner', name: 'Private seller', verified: false }, ownershipVerified: false,
  createdAt: '2026-11-01T00:00:00Z', publishedAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', mine: false,
});

describe('what Streetkey AI saw in a listing’s photos', () => {
  it('is gathered across the photos, most-seen first, leaving out the floor plan', () => {
    const p = dtoToProperty(dto([
      { id: '1', url: '/media/a.jpg', alt: 'Living room', features: ['period fireplace', 'wooden floors'] },
      { id: '2', url: '/media/b.jpg', alt: 'Dining room', features: ['wooden floors', 'bay window'] },
      { id: '3', url: '/media/plan.png', alt: 'Floor plan: 3 rooms, 60 m²', features: ['staircase'] },
      { id: '4', url: '/media/c.jpg', alt: null },
    ]));
    expect(p.photoFeatures).toEqual(['wooden floors', 'period fireplace', 'bay window']);
    expect(dtoToProperty(dto([{ id: '1', url: '/media/a.jpg', alt: null }])).photoFeatures).toBeUndefined();
  });

  it('counts towards a must-have, and the result says it came from the photos', () => {
    const home = { ...PROPERTIES[0], features: ['Garden'], description: 'A bright family home.', title: 'Family home', photoFeatures: ['period fireplace', 'bay window'] };
    expect(mustHavesIn(home, ['fireplace', 'garden', 'balcony'])).toEqual(['fireplace', 'garden']);
    expect(mustHavesIn({ ...home, photoFeatures: undefined }, ['fireplace'])).toEqual([]);

    const plain = { ...PROPERTIES[1], features: [], description: '', title: 'Another home', photoFeatures: undefined };
    const hit = (property: typeof home | typeof plain): SearchHit => ({ property, score: 1, reasons: [], cautions: [], dealGrade: 'B', estProfit: 0 } as unknown as SearchHit);
    const out = applyExtras([hit(plain), hit(home)], { mustHaves: ['fireplace', 'garden'] } as Parameters<typeof applyExtras>[1]);
    expect(out[0].property.title).toBe('Family home'); // the home that has them comes first, the other is still there
    expect(out).toHaveLength(2);
    expect(out[0].reasons.slice(0, 2)).toEqual(['Mentions garden', 'Seen in the photos: fireplace']);
  });
});

describe('asking for a feature without AI', () => {
  it('reads the common ones as preferences, never as a filter, and not when they are ruled out', async () => {
    const { fromRules } = await import('./search');
    expect(fromRules('3 bed house in Leeds with a fireplace and a bay window').extras.mustHaves).toEqual(['fireplace', 'bay window']);
    expect(fromRules('flat with a balcony and parking, no garage').extras.mustHaves).toEqual(['balcony', 'parking']);
    expect(fromRules('house without a driveway').extras.mustHaves).toEqual([]);
    expect(fromRules('3 bed house in Leeds').extras.mustHaves).toEqual([]);
    expect(fromRules('open-plan flat with an en suite').extras.mustHaves).toEqual(['open plan', 'en-suite']);
    // shown as a removable preference chip
    expect(fromRules('house with a fireplace').understood.some((c) => c.key === 'must:fireplace' && c.kind === 'preference')).toBe(true);
  });
});
