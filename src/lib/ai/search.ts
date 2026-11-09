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
import { bedroomRange, parseQuery, type SearchHit, type SearchQuery } from '../../engine/search';
import type { Property } from '../../data/properties';

/* ───────────────────────── API shapes ───────────────────────── */

/** The search box modes (SmartSearch tabs). */
export const SEARCH_MODES = ['buy', 'rent', 'sold', 'commercial', 'invest'] as const;
export type SearchMode = typeof SEARCH_MODES[number];

/** Things people asked for that the engine can't filter on yet; the website applies the numeric ones itself. */
export interface SearchExtras { minPrice: number | null; maxBeds: number | null; mustHaves: string[] }

/**
 * One "understood" chip. `key` identifies the constraint, so removing the chip removes exactly that constraint.
 * `kind: 'preference'` marks a must-have that only puts listings mentioning it first (it never filters).
 */
export interface SearchChip { key: string; label: string; removable: boolean; kind?: 'filter' | 'preference' }

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
/** What a saved search keeps besides its text: the filters the person saw (after removing chips and setting page filters). */
export interface SavedSearchFilters { query: SearchQuery; extras: SearchExtras }

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
/**
 * Words for groups of people by a protected characteristic (race, ethnicity, nationality,
 * religion, sexual orientation, gender reassignment, age, disability).
 * STRONG words rarely describe a home, so model-written text containing them is never echoed back.
 * SOFT words also describe homes ("white kitchen", "old windows", "disabled access"), so they
 * only count when they describe people ("white residents", "young families").
 */
