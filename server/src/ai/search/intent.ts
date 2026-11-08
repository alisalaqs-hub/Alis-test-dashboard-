/**
 * Natural-language search → the engine's SearchQuery.
 *
 * The model ONLY translates words into fields (role 'fast', strict JSON schema). Everything it
 * returns is validated here: numbers are clamped to sane ranges, postcode districts must look
 * like outward codes and appear in what the person typed, places must be mentioned (or be a
 * known Streetkey place the person's neighbourhood belongs to), free text is length-limited and
 * stripped of links. The result is merged with the built-in parser as a safety net, cached for
 * 24h per normalised query, and falls back to the built-in parser if the model fails.
 */
import { createHash } from 'node:crypto';
import { parseQuery, type SearchQuery } from '../../../../src/engine/search';
import { PROPERTIES } from '../../../../src/data/properties';
import {
  applyMode, asksForDemographics, chipsFor, DISTRICT_RE, FLAG_FIELDS, fromRules, normaliseQuery, POLICY_NOTE, PROPERTY_TYPES, shortUnsupported,
  type Clarify, type FlagField, type IntentResult, type SearchExtras, type SearchMode,
} from '../../../../src/lib/ai/search';
import { AiError, cached, chatJSON, HOUSE_RULES, untrusted } from '../core';
import { S, type Infer } from '../schema';

const CHIP_FIELDS = ['intent', 'minBeds', 'maxBeds', 'minPrice', 'maxPrice', 'locations', 'districts', 'commute', 'types', ...FLAG_FIELDS, 'minYield', 'minRefurbProfit', 'mustHaves'] as const;

export const IntentSchema = S.obj({
  intent: S.enum(['buy', 'rent', 'invest'] as const),
  minBeds: S.nullable(S.int()),
  maxBeds: S.nullable(S.int()),
  minPrice: S.nullable(S.num('Whole pounds; monthly rent when renting')),
  maxPrice: S.nullable(S.num('Whole pounds; monthly rent when renting')),
  locations: S.arr(S.str('Town, city or neighbourhood')),
  districts: S.arr(S.str('UK postcode district the person typed, e.g. E17')),
  maxCommuteMins: S.nullable(S.int()),
  commuteTo: S.nullable(S.str('Commute destination, e.g. central london')),
  types: S.arr(S.enum(PROPERTY_TYPES)),
  flags: S.arr(S.enum(FLAG_FIELDS)),
  minYieldPercent: S.nullable(S.num('Minimum gross yield in percent, e.g. 7 for 7%')),
  minRefurbProfit: S.nullable(S.num('Target refurbishment profit in pounds')),
  mustHaves: S.arr(S.str()),
  unsupported: S.arr(S.str()),
  understood: S.arr(S.obj({ field: S.enum(CHIP_FIELDS), label: S.str() })),
  clarifyingQuestion: S.nullable(S.obj({ question: S.str(), answers: S.arr(S.str()) })),
  demographicRequest: S.bool(),
});
export type ModelIntent = Infer<typeof IntentSchema>;

/** Bump to invalidate cached readings when the prompt or validation changes. */
const VERSION = 'v1';
const TTL = 24 * 3600;

/** Place names the engine can match (demo + live listings' towns and the parser's aliases). */
export function knownPlaces(): string[] {
  const set = new Set<string>();
  for (const p of PROPERTIES) {
    if (p.visibility === 'private') continue;
    for (const part of p.town.split(',')) { const s = part.trim(); if (s && s.length <= 40) set.add(s); }
  }
  for (const a of ['London', 'Manchester', 'Leeds', 'Bristol', 'Birmingham', 'Liverpool', 'Sheffield', 'Cardiff', 'Glasgow', 'Nottingham', 'Hertfordshire']) set.add(a);
  return [...set].sort().slice(0, 80);
}

