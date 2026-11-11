/**
 * Page titles, descriptions and search-engine rules for the whole site, in one place.
 *
 * Every page has its own address (no "#"), title and description so search engines can list it and a
 * shared link reads well. What may be listed is decided per page:
 *   - listed:     the home page, sold prices (real HM Land Registry data), the tools, the legal pages,
 *                 real listings, and place pages that have real listings
 *   - not listed: example listings and the example dashboards (they are illustrations, not homes for
 *                 sale), anything personal (account, saved, compare, admin) and thin or empty pages
 *
 * Fixed pages take their entry from ROUTES; pages whose title depends on what they load (a listing, a
 * place) are marked `dynamic` and call usePageMeta themselves.
 */
import { useEffect } from 'react';
import { matchPath } from 'react-router-dom';

/** "Portable" builds (the single-file version and the optional GitHub Pages demo) keep #/ addresses and are never listed. */
export const PORTABLE = import.meta.env.MODE === 'single' || import.meta.env.VITE_PORTABLE === '1';

export interface PageMeta {
  /** Without the site name; '' for the home page. */
  title: string;
  description?: string;
  /** May search engines list this page? Default: yes. */
  index?: boolean;
  /** The page's preferred address when several lead to it (a path, default: the current one). */
  canonical?: string;
}
interface RouteMeta extends PageMeta { path: string; dynamic?: boolean }

const SITE = 'Streetkey';
const HOME_TITLE = 'Streetkey: homes for sale and to rent, with the full picture';
export const DEFAULT_DESCRIPTION = 'Search homes for sale and to rent across the UK. Every home comes with real sold prices nearby, flood risk, its energy rating and the true cost of works.';
const personal = { index: false } as const;
const example = { index: false } as const; // example dashboards: illustrations, not real figures

export const ROUTES: RouteMeta[] = [
  { path: '/', title: '', description: DEFAULT_DESCRIPTION },
  { path: '/search', title: 'Search homes for sale and to rent', dynamic: true },
  { path: '/for-sale/:place', title: 'Homes for sale', dynamic: true },
  { path: '/to-rent/:place', title: 'Homes to rent', dynamic: true },
  { path: '/property/:id', title: 'Property', dynamic: true },
  { path: '/property/:id/intelligence', title: 'Property intelligence', index: false },
  { path: '/prices', title: 'Sold house prices', dynamic: true },
  { path: '/sold-prices/:place', title: 'Sold house prices', dynamic: true },
  { path: '/list', title: 'List a property for sale or to rent', description: 'Sell or let your property on Streetkey. Your listing gets a price check against real sold prices, an AI-written description you can edit and a photo check.' },
  { path: '/floor-plan', title: 'Floor plan maker', description: 'Turn room measurements or a photo of a sketch into a clean floor plan with each room’s dimensions and the total area in square metres.' },
  { path: '/import', title: 'Check any property listing', description: 'Paste a listing from any property website for a price check, renovation cost and investment view.' },
  { path: '/my-home', title: 'What is my home worth?', description: 'A value range for your home from real sold prices nearby, with ideas for adding value and what they would cost.' },
  { path: '/estimate', title: 'Renovation cost calculator', description: 'A trade-by-trade estimate of what a refurbishment will cost in your area, including VAT, fees and contingency.' },
  { path: '/studio', title: 'Room design studio', description: 'Restyle a room, see how it could look and get the cost of the works.' },
  { path: '/invest', title: 'Property investment calculator', description: 'Yield, cash flow, stamp duty and a stress test for a buy-to-let or a refurbishment project.' },
  { path: '/sources', title: 'Listing feeds for estate and letting agents', description: 'Send your listings to Streetkey automatically from your agency software.' },
  { path: '/compare', title: 'Compare homes', ...personal },
  { path: '/saved', title: 'Saved homes', ...personal },
  { path: '/privacy', title: 'Privacy notice' },
  { path: '/terms', title: 'Terms of use' },
  { path: '/accessibility', title: 'Accessibility statement' },
  { path: '/data-sources', title: 'Where our data comes from', description: 'The official sources behind Streetkey: HM Land Registry sold prices, the UK House Price Index, Environment Agency flood risk and the EPC register.' },
  { path: '/owner', title: 'Owner dashboard', ...example },
  { path: '/agents', title: 'For estate agents', ...example },
  { path: '/landlord', title: 'For landlords', ...example },
  { path: '/developer', title: 'For property developers', ...example },
  { path: '/marketplace', title: 'Trades marketplace', ...example },
  { path: '/automation', title: 'Automation', ...example },
  { path: '/enterprise', title: 'Streetkey for business', ...example },
  { path: '/developers', title: 'Streetkey for business', ...example },
  { path: '/account/*', title: 'Your account', ...personal },
  { path: '/account', title: 'Your account', ...personal },
  { path: '/admin', title: 'Admin', ...personal },
];
const NOT_FOUND: RouteMeta = { path: '*', title: 'Page not found', index: false };