const GROUPS_STRONG = [
  'asians?', 'polish', 'indians?', 'pakistanis?', 'bangladeshis?', 'somalis?', 'nigerians?', 'ghanaians?', 'eritreans?', 'ethiopians?', 'kenyans?',
  'africans?', 'caribbeans?', 'jamaicans?', 'chinese', 'koreans?', 'vietnamese', 'filipinos?', 'arabs?', 'turkish', 'turks', 'kurdish', 'kurds',
  'iranians?', 'afghans?', 'syrians?', 'iraqis?', 'romanians?', 'bulgarians?', 'lithuanians?', 'latvians?', 'slovaks?', 'hungarians?', 'albanians?',
  'ukrainians?', 'portuguese', 'brazilians?', 'gypsy', 'gypsies', 'roma', 'jews', 'jewish', 'muslims?', 'islamic', 'christians?', 'hindus?', 'sikhs?',
  'catholics?', 'protestants?', 'buddhists?', 'mormons?', 'immigrants?', 'migrants?', 'foreigners?', 'refugees?', 'asylum seekers?',
  'lgbt\\w*', 'gays?', 'lesbians?', 'queer', 'bisexuals?', 'transgender', 'elderly', 'pensioners?', 'retirees?',
  'punjabis?', 'tamils?', 'gujaratis?', 'bengalis?', 'sylhetis?', 'kashmiris?', 'sinhalese', 'greeks?', 'cypriots?', 'hasidic', 'hasidim', 'haredi', 'charedi',
  'zimbabweans?', 'congolese', 'sudanese', 'yemenis?', 'moroccans?', 'algerians?', 'egyptians?', 'lebanese', 'palestinians?', 'israelis?',
  'latinos?', 'latinas?', 'latinx', 'hispanics?', 'west indians?', 'afro[- ]caribbeans?', 'bame', 'bme', 'people of colou?r', 'mixed[- ]race',
  'atheists?', 'pagans?', 'rastafarians?', 'expats?', 'russians', 'germans', 'italians', 'spaniards?', 'americans', 'muslim', 'hindu',
];
const GROUPS_SOFT = [
  'black', 'white', 'brown', 'english', 'british', 'irish', 'scottish', 'welsh', 'european', 'eastern european', 'japanese', 'russian', 'foreign',
  'travellers?', 'trans', 'straight', 'religious', 'secular', 'diverse', 'multicultural', 'minority', 'ethnic',
  'italian', 'french', 'spanish', 'german', 'american', 'australian', 'orthodox', 'mixed',
];
/** Age and disability words: only about people ("young families", "disabled residents"), never "my old neighbourhood". */
const GROUPS_PERSONAL = ['old', 'older', 'young', 'younger', 'retired', 'disabled'];
const STRONG = `(?:${GROUPS_STRONG.join('|')})`;
const SOFT = `(?:${GROUPS_SOFT.join('|')})`;
const GROUP = `(?:${[...GROUPS_STRONG, ...GROUPS_SOFT].join('|')})`;
const PERSONS = 'people|persons|folk|families|households?|residents|neighbou?rs|crowd|couples|speakers';
const PLACES = 'areas?|community|communities|neighbou?rhoods?|enclaves?|majority|minority|population';
/** Home finishes that soft group words also describe ("mostly white walls", "no white goods"). */
const HOME_FINISH = '(?:kitchens?|walls?|interiors?|d[ée]cor|finish(?:es)?|units?|tiles?|bathrooms?|paint\\w*|woodwork|windows?|doors?|render\\w*|brick\\w*|goods|appliances|marble|stone|oak|floors?|carpets?|worktops?)';
/** Places of worship that only ever come up as "who lives near here" (never echoed, never a filter). */
const WORSHIP = '(?:mosques?|synagogues?|gurdwaras?|mandirs?|shuls?|madrass?as?|yeshivas?)';
/** Places of worship that also name buildings or stations ("converted church", "Temple Meads"): only near / close to … counts. */
const WORSHIP_NEAR = new RegExp(`\\b(?:near(?:by)?|close to|next (?:door )?to|walk(?:ing)?(?: distance)? (?:to|of|from)|minutes? (?:from|to|of)|by|opposite|around|within reach of)\\s+(?:(?:an?|the|my|our|local|good|catholic|anglican|baptist|methodist|evangelical|pentecostal|hindu|buddhist|sikh|jewish|christian|orthodox|parish)\\s+)*(?:churche?s?|chapels?|cathedrals?|temples?(?!\\s+(?:meads|fortune|station|newsam|cowley))|meeting houses?|kingdom halls?)\\b`, 'i');
/** Requests to pick areas by the people who live there (protected characteristics). Never turned into filters. */
const DEMOGRAPHIC_RES = [
  /\b(ethnic(ity|ities|ally)?|racial(ly)?|race of|demographics?|diversity)\b/i,
  new RegExp(`\\b${GROUP}\\s+(?:${PERSONS}|${PLACES})\\b`, 'i'),
  new RegExp(`\\b(?:${GROUPS_PERSONAL.join('|')})\\s+(?:${PERSONS})\\b`, 'i'),
  new RegExp(`\\b${STRONG}[- ]friendly\\b`, 'i'),
  new RegExp(`\\b(?:mostly|mainly|predominantly|majority|full of|lots of|area with|neighbou?rhood with|community of|no|fewer|without|avoid|away from|free of)\\s+${STRONG}\\b`, 'i'),
  // "mostly white", "predominantly British" (but not "mostly white walls").
  new RegExp(`\\b(?:mostly|mainly|predominantly|largely|overwhelmingly|majority)\\s+${SOFT}\\b(?!\\s+${HOME_FINISH})`, 'i'),
  // "white British", "black African", "British Asian".
  /\b(?:white|black|brown|mixed)[- ](?:british|english|irish|scottish|welsh|european|african|caribbean|asian|other|americans?)\b/i,
  /\bbritish[- ](?:asians?|indians?|pakistanis?|bangladeshis?|chinese|africans?|caribbeans?|muslims?|jews|jewish|sikhs?|hindus?)\b/i,
  // "English-speaking neighbours", "Polish speakers".
  new RegExp(`\\b${GROUP}[- ]speak(?:ing|ers?)\\b`, 'i'),
  new RegExp(`\\b${WORSHIP}\\b`, 'i'),
  WORSHIP_NEAR,
];
/**
 * "<word> community / population / enclave" is about who lives somewhere unless the word describes the
 * place or its feel ("gated community", "close-knit community", "large student population").
 */
