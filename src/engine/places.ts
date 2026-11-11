/**
 * Place names in page addresses: /sold-prices/st-albans, /for-sale/e17, /to-rent/leeds.
 * Shared by the website (routes and links) and the server (the sitemap), so both spell them the same way.
 */
const POSTCODE = /^([a-z]{1,2}\d[a-z\d]?)(?:[-\s]?(\d[a-z]{2}))?$/i;
/** "St Albans" → "st-albans", "E17 4PP" → "e17-4pp". */
export const slugPlace = (name: string) => name.trim().toLowerCase().replace(/&/g, ' and ').replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
/** "st-albans" → "St Albans", "e17-4pp" → "E17 4PP", "m20" → "M20". */
export function unslugPlace(slug: string): string {
  let s = slug;
  try { s = decodeURIComponent(slug); } catch { /* keep as typed */ }
  s = s.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const pc = s.replace(/\s/g, '-').match(POSTCODE);
  if (pc) return `${pc[1].toUpperCase()}${pc[2] ? ` ${pc[2].toUpperCase()}` : ''}`;
  const SMALL = new Set(['and', 'on', 'upon', 'under', 'in', 'le', 'the', 'of', 'by', 'next']);
  return s.split(' ').map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}
