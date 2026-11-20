/**
 * A phone number, as people write it, as a link that dials it: "020 7946 0123" and "+44 (0)20 7946 0123"
 * both work. With a country code, the "(0)" that is left out when dialling from abroad is dropped.
 */
export function telHref(phone: string): string {
  const p = phone.trim();
  const international = p.startsWith('+');
  const digits = (international ? p.replace(/\(0\)/g, '') : p).replace(/\D/g, '');
  return `tel:${international ? '+' : ''}${digits}`;
}

/** A web address as people read it: "www.example.co.uk", not "https://www.example.co.uk/". */
export const displayUrl = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