const COMMUNITY_RE = /\b([a-z][a-z'’-]*)\s+(?:community|communities|populations?|enclaves?|ghettos?)\b/gi;
const COMMUNITY_OK = new Set([
  'a', 'an', 'the', 'of', 'and', 'with', 'in', 'into', 'our', 'my', 'your', 'local', 'whole', 'entire', 'total',
  'gated', 'retirement', 'village', 'rural', 'farming', 'coastal', 'seaside', 'residential', 'housing', 'co-housing', 'cohousing', 'eco', 'garden', 'golf',
  'lakeside', 'riverside', 'waterside', 'country', 'island', 'sustainable', 'green', 'planned', 'new', 'growing', 'established',
  'friendly', 'family-friendly', 'dog-friendly', 'close-knit', 'tight-knit', 'strong', 'quiet', 'lovely', 'nice', 'vibrant', 'thriving', 'lively', 'active',
  'welcoming', 'good', 'great', 'safe', 'real', 'proper', 'small', 'big', 'large', 'creative', 'artistic', 'arts', 'artist', 'artists', 'online',
  'low', 'high', 'dense', 'sparse', 'student', 'students', 'university', 'commuter', 'professional', 'working', 'family', 'families', 'business',
]);
function communityOfPeople(text: string) {
  for (const m of text.matchAll(COMMUNITY_RE)) if (!COMMUNITY_OK.has(m[1].toLowerCase().replace(/’/g, "'"))) return true;
  return false;
}
export const asksForDemographics = (text: string) => DEMOGRAPHIC_RES.some((re) => re.test(text)) || communityOfPeople(text);
/** Model-written words about who lives somewhere: never shown as a filter, chip, follow-up or "unsupported" item. */
export const PROTECTED_RE = new RegExp(`(ethnic|\\brace\\b|racial|relig|nationalit|immigra|foreign|demograph|age profile|sexual|\\b${STRONG}\\b|\\b${WORSHIP}\\b)`, 'i');
export const mentionsProtected = (text: string) => PROTECTED_RE.test(text) || asksForDemographics(text);

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
  const beds = bedroomRange(text);
  if (beds.max) ex.maxBeds = beds.max;
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
  for (const m of extras.mustHaves) out.push({ key: `must:${m.toLowerCase()}`, label: cap(m), removable: true, kind: 'preference' });
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
  // The parser reads "up to 4 beds" as a £4 budget: anything below a plausible price is not a budget.
  if (query.maxPrice != null && (!Number.isFinite(query.maxPrice) || query.maxPrice < (query.intent === 'rent' ? 50 : 5_000))) delete query.maxPrice;
  if (query.minRefurbProfit != null && !Number.isFinite(query.minRefurbProfit)) delete query.minRefurbProfit;
  const extras = rulesExtras(text, query);
  return {
    q: text, query, extras, understood: chipsFor(query, extras), clarify: null,
    unsupported: shortUnsupported(query.unsupported), policyNote: asksForDemographics(text) ? POLICY_NOTE : null, source: 'rules',
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The must-haves a listing's own text mentions ("balcony" also matches "balconies"). Never a guess. */
export function mustHavesIn(p: Pick<Property, 'features' | 'description' | 'title'>, mustHaves: string[]): string[] {
  const text = `${p.features.join(' ')} ${p.description ?? ''} ${p.title}`.toLowerCase();
  return mustHaves.map((m) => m.toLowerCase()).filter((m) => {
    if (!m) return false;
    const forms = [escapeRe(m), ...(m.endsWith('y') ? [`${escapeRe(m.slice(0, -1))}ies`] : [])];
    return new RegExp(`(^|[^a-z0-9])(?:${forms.join('|')})(?:s|es)?(?![a-z0-9])`).test(text);
  });
}

/**
 * Applies the extras the engine can't filter on: price floor and bedroom ceiling (hard filters),
 * and "must haves" as preferences: listings whose own text mentions more of them come first
 * (otherwise in the same order), with a visible "Mentions …" reason. They never hide a listing.
 */
export function applyExtras(hits: SearchHit[], extras: SearchExtras): SearchHit[] {
  const musts = extras.mustHaves.map((m) => m.toLowerCase()).filter(Boolean);
  const kept = hits.filter((h) => (extras.minPrice == null || h.property.price >= extras.minPrice) && (extras.maxBeds == null || h.property.beds <= extras.maxBeds));
  if (!musts.length) return kept;
  return kept
    .map((h, i) => {
      const found = mustHavesIn(h.property, musts);
      return { h: found.length ? { ...h, reasons: [`Mentions ${found.join(', ')}`, ...h.reasons] } : h, n: found.length, i };
    })
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.h);
}

/**
 * The words AI relevance ranking embeds: the chips still in force (place, type, size, features)
 * and the preferences. Built from the validated reading, never the raw text, so removed chips and
 * anything about who lives somewhere can't affect the order. Prices and the intent are left out
 * (the results already meet them; numbers don't help a meaning match).
 */
export function rankText(chips: SearchChip[]): string {
  return chips.filter((c) => !['intent', 'minPrice', 'maxPrice'].includes(c.key)).map((c) => c.label).join(', ').slice(0, MAX_QUERY_CHARS);
}

/** What a saved search keeps for its alerts (the engine query without the "not covered" notes). */
export function savedFilters(query: SearchQuery, extras: SearchExtras): SavedSearchFilters {
  return { query: { ...copyQuery(query), unsupported: [] }, extras: { minPrice: extras.minPrice, maxBeds: extras.maxBeds, mustHaves: [...extras.mustHaves] } };
}

/* ───────────────────────── similar homes ───────────────────────── */

export const channelOf = (p: Pick<Property, 'listing'>) => (p.listing === 'rent' ? 'rent' : 'sale');
const area = (p: Pick<Property, 'town'>) => p.town.split(',')[0].trim();
const city = (p: Pick<Property, 'town'>) => p.town.split(',').pop()!.trim();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Same postcode district, area or city as the home being viewed. */
export const isLocal = (target: Pick<Property, 'town' | 'district'>, c: Pick<Property, 'town' | 'district'>) =>
  same(c.district, target.district) || same(area(c), area(target)) || same(city(c), city(target));
/** "Ecclesall, Sheffield" for a home in another city than the one being viewed; just the area otherwise. */
export const placeLabel = (target: Pick<Property, 'town' | 'district'>, c: Pick<Property, 'town' | 'district'>) => (isLocal(target, c) ? area(c) : c.town);
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

/**
 * Candidates for "similar": the hard limits, and homes in the same district, area or city. Other cities
 * are only considered when fewer than 3 local homes qualify (their cards and reasons then say where they are).
 */
export function similarCandidates(target: Property, pool: Property[]): Property[] {
  const ok = pool.filter((p) => isPublic(p) && similarOk(target, p));
  const local = ok.filter((p) => isLocal(target, p));
  return local.length >= 3 ? local : ok;
}

/** 0–1 structural closeness: place, price, size, type and shared features. */
export function structuralSimilarity(target: Property, c: Property) {
  let s = 0;
  if (same(c.district, target.district)) s += 0.35; else if (same(area(c), area(target))) s += 0.25; else if (same(city(c), city(target))) s += 0.15;
  s += 0.25 * (1 - Math.min(1, Math.abs(c.price - target.price) / (0.35 * target.price || 1)));
  s += c.beds === target.beds ? 0.15 : 0.05;
  if (c.type === target.type) s += 0.15; else if (HOUSES.includes(c.type) && HOUSES.includes(target.type)) s += 0.08;
  const a = tags(target); const b = tags(c);
  const union = new Set([...a, ...b]).size;
  if (union) s += 0.1 * ([...a].filter((x) => b.has(x)).length / union);
  return Math.min(1, Math.round(s * 1000) / 1000);
}

const typeNoun: Record<Property['type'], string> = { terraced: 'a terrace', 'semi-detached': 'a semi', detached: 'a detached house', flat: 'a flat', bungalow: 'a bungalow', commercial: 'commercial space' };

/**
 * "Also in E17 · £20k cheaper · one more bedroom" (or "In Sheffield · …" for another city): how a home
 * differs from the one being viewed, built from the facts (the card already shows its type and size). Free and instant.
 */
export function similarReason(target: Property, c: Property): string {
  const parts: string[] = [];
  if (same(c.district, target.district)) parts.push(`Also in ${c.district}`);
  else if (same(area(c), area(target))) parts.push(`Also in ${area(c)}`);
  else if (same(city(c), city(target))) parts.push(`Also in ${city(c)}`);
  else parts.push(`In ${city(c)}`);
  const rent = channelOf(target) === 'rent';
  const d = c.price - target.price;
  if (Math.abs(d) < 0.03 * target.price) parts.push('similar price');
  else parts.push(`${rent ? gbp(Math.abs(d)) : gbpShort(d)}${rent ? ' pcm' : ''} ${d < 0 ? (rent ? 'less' : 'cheaper') : 'more'}`);
  if (c.beds !== target.beds) {
    const n = Math.abs(c.beds - target.beds);
    parts.push(`${n === 1 ? 'one' : n} ${c.beds > target.beds ? 'more' : 'fewer'} bedroom${n === 1 ? '' : 's'}`);
  } else if (c.type !== target.type) parts.push(`${typeNoun[c.type]} rather than ${typeNoun[target.type]}`);
  else if (c.beds) parts.push(`also a ${c.beds}-bed ${typeNoun[c.type].replace(/^an? /, '')}`);
  const shared = [...tags(target)].filter((x) => tags(c).has(x) && ['garden', 'parking', 'balcony', 'garage'].includes(x));
  if (shared.length && parts.length < 4) parts.push(`${shared[0]} too`);
  return cap(parts.join(' · '));
}

export function toSimilarItem(p: Property, reason: string, score: number, photo: string | null = p.photos?.[0] ?? null): SimilarItem {
  return { id: p.id, title: p.title, listing: p.listing, price: p.price, beds: p.beds, type: p.type, town: p.town, district: p.district, photo, photoHue: p.photoHue, reason, score: Math.round(score * 1000) / 1000 };
}

/** Rule-based similar homes (website fallback; the server blends this with embeddings). */
export function ruleSimilar(target: Property, pool: Property[], limit = 6): SimilarItem[] {
  return similarCandidates(target, pool)
    .map((p) => ({ p, s: structuralSimilarity(target, p) }))
    .sort((a, b) => b.s - a.s || Math.abs(a.p.price - target.price) - Math.abs(b.p.price - target.price))
    .slice(0, limit)
    .map(({ p, s }) => toSimilarItem(p, similarReason(target, p), s));
}
