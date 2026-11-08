/**
 * Streetkey AI search: shared types and deterministic helpers.
 *
 * Used by the website (Search page, Similar homes) AND by the server (server/src/ai/search),
 * so the chips people see, the constraints they can remove and the "similar homes" reasons
 * are identical whether the AI answered or the built-in rules did.
 *
 * Keep this file free of browser-only imports (React, fetch helpers, import.meta.env):
 * the server type-checks and bundles it.
 */
import { parseQuery, type SearchHit, type SearchQuery } from '../../engine/search';
import type { Property } from '../../data/properties';

/* ───────────────────────── API shapes ───────────────────────── */

/** The search box modes (SmartSearch tabs). */
export type SearchMode = 'buy' | 'rent' | 'sold' | 'commercial' | 'invest';
export const SEARCH_MODES: readonly SearchMode[] = ['buy', 'rent', 'sold', 'commercial', 'invest'];

/** Things people asked for that the engine can't filter on yet; the website applies the numeric ones itself. */
export interface SearchExtras { minPrice: number | null; maxBeds: number | null; mustHaves: string[] }

/** One "understood" chip. `key` identifies the constraint, so removing the chip removes exactly that constraint. */
export interface SearchChip { key: string; label: string; removable: boolean }

/** A tappable follow-up: the answers are phrases added to the search text. */
export interface Clarify { question: string; answers: string[] }

/** POST /api/ai/search/intent */
export interface IntentResult {
  /** The search text this answers (as sent). */
  q: string;
  /** Engine-ready query for runSearch(). */
  query: SearchQuery;
  extras: SearchExtras;
  understood: SearchChip[];
  clarify: Clarify | null;
  /** Short noun phrases: "We can't filter on … yet". */
  unsupported: string[];
  /** Set when someone asked to choose areas by who lives there (never turned into a filter). */
  policyNote: string | null;
  /** 'ai' when Streetkey AI built the query; 'rules' when the built-in parser did (fallback). */
  source: 'ai' | 'rules';
}

/** A card in "Similar homes" (public facts only). */
export interface SimilarItem {
  id: string; title: string; listing: Property['listing']; price: number; beds: number; type: Property['type'];
  town: string; district: string; photo: string | null; photoHue: number;
  /** One line built in code from structured differences (never written by the model). */
  reason: string;
  score: number;
}
/** GET /api/ai/search/similar/:id */
export interface SimilarResult { items: SimilarItem[]; semantic: boolean }
/** POST /api/ai/search/rank */
export interface RankResult { items: { id: string; score: number }[]; missing: string[] }

/* ───────────────────────── constants ───────────────────────── */

export const FLAG_FIELDS = ['wantsLoft', 'wantsExtension', 'wantsGarden', 'hmo', 'auction', 'chainFree', 'goodSchools', 'conversion', 'lowServiceCharge', 'needsRefurb', 'goodReturn', 'rentalDemand', 'commercial'] as const;
export type FlagField = typeof FLAG_FIELDS[number];
export const FLAG_LABELS: Record<FlagField, string> = {
  wantsLoft: 'Loft potential', wantsExtension: 'Room to extend', wantsGarden: 'Garden', hmo: 'HMO', auction: 'Auction', chainFree: 'Chain-free',
  goodSchools: 'Good schools nearby', conversion: 'Convert to flats', lowServiceCharge: 'Low service charge', needsRefurb: 'Needs work',
  goodReturn: 'Good investment return', rentalDemand: 'Strong rental demand', commercial: 'Commercial',
};
export const PROPERTY_TYPES = ['terraced', 'semi-detached', 'detached', 'flat', 'bungalow', 'commercial'] as const;
const TYPE_LABELS: Record<Property['type'], string> = { terraced: 'Terraced', 'semi-detached': 'Semi-detached', detached: 'Detached', flat: 'Flat', bungalow: 'Bungalow', commercial: 'Commercial' };
const HOUSES = ['detached', 'semi-detached', 'terraced'];

/** UK postcode district (outward code), e.g. E17, M14, SW1A, CR0. */
export const DISTRICT_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/;
export const isLiveRef = (id: string) => /^sk-[a-z0-9]{7}$/.test(id);
export const MAX_QUERY_CHARS = 300;