const SYSTEM = (places: string[]) => [
  HOUSE_RULES,
  '',
  'Task: turn one property search, written by a person, into structured filters for Streetkey’s search engine. Only translate their words: never add requirements, places, prices or numbers they did not give or clearly imply.',
  'Fields:',
  '- intent: "rent" for renting (to rent, to let, pcm, tenant); "invest" for buy-to-let, yield, HMO, flips, BRRR, portfolio or profit; otherwise "buy".',
  '- minBeds / maxBeds: bedroom counts ("3 bed" → minBeds 3; "2 to 3 beds" → 2 and 3). Null if not stated.',
  '- minPrice / maxPrice: whole pounds ("under £450k" → maxPrice 450000). Monthly rent when renting. Null if not stated.',
  '- locations: places they mentioned, spelled like KNOWN PLACES where one matches. If they name a neighbourhood that isn’t listed, you may also add the listed city it is in, when certain. Never add places they didn’t mention.',
  '- districts: UK postcode districts they actually typed (E17, M14, LS6). Never work them out from place names.',
  '- maxCommuteMins + commuteTo: "within 45 minutes of central London" → 45 and "central london".',
  '- types: property types asked for. "house" means terraced, semi-detached and detached.',
  '- flags (only when clearly asked for): wantsLoft (loft conversion potential), wantsExtension, wantsGarden, hmo, auction, chainFree, goodSchools, conversion (split into flats), lowServiceCharge, needsRefurb (needs work / renovation project), goodReturn (good investment return), rentalDemand, commercial (offices, retail, industrial).',
  '- minYieldPercent: "7% yield" → 7. minRefurbProfit: target profit or uplift in pounds.',
  '- mustHaves: up to 5 other concrete home features a listing description could mention (e.g. "parking", "balcony", "open-plan kitchen"), 1–3 words each.',
  '- unsupported: up to 5 things they asked for that need data Streetkey doesn’t have (e.g. "crime rates", "broadband speed", "noise levels", "pets allowed", "new builds"), as short noun phrases.',
  '- understood: one chip per constraint you set: the field and a label of at most 4 words with no numbers (e.g. {"field":"wantsGarden","label":"Garden"}).',
  '- clarifyingQuestion: only when one answer would change the results a lot (e.g. buying or renting is unclear). A short question and up to 3 short answers the person can tap, written as phrases to add to their search ("to rent", "in Manchester"). Otherwise null.',
  '- demographicRequest: true if they asked to choose areas by the people who live there (ethnicity, religion, nationality, age, disability, sexuality or similar). Never turn that into filters, places or unsupported items.',
  `KNOWN PLACES: ${places.join(', ')}`,
].join('\n');

/* ───────────────────────── validation ───────────────────────── */

