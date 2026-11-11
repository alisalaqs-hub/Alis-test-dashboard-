import { describe, expect, it } from 'vitest';
import appSource from '../App.tsx?raw';
import { listingMeta, metaFor, ROUTES } from './meta';
import { spaRedirects } from '../../scripts/spa-redirects.mjs';

const routePaths = [...appSource.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => `/${m[1]}`).filter((p) => p !== '/*');

describe('page titles and search-engine rules', () => {
  it('every page in the app has a title and a rule', () => {
    for (const p of routePaths) {
      const concrete = p.replace(/:[a-z]+/gi, 'x');
      expect(metaFor(concrete).path, p).not.toBe('*');
    }
    expect(ROUTES.every((r) => r.path === '/' || r.title.length > 0)).toBe(true);
  });
  it('keeps personal pages and example dashboards out of search engines', () => {
    for (const p of ['/account', '/account/inbox/abc', '/admin', '/saved', '/compare', '/agents', '/landlord', '/developer', '/owner', '/property/x/intelligence']) expect(metaFor(p).index, p).toBe(false);
    for (const p of ['/', '/list', '/estimate', '/privacy', '/data-sources']) expect(metaFor(p).index, p).not.toBe(false);
    expect(metaFor('/no-such-page').index).toBe(false);
  });
  it('titles a listing, and only offers real listings to search engines', () => {
    const p = { id: 'SK-ABC123', title: 'Bright terrace', beds: 3, type: 'terraced', town: 'Walthamstow, London', price: 485000, listing: 'sale' };
    expect(listingMeta(p, true)).toMatchObject({ title: '3 bed terraced house for sale in Walthamstow, £485,000', index: true, canonical: '/property/SK-ABC123' });
    expect(listingMeta(p, false).index).toBe(false);                                   // an example listing
    expect(listingMeta({ ...p, visibility: 'private' }, true).index).toBe(false);       // private to its owner
    expect(listingMeta({ ...p, type: 'flat', beds: 2, listing: 'rent', price: 1650 }, true).title).toBe('2 bed flat to rent in Walthamstow, £1,650 pcm');
  });
});

describe('page addresses on Netlify', () => {
  it('sends every page of the app to the site, and nothing else', () => {
    const rules = spaRedirects(appSource).trim().split('\n');
    for (const p of routePaths) {
      const seg = p.split('/')[1];
      expect(rules, p).toContain(`/${seg} /index.html 200`);
      expect(rules, p).toContain(`/${seg}/* /index.html 200`);
    }
    // never a catch-all, and never the paths the functions answer
    expect(rules.some((r) => r.startsWith('/* '))).toBe(false);
    for (const reserved of ['api', 'media', 'sitemap.xml', 'robots.txt', '.netlify']) expect(rules.some((r) => r.startsWith(`/${reserved}`))).toBe(false);
  });
});