export const POLICY_NOTE = 'Streetkey doesn’t search or rank areas by who lives there. You can search by home, budget, commute, schools and more.';
/** Requests to pick areas by the people who live there (protected characteristics). Never turned into filters. */
const DEMOGRAPHIC_RES = [
  /\b(ethnic(ity|ally)?|racial(ly)?|race of)\b/i,
  /\b(asian|black|white|polish|indian|pakistani|bangladeshi|african|caribbean|chinese|arab|jewish|muslim|christian|hindu|sikh|catholic|english|british|eastern european|foreign|immigrant|lgbt\w*|gay|straight|disabled|elderly|retired|old|young)\s+(area|areas|community|communities|neighbou?rhoods?|people|families|residents|majority|population|neighbou?rs|crowd)\b/i,
  /\b(mostly|mainly|predominantly|majority|full of|lots of|area with|neighbou?rhood with|community of|no|fewer|without|avoid)\s+(asian|black|white|polish|indian|pakistani|african|caribbean|chinese|arab|jews|jewish|muslims?|christians?|hindus?|sikhs|immigrants?|foreigners?|migrants?|gay|lgbt\w*|disabled|elderly|old) ?(people|families|residents|neighbou?rs)?\b/i,
];
export const asksForDemographics = (text: string) => DEMOGRAPHIC_RES.some((re) => re.test(text));

/* ───────────────────────── formatting ───────────────────────── */

const gbp = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
/** £485k, £1.45m, £1,250 */
export function gbpShort(n: number) {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `£${Number((a / 1_000_000).toFixed(2))}m`;
  if (a >= 10_000) return `£${Math.round(a / 1_000)}k`;
  return gbp(a);
}
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const titleCase = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
/** Same text → same cache key: case, spacing, quotes and trailing punctuation don't matter. */
export const normaliseQuery = (text: string) => text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().replace(/[\s.!?,;:]+$/, '');

/* ───────────────────────── queries & chips ───────────────────────── */

const emptyExtras = (): SearchExtras => ({ minPrice: null, maxBeds: null, mustHaves: [] });
const copyQuery = (q: SearchQuery): SearchQuery => ({ ...q, locations: [...q.locations], districts: [...q.districts], types: [...q.types], unsupported: [...q.unsupported] });

/** The search box mode nudges the query (the text itself usually says it too). */
export function applyMode(query: SearchQuery, mode?: SearchMode | null): SearchQuery {
  const q = copyQuery(query);
  if (mode === 'rent') q.intent = 'rent';
  if (mode === 'invest' && q.intent === 'buy') q.intent = 'invest';
  if (mode === 'commercial') { q.commercial = true; q.types = []; }
  return q;
}

/** Built-in rules' "not covered" sentences → the short phrases shown as "We can't filter on … yet". */
export function shortUnsupported(sentences: string[]) {
  const map: [RegExp, string][] = [[/^crime/i, 'crime and safety'], [/^broadband/i, 'broadband speed'], [/^new-build/i, 'new builds only']];
  return sentences.map((s) => map.find(([re]) => re.test(s))?.[1] ?? s.split(/\s+[—-]\s+/)[0].replace(/\.$/, '').toLowerCase()).filter(Boolean);
}

