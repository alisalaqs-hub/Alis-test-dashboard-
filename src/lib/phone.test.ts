import { describe, expect, it } from 'vitest';
import { displayUrl, telHref } from './phone';

describe('a phone number as a link', () => {
  it('dials the number however it was written', () => {
    expect(telHref('020 7946 0123')).toBe('tel:02079460123');
    expect(telHref(' (0161) 496-0123 ')).toBe('tel:01614960123');
    expect(telHref('+44 20 7946 0123')).toBe('tel:+442079460123');
  });
  it('drops the bracketed zero after a country code', () => {
    expect(telHref('+44 (0)20 7946 0123')).toBe('tel:+442079460123');
    expect(telHref('(0)20 7946 0123')).toBe('tel:02079460123'); // without a country code the zero is dialled
  });
});

describe('a web address as people read it', () => {
  it('leaves out https:// and a closing slash', () => {
    expect(displayUrl('https://www.example.co.uk/')).toBe('www.example.co.uk');
    expect(displayUrl('https://example.co.uk/fees/lettings')).toBe('example.co.uk/fees/lettings');
  });
});