export function metaFor(pathname: string): RouteMeta {
  return ROUTES.find((r) => matchPath({ path: r.path, end: true }, pathname)) ?? NOT_FOUND;
}

function setTag(selector: string, make: () => HTMLElement, attr: string, value: string | null) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (value == null) { el?.remove(); return; }
  if (!el) { el = make(); document.head.appendChild(el); }
  el.setAttribute(attr, value);
}
const metaTag = (key: 'name' | 'property', id: string) => () => { const m = document.createElement('meta'); m.setAttribute(key, id); return m; };

/** Writes the title, description, canonical address and listing rule into the page head. */
export function applyMeta(m: PageMeta, pathname: string = location.pathname) {
  const title = m.title ? `${m.title} | ${SITE}` : HOME_TITLE;
  const description = m.description ?? DEFAULT_DESCRIPTION;
  document.title = title;
  setTag('meta[name="description"]', metaTag('name', 'description'), 'content', description);
  setTag('meta[property="og:title"]', metaTag('property', 'og:title'), 'content', title);
  setTag('meta[property="og:description"]', metaTag('property', 'og:description'), 'content', description);
  const listed = !PORTABLE && m.index !== false;
  setTag('meta[name="robots"]', metaTag('name', 'robots'), 'content', listed ? null : 'noindex');
  const canonical = listed ? `${location.origin}${m.canonical ?? pathname}` : null;
  setTag('link[rel="canonical"]', () => { const l = document.createElement('link'); l.rel = 'canonical'; return l; }, 'href', canonical);
  setTag('meta[property="og:url"]', metaTag('property', 'og:url'), 'content', canonical);
}

/** For pages whose title depends on what they show. Pass null while there is nothing to say yet. */
export function usePageMeta(m: PageMeta | null) {
  const key = m ? `${m.title}\n${m.description ?? ''}\n${m.index !== false}\n${m.canonical ?? ''}` : null;
  useEffect(() => { if (m) applyMeta(m); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Title and description for a listing page. Only real listings are offered to search engines: example listings never are. */
export function listingMeta(p: { id: string; title: string; beds: number; type: string; town: string; price: number; listing: string; visibility?: string }, real: boolean): PageMeta {
  const kind = ({ flat: 'flat', bungalow: 'bungalow', commercial: 'commercial property' } as Record<string, string>)[p.type] ?? `${p.type} house`;
  const what = `${p.beds ? `${p.beds} bed ` : ''}${kind}`;
  const deal = p.listing === 'rent' ? 'to rent' : p.listing === 'auction' ? 'for auction' : 'for sale';
  const price = `£${Math.round(p.price).toLocaleString('en-GB')}${p.listing === 'rent' ? ' pcm' : ''}`;
  const town = p.town.split(',')[0].trim();
  return {
    title: `${what.charAt(0).toUpperCase()}${what.slice(1)} ${deal} in ${town}, ${price}`,
    description: `${p.title}. ${what.charAt(0).toUpperCase()}${what.slice(1)} ${deal} in ${p.town} at ${price}, with sold prices nearby, flood risk and the energy rating.`,
    index: real && p.visibility !== 'private',
    canonical: `/property/${p.id}`,
  };
}

/** A full address for a page, for sharing. */
export const pageUrl = (path: string) => (PORTABLE ? `${location.origin}${location.pathname}#${path}` : `${location.origin}${path}`);

export { slugPlace, unslugPlace } from '../engine/places';