/** A few extras the engine can't use, read by rules (the AI usually does better). */
function rulesExtras(text: string, query: SearchQuery): SearchExtras {
  const t = text.toLowerCase();
  const ex = emptyExtras();
  const amount = (raw: string) => { const m = raw.replace(/[£,\s]/g, '').match(/^(\d+(?:\.\d+)?)(k|m)?$/); if (!m) return NaN; const n = parseFloat(m[1]); return m[2] === 'k' ? n * 1e3 : m[2] === 'm' ? n * 1e6 : n; };
  const between = t.match(/\bbetween\s+(£?\s?[\d,.]+\s?[km]?)\s+(?:and|to|-)\s+(£?\s?[\d,.]+\s?[km]?)/);
  if (between) {
    const lo = amount(between[1]); const hi = amount(between[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi && hi >= 100) { ex.minPrice = lo; if (!query.maxPrice) query.maxPrice = hi; }
  }
  const maxBeds = t.match(/\b(?:up to|max(?:imum)?|no more than|at most)\s+(\d)\s*(?:-\s*)?(?:bed(?:room)?s?)\b/);
  if (maxBeds) ex.maxBeds = parseInt(maxBeds[1], 10);
  return ex;
}

/** Chips for a query, labelled in code (numbers always come from the query itself). */
export function chipsFor(query: SearchQuery, extras: SearchExtras, aiLabels: Partial<Record<string, string>> = {}): SearchChip[] {
  const out: SearchChip[] = [];
  const rent = query.intent === 'rent';
  const pcm = rent ? ' pcm' : '';
  const money = (n: number) => (rent ? gbp(n) : gbpShort(n));
  out.push({ key: 'intent', label: aiLabels.intent ?? (query.intent === 'rent' ? 'To rent' : query.intent === 'invest' ? 'Investment' : 'To buy'), removable: false });
  for (const l of query.locations) out.push({ key: `location:${l}`, label: l, removable: true });
  for (const d of query.districts) out.push({ key: `district:${d}`, label: d, removable: true });
  if (query.maxCommuteMins) out.push({ key: 'commute', label: `Within ${query.maxCommuteMins} min${query.commuteTo ? ` of ${titleCase(query.commuteTo)}` : ''}`, removable: true });
  if (query.types.length && [...query.types].sort().join() === HOUSES.join()) out.push({ key: 'types', label: 'Houses', removable: true });
  else for (const t of query.types) out.push({ key: `type:${t}`, label: TYPE_LABELS[t] ?? t, removable: true });
  if (query.minBeds) out.push({ key: 'minBeds', label: `${query.minBeds}+ bed${query.minBeds === 1 ? '' : 's'}`, removable: true });
  if (extras.maxBeds) out.push({ key: 'maxBeds', label: `Up to ${extras.maxBeds} bed${extras.maxBeds === 1 ? '' : 's'}`, removable: true });
  if (extras.minPrice) out.push({ key: 'minPrice', label: `From ${money(extras.minPrice)}${pcm}`, removable: true });
  if (query.maxPrice) out.push({ key: 'maxPrice', label: `Under ${money(query.maxPrice)}${pcm}`, removable: true });
  for (const f of FLAG_FIELDS) if (query[f]) out.push({ key: f, label: aiLabels[f] ?? FLAG_LABELS[f], removable: true });
  if (query.minYield) out.push({ key: 'minYield', label: `${Number((query.minYield * 100).toFixed(1))}%+ yield`, removable: true });
  if (query.minRefurbProfit) out.push({ key: 'minRefurbProfit', label: `Profit ${gbpShort(query.minRefurbProfit)}+`, removable: true });
  for (const m of extras.mustHaves) out.push({ key: `must:${m.toLowerCase()}`, label: cap(m), removable: true });
  return out;
}

/** The same search without one chip's constraint. */
export function withoutChip(state: { query: SearchQuery; extras: SearchExtras }, key: string): { query: SearchQuery; extras: SearchExtras } {
  const query = copyQuery(state.query);
  const extras: SearchExtras = { ...state.extras, mustHaves: [...state.extras.mustHaves] };
  const i = key.indexOf(':');
  const k = i < 0 ? key : key.slice(0, i);
  const v = i < 0 ? '' : key.slice(i + 1);
  switch (k) {
    case 'location': query.locations = query.locations.filter((l) => l !== v); break;
    case 'district': query.districts = query.districts.filter((d) => d !== v); break;
    case 'type': query.types = query.types.filter((t) => t !== v); break;
    case 'types': query.types = []; break;
    case 'commute': delete query.maxCommuteMins; delete query.commuteTo; break;
    case 'minBeds': delete query.minBeds; break;
    case 'maxPrice': delete query.maxPrice; break;
    case 'minYield': delete query.minYield; break;
    case 'minRefurbProfit': delete query.minRefurbProfit; break;
    case 'maxBeds': extras.maxBeds = null; break;
    case 'minPrice': extras.minPrice = null; break;
    case 'must': extras.mustHaves = extras.mustHaves.filter((m) => m.toLowerCase() !== v); break;
    default: if ((FLAG_FIELDS as readonly string[]).includes(k)) delete query[k as FlagField];
  }
  return { query, extras };
}

/** Apply removed chips (in order) to an intent result. */
export function withoutChips(r: Pick<IntentResult, 'query' | 'extras'>, keys: string[]) {
  return keys.reduce((s, k) => withoutChip(s, k), { query: r.query, extras: r.extras });
}

/** The built-in rule-based reading of a search (used when AI is off or fails). */
export function fromRules(text: string, mode?: SearchMode | null): IntentResult {
  const query = applyMode(parseQuery(text), mode);
  if (query.maxPrice != null && !Number.isFinite(query.maxPrice)) delete query.maxPrice;
  if (query.minRefurbProfit != null && !Number.isFinite(query.minRefurbProfit)) delete query.minRefurbProfit;
  const extras = rulesExtras(text, query);
  return {
    q: text, query, extras, understood: chipsFor(query, extras), clarify: null,
    unsupported: shortUnsupported(query.unsupported), policyNote: asksForDemographics(text) ? POLICY_NOTE : null, source: 'rules',
  };
}

/**
 * Applies the extras the engine can't filter on: price floor and bedroom ceiling (hard filters),
 * and "must haves" as a visible reason when the listing mentions them (never a guess).
 */
export function applyExtras(hits: SearchHit[], extras: SearchExtras): SearchHit[] {
  const musts = extras.mustHaves.map((m) => m.toLowerCase()).filter(Boolean);
  return hits
    .filter((h) => (extras.minPrice == null || h.property.price >= extras.minPrice) && (extras.maxBeds == null || h.property.beds <= extras.maxBeds))
    .map((h) => {
      if (!musts.length) return h;
      const text = `${h.property.features.join(' ')} ${h.property.description ?? ''} ${h.property.title}`.toLowerCase();
      const found = musts.filter((m) => text.includes(m));
      return found.length ? { ...h, reasons: [`Mentions ${found.join(', ')}`, ...h.reasons] } : h;
    });
}

/* ───────────────────────── similar homes ───────────────────────── */

export const channelOf = (p: Pick<Property, 'listing'>) => (p.listing === 'rent' ? 'rent' : 'sale');
const area = (p: Property) => p.town.split(',')[0].trim();
const city = (p: Property) => p.town.split(',').pop()!.trim();
export const isPublic = (p: Property) => p.visibility !== 'private' && p.status !== 'withdrawn' && p.status !== 'pending';
const tags = (p: Property) => {
  const t = `${p.features.join(' ')} ${p.description ?? ''}`.toLowerCase();
  return new Set(['garden', 'parking', 'garage', 'balcony', 'driveway', 'period', 'loft', 'chain'].filter((w) => t.includes(w)));
};

/** Hard constraints for "similar": same channel (sale/rent), commercial with commercial, price within ±35%, beds ±1. */
export function similarOk(target: Property, c: Property) {
  return c.id !== target.id && channelOf(c) === channelOf(target) && (c.type === 'commercial') === (target.type === 'commercial')
    && Math.abs(c.price - target.price) <= 0.35 * target.price && Math.abs(c.beds - target.beds) <= 1;
}

/** 0–1 structural closeness: place, price, size, type and shared features. */
export function structuralSimilarity(target: Property, c: Property) {
  let s = 0;
  if (c.district === target.district) s += 0.35; else if (area(c) === area(target)) s += 0.25; else if (city(c) === city(target)) s += 0.15;
  s += 0.25 * (1 - Math.min(1, Math.abs(c.price - target.price) / (0.35 * target.price || 1)));
  s += c.beds === target.beds ? 0.15 : 0.05;
  if (c.type === target.type) s += 0.15; else if (HOUSES.includes(c.type) && HOUSES.includes(target.type)) s += 0.08;
  const a = tags(target); const b = tags(c);
  const union = new Set([...a, ...b]).size;
  if (union) s += 0.1 * ([...a].filter((x) => b.has(x)).length / union);
  return Math.min(1, Math.round(s * 1000) / 1000);
}

const typeWord = (t: Property['type']) => (t === 'flat' ? 'flat' : t === 'bungalow' ? 'bungalow' : t === 'commercial' ? 'commercial space' : `${t} house`);

/** "Also in E17 · £20k cheaper · one more bedroom": built from the facts, free and instant. */
export function similarReason(target: Property, c: Property): string {
  const parts: string[] = [];
  if (c.district === target.district) parts.push(`Also in ${c.district}`);
  else if (area(c) === area(target)) parts.push(`Also in ${area(c)}`);
  else parts.push(`In ${area(c)}`);
  const rent = channelOf(target) === 'rent';
  const d = c.price - target.price;
  if (Math.abs(d) < 0.03 * target.price) parts.push('similar price');
  else parts.push(`${rent ? gbp(Math.abs(d)) : gbpShort(d)}${rent ? ' pcm' : ''} ${d < 0 ? (rent ? 'less' : 'cheaper') : 'more'}`);
  if (c.beds !== target.beds) {
    const n = Math.abs(c.beds - target.beds);
    parts.push(`${n === 1 ? 'one' : n} ${c.beds > target.beds ? 'more' : 'fewer'} bedroom${n === 1 ? '' : 's'}`);
  } else if (c.type !== target.type) parts.push(`${c.beds ? `${c.beds}-bed ` : ''}${typeWord(c.type)}`);
  else parts.push(c.beds ? `also ${c.beds} beds` : `also a ${typeWord(c.type)}`);
  const shared = [...tags(target)].filter((x) => tags(c).has(x) && ['garden', 'parking', 'balcony', 'garage'].includes(x));
  if (shared.length && parts.length < 4) parts.push(`${shared[0]} too`);
  return cap(parts.join(' · '));
}

export function toSimilarItem(p: Property, reason: string, score: number, photo: string | null = p.photos?.[0] ?? null): SimilarItem {
  return { id: p.id, title: p.title, listing: p.listing, price: p.price, beds: p.beds, type: p.type, town: p.town, district: p.district, photo, photoHue: p.photoHue, reason, score: Math.round(score * 1000) / 1000 };
}

/** Rule-based similar homes (website fallback; the server blends this with embeddings). */
export function ruleSimilar(target: Property, pool: Property[], limit = 6): SimilarItem[] {
  return pool.filter((p) => isPublic(p) && similarOk(target, p))
    .map((p) => ({ p, s: structuralSimilarity(target, p) }))
    .sort((a, b) => b.s - a.s || Math.abs(a.p.price - target.price) - Math.abs(b.p.price - target.price))
    .slice(0, limit)
    .map(({ p, s }) => toSimilarItem(p, similarReason(target, p), s));
}
