/**
 * Type-ahead suggestions for the single smart search box.
 * One box accepts a place, a postcode district, a listing, or a sentence —
 * no "classic vs AI" switch. Deterministic and instant (no network).
 */
import { PROPERTIES } from '../data/properties';

export type Suggestion =
  | { kind: 'place'; label: string; sub: string; query: string }
  | { kind: 'listing'; label: string; sub: string; id: string }
  | { kind: 'ai'; label: string; sub: string; query: string };

const PLACES = (() => {
  const m = new Map<string, { label: string; sub: string; count: number }>();
  for (const p of PROPERTIES) {
    const area = p.town.split(',')[0].trim();
    const city = p.town.split(',').pop()!.trim();
    const add = (key: string, label: string, sub: string) => { const e = m.get(key); m.set(key, { label, sub, count: (e?.count ?? 0) + 1 }); };
    add(area.toLowerCase(), area, area === city ? 'Town / city' : city);
    if (city !== area) add(city.toLowerCase(), city, 'City');
    add(p.district.toLowerCase(), p.district, `Postcode district · ${area}`);
  }
  return [...m.values()];
})();

/** True when the text reads like a sentence/criteria rather than just a place. */
export function looksLikeSentence(text: string) {
  return text.trim().split(/\s+/).length >= 4 || /£|\bbed|under|with|near|garden|yield|invest|convert|flat|house/i.test(text);
}

export function suggest(text: string, limit = 7): Suggestion[] {
  const t = text.trim().toLowerCase();
  if (!t) return [];
  const out: Suggestion[] = [];
  const places = PLACES.filter((p) => p.label.toLowerCase().startsWith(t) || p.label.toLowerCase().includes(` ${t}`) || (t.length >= 3 && p.label.toLowerCase().includes(t)))
    .sort((a, b) => b.count - a.count).slice(0, 4);
  for (const p of places) out.push({ kind: 'place', label: p.label, sub: `${p.sub} · ${p.count} listing${p.count === 1 ? '' : 's'}`, query: p.label });
  if (t.length >= 3) for (const p of PROPERTIES.filter((x) => `${x.title} ${x.street}`.toLowerCase().includes(t)).slice(0, 2)) out.push({ kind: 'listing', label: p.street.replace(' (fictional)', ''), sub: `${p.town} · ${p.title}`, id: p.id });
  if (looksLikeSentence(text) || out.length === 0) out.unshift({ kind: 'ai', label: text.trim(), sub: 'Search with BRIXO AI — understands budgets, features, commute & returns', query: text.trim() });
  else out.push({ kind: 'ai', label: `“${text.trim()}” — ask BRIXO AI`, sub: 'Describe what you want in your own words', query: text.trim() });
  return out.slice(0, limit);
}
