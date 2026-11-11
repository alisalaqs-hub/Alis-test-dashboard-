import { describe, expect, it } from 'vitest';
import { slugPlace, unslugPlace } from './places';

describe('place names in page addresses', () => {
  it('turns a place or postcode into an address part', () => {
    expect(slugPlace('St Albans')).toBe('st-albans');
    expect(slugPlace('  Newcastle upon Tyne ')).toBe('newcastle-upon-tyne');
    expect(slugPlace('E17 4PP')).toBe('e17-4pp');
    expect(slugPlace('King’s Lynn')).toBe('kings-lynn');
    expect(slugPlace('Brighton & Hove')).toBe('brighton-and-hove');
    expect(slugPlace('!!!')).toBe('');
  });
  it('reads it back as people write it', () => {
    expect(unslugPlace('st-albans')).toBe('St Albans');
    expect(unslugPlace('newcastle-upon-tyne')).toBe('Newcastle upon Tyne');
    expect(unslugPlace('stoke-on-trent')).toBe('Stoke on Trent');
    expect(unslugPlace('e17-4pp')).toBe('E17 4PP');
    expect(unslugPlace('m20')).toBe('M20');
    expect(unslugPlace('sw1a-1aa')).toBe('SW1A 1AA');
    expect(unslugPlace('Leeds')).toBe('Leeds');
    expect(unslugPlace('%E0%A4%A')).toBe('%E0%A4%A'); // a broken address part is kept as typed
  });
  it('round-trips postcodes and districts', () => {
    for (const pc of ['E17 4PP', 'M20', 'SW1A 1AA', 'B1 1AA', 'CF10']) expect(unslugPlace(slugPlace(pc))).toBe(pc);
  });
});