const LINKY = /(https?:|www\.|\.(com|co\.uk|org|net|io)\b|<|>|\[|\]|\{|\}|`)/i;
/** Words about who lives somewhere: never echoed back as filters, chips or "unsupported" items. */
const PROTECTED = /(ethnic|\brace\b|racial|relig|muslim|christian|jewish|hindu|sikh|nationalit|immigra|foreign|demograph|age profile|elderly|disab|sexual|\bgay\b|lgbt)/i;
/** Short, link-free, printable text (labels, answers, phrases) or null. */
function phrase(s: unknown, max: number): string | null {
  if (typeof s !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > max || LINKY.test(t)) return null;
  return t;
}
const clampInt = (v: number | null, lo: number, hi: number) => (v == null || !Number.isFinite(v) ? undefined : Math.min(hi, Math.max(lo, Math.round(v))));
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' -]/g, ' ').replace(/\s+/g, ' ').trim();
const mentions = (text: string, phraseText: string) => ` ${words(text)} `.includes(` ${words(phraseText)} `);

/** Model output → validated engine query + extras + chips. Pure (no I/O), so tests can call it directly. */
export function validateIntent(m: ModelIntent, text: string, mode: SearchMode | null, places: string[]): IntentResult {
  const rules = parseQuery(text);
  const q: SearchQuery = { intent: m.intent, locations: [], districts: [], types: [], unsupported: [...rules.unsupported] };

  // Bedrooms
  const minBeds = m.minBeds != null && m.minBeds > 0 ? clampInt(m.minBeds, 1, 10) : undefined;
  let maxBeds = m.maxBeds != null && m.maxBeds > 0 ? clampInt(m.maxBeds, 1, 15) ?? null : null;
  if (minBeds && maxBeds != null && maxBeds < minBeds) maxBeds = null;
  if (minBeds) q.minBeds = minBeds;

  // Prices: plausible ranges for rent (pcm) or purchase; tiny values are unit mistakes, so dropped.
  const rent = (mode === 'rent' ? 'rent' : m.intent) === 'rent';
  const [lo, hi] = rent ? [50, 50_000] : [5_000, 100_000_000];
  const price = (v: number | null) => (v == null || !Number.isFinite(v) || v < lo ? undefined : Math.min(hi, Math.round(v)));
  const maxPrice = price(m.maxPrice);
  let minPrice = price(m.minPrice) ?? null;
  if (maxPrice) q.maxPrice = maxPrice;
  if (minPrice != null && maxPrice != null && minPrice >= maxPrice) minPrice = null;

  // Places: canonical spellings; grounded in what was typed.
  const known = new Map(places.map((p) => [p.toLowerCase(), p]));
  const STOP = new Set(['uk', 'united kingdom', 'england', 'britain', 'great britain', 'anywhere', 'everywhere', 'nearby', 'near me', 'local', 'city centre', 'town centre', 'countryside', 'the city', 'the countryside']);
  const proposed = m.locations.map((l) => phrase(l, 40)).filter((l): l is string => !!l && /^[\p{L}][\p{L} .'’-]*$/u.test(l) && !STOP.has(l.toLowerCase())).slice(0, 6);
  const anyMentioned = proposed.some((l) => mentions(text, l));
  for (const l of proposed) {
    const aliases = parseQuery(l).locations;
    const canonical = aliases.length ? aliases : [known.get(l.toLowerCase()) ?? l.replace(/(^|[\s'’-])(\p{Ll})/gu, (_, a: string, c: string) => a + c.toUpperCase())];
    for (const c of canonical) {
      const grounded = mentions(text, l) || rules.locations.includes(c) || (anyMentioned && known.has(c.toLowerCase()));
      if (grounded && !q.locations.includes(c)) q.locations.push(c);
    }
  }

  // Postcode districts: must look like an outward code and be typed by the person.
  for (const d of m.districts) {
    const code = String(d).toUpperCase().replace(/\s+/g, '');
    if (!DISTRICT_RE.test(code) || q.districts.includes(code)) continue;
    if (new RegExp(`(^|[^A-Z0-9])${code}(\\s?\\d[A-Z]{2})?([^A-Z0-9]|$)`).test(text.toUpperCase())) q.districts.push(code);
    if (q.districts.length >= 8) break;
  }

  // Commute
  const mins = m.maxCommuteMins != null && m.maxCommuteMins > 0 ? clampInt(m.maxCommuteMins, 5, 180) : undefined;
  if (mins) {
    q.maxCommuteMins = mins;
    const to = phrase(m.commuteTo, 40)?.toLowerCase();
    if (to && /^[a-z][a-z .'’-]*$/.test(to)) q.commuteTo = to;
    else if (rules.commuteTo) q.commuteTo = rules.commuteTo;
  }

  // Types and flags
  for (const t of m.types) if (!q.types.includes(t)) q.types.push(t);
  for (const f of m.flags) q[f as FlagField] = true;
  if (q.types.includes('commercial')) q.commercial = true;
  if (q.commercial) q.types = [];

  // Investment targets
  if (m.minYieldPercent != null && Number.isFinite(m.minYieldPercent) && m.minYieldPercent > 0) {
    const pctValue = m.minYieldPercent <= 1 ? m.minYieldPercent * 100 : m.minYieldPercent;
    if (pctValue <= 30) q.minYield = Math.min(25, Math.max(1, pctValue)) / 100;
  }
  if (m.minRefurbProfit != null && Number.isFinite(m.minRefurbProfit) && m.minRefurbProfit >= 1_000) q.minRefurbProfit = Math.min(5_000_000, Math.round(m.minRefurbProfit));

  // Safety net: keep what the built-in parser found when the model left it out.
  if (q.maxPrice == null && rules.maxPrice != null && Number.isFinite(rules.maxPrice) && rules.maxPrice >= lo) q.maxPrice = Math.min(hi, rules.maxPrice);
  if (q.minBeds == null && rules.minBeds) q.minBeds = rules.minBeds;
  if (!q.locations.length && rules.locations.length) q.locations = [...rules.locations];
  if (!q.districts.length && rules.districts.length) q.districts = [...rules.districts];
  if (!q.types.length && rules.types.length && !q.commercial) q.types = [...rules.types];
  if (q.maxCommuteMins == null && rules.maxCommuteMins) { q.maxCommuteMins = rules.maxCommuteMins; q.commuteTo = rules.commuteTo; }
  if (q.minYield == null && rules.minYield && Number.isFinite(rules.minYield)) q.minYield = rules.minYield;
  if (q.minRefurbProfit == null && rules.minRefurbProfit && Number.isFinite(rules.minRefurbProfit)) q.minRefurbProfit = rules.minRefurbProfit;
  if (minPrice != null && q.maxPrice != null && minPrice >= q.maxPrice) minPrice = null;

  const query = applyMode(q, mode);
  const extras: SearchExtras = {
    minPrice, maxBeds,
    mustHaves: [...new Set(m.mustHaves.map((x) => phrase(x, 30)?.toLowerCase()).filter((x): x is string => !!x && /^[a-z][a-z0-9 '-]*$/.test(x) && !PROTECTED.test(x)))].slice(0, 5),
  };

  // Chip labels: the model's words for yes/no constraints (no digits allowed); numbers always from the query.
  const aiLabels: Partial<Record<string, string>> = {};
  for (const u of m.understood) {
    if (!(FLAG_FIELDS as readonly string[]).includes(u.field) && u.field !== 'intent') continue;
    const label = phrase(u.label, 32);
    if (label && !/[\d£$%€]/.test(label) && !PROTECTED.test(label)) aiLabels[u.field] = label[0].toUpperCase() + label.slice(1);
  }

  const demographic = m.demographicRequest || asksForDemographics(text);
  const unsupported = demographic ? shortUnsupported(rules.unsupported) : [...new Set([
    ...m.unsupported.map((u) => phrase(u, 48)).filter((u): u is string => !!u && !/[\d£%]/.test(u) && !PROTECTED.test(u)).map((u) => u.toLowerCase()),
    ...shortUnsupported(rules.unsupported),
  ])].slice(0, 5);

  let clarify: Clarify | null = null;
  const question = phrase(m.clarifyingQuestion?.question, 140);
  if (question && !demographic && !PROTECTED.test(question)) {
    const answers = [...new Set((m.clarifyingQuestion?.answers ?? []).map((a) => phrase(a, 40)).filter((a): a is string => !!a && !PROTECTED.test(a)))].slice(0, 3);
    clarify = { question: question.endsWith('?') ? question : `${question}?`, answers };
  }

  return {
    q: text, query, extras, understood: chipsFor(query, extras, aiLabels), clarify, unsupported,
    policyNote: demographic ? POLICY_NOTE : null, source: 'ai',
  };
}

/* ───────────────────────── entry point ───────────────────────── */

export const intentCacheKey = (text: string, mode: SearchMode | null) =>
  `search.intent:${VERSION}:${createHash('sha256').update(`${normaliseQuery(text)}|${mode ?? ''}`).digest('hex').slice(0, 40)}`;

/**
 * The AI reading of a search, cached for 24h. Never throws for model problems:
 * falls back to the built-in parser (source: 'rules'), which is not cached.
 */
export async function searchIntent(text: string, mode: SearchMode | null, meta: { userId: string | null }): Promise<IntentResult> {
  try {
    const r = await cached(intentCacheKey(text, mode), TTL, async () => {
      const places = knownPlaces();
      const m = await chatJSON<ModelIntent>([
        { role: 'system', content: SYSTEM(places) },
        { role: 'user', content: `Search box mode: ${mode ?? 'any'}\n${untrusted('search', text, 400)}` },
      ], IntentSchema, 'search_intent', { purpose: 'search.intent', userId: meta.userId, role: 'fast', maxTokens: 1200, effort: 'minimal', timeoutMs: 15_000 });
      return validateIntent(m, text, mode, places);
    });
    // The cached reading may have been made for differently-typed text; answer with this text.
    return { ...r, q: text };
  } catch (e) {
    if (!(e instanceof AiError)) throw e;
    if (e.code === 'ai_budget' || e.code === 'ai_disabled' || e.code === 'ai_key') throw e;
    return fromRules(text, mode);
  }
}
