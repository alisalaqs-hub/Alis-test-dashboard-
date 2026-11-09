/**
 * Server-side checks on what the model returns, before anything reaches the website:
 * only real, public homes (and only ones this turn's tools, the page or earlier replies showed);
 * only internal links to Streetkey pages; no valuation claims, contact details or descriptions of
 * who lives somewhere; tidy, bounded text.
 */
import { asksForDemographics, mentionsProtected } from '../../../../src/lib/ai/search';
import { contactDetails } from '../trust/signals';
import { dropSentences } from './grounding';
import { findHome } from './tools';

/** Top-level pages the assistant may link to. */
const ROUTE_RE = /^\/(?:$|(?:search|property|invest|estimate|studio|compare|prices|list|import|saved|my-home|account|owner|landlord|developer|agents|marketplace|sources|enterprise|automation|privacy|terms|accessibility)(?:[/?#]|$))/;
const BASE = 'https://streetkey.invalid';

const strip = (s: string) => s.replace(/<<<|>>>/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

/**
 * A safe internal path, or null: must start with a single "/", no scheme, no backslashes,
 * no host, and point at a Streetkey page. Links that name a home must name a real one.
 */
export function safeInternalPath(to: unknown, homes?: ReadonlySet<string>): string | null {
  if (typeof to !== 'string') return null;
  const t = to.trim().replace(/ /g, '%20');
  if (!t || t.length > 300 || !t.startsWith('/') || t.startsWith('//')) return null;
  if (/[\s\\<>"'`\u0000-\u001f\u007f]/.test(t)) return null;
  if (/^[^?#]*:/.test(t)) return null; // "/javascript:…" style tricks
  let u: URL;
  try { u = new URL(t, BASE); } catch { return null; }
  if (u.origin !== BASE) return null;
  const path = `${u.pathname}${u.search}${u.hash}`;
  if (path.startsWith('//') || !ROUTE_RE.test(path)) return null;
  let ids: string[];
  try { ids = homesIn(u); } catch { return null; }
  if (u.pathname === '/compare' && (!ids.length || ids.length > 4)) return null;
  // Every home a link names must be real and public, and (when the caller says which) one this answer may show.
  if (ids.some((id) => !findHome(id) || (homes && !homes.has(id)))) return null;
  return path;
}

/** Ids of the homes a Streetkey path names: /property/<id>, ?property=<id>, /compare?ids=a,b. */
function homesIn(u: URL): string[] {
  const out: string[] = [];
  if (u.pathname === '/property' || u.pathname.startsWith('/property/')) out.push(decodeURIComponent(u.pathname.split('/')[2] ?? ''));
  const ref = u.searchParams.get('property');
  if (ref != null) out.push(ref);
  if (u.pathname === '/compare') out.push(...(u.searchParams.get('ids') ?? '').split(',').filter(Boolean));
  return out;
}

const isItem = (l: string) => /^\s*(?:[-•*]|\d+\.)\s+/.test(l);
/** Blank line between prose and a list, so the website renders the list (models often omit it). */
export function spaceLists(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.trim() && line.trim() && isItem(line) !== isItem(prev)) out.push('');
    out.push(line);
  }
  return out.join('\n');
}

/** The reply text: markers removed, only safe internal markdown links kept, lists spaced, length bounded. */
export function sanitiseReply(text: unknown, homes?: ReadonlySet<string>): string {
  let s = spaceLists(strip(String(text ?? '')).replace(/\r/g, '').trim());
  s = s.replace(/\[([^\]\n]{1,160})\]\(([^)\n]*)\)/g, (_m, label: string, href: string) => {
    const p = safeInternalPath(href, homes);
    return p ? `[${label}](${p})` : label;
  });
  if (s.length > 3000) s = `${s.slice(0, 2990).replace(/\s+\S*$/, '')}…`;
  return s;
}

export interface Action { label: string; to: string }
/**
 * `keep` lets the caller drop labels it can't stand behind (e.g. ones with unchecked figures);
 * `homes` limits links that name a home to the homes this answer may show.
 */
export function sanitiseActions(list: unknown, max = 4, keep: (label: string) => boolean = () => true, homes?: ReadonlySet<string>): Action[] {
  const out: Action[] = [];
  const seen = new Set<string>();
  for (const a of Array.isArray(list) ? list : []) {
    const rec = a as { label?: unknown; to?: unknown } | null;
    const label = typeof rec?.label === 'string' ? strip(rec.label).replace(/\s+/g, ' ').trim().slice(0, 48) : '';
    const to = safeInternalPath(rec?.to, homes);
    if (!label || !to || seen.has(to) || !keep(label)) continue;
    seen.add(to);
    out.push({ label, to });
    if (out.length >= max) break;
  }
  return out;
}

export function sanitiseFollowUps(list: unknown, max = 3, keep: (text: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const f of Array.isArray(list) ? list : []) {
    if (typeof f !== 'string') continue;
    const s = strip(f).replace(/\s+/g, ' ').trim();
    if (s.length < 3 || s.length > 100 || /https?:|www\./i.test(s) || !keep(s)) continue;
    if (out.some((x) => x.toLowerCase() === s.toLowerCase())) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Ids of real, public homes only (unknown or private ids are dropped). With `allowed`, only homes
 * in that set: the model may only show homes a tool returned this turn, the page's home, or ones
 * earlier replies showed, never any public id it happens to know.
 */
export function knownIds(list: unknown, max = 6, allowed?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const id of Array.isArray(list) ? list : []) {
    if (typeof id !== 'string') continue;
    const p = findHome(id.trim());
    if (p && (!allowed || allowed.has(p.id)) && !out.includes(p.id)) out.push(p.id);
    if (out.length >= max) break;
  }
  return out;
}

/** Ids of the homes in tool results (any `id` field, at any depth). */
export function idsIn(v: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || v == null || typeof v !== 'object') return out;
  if (Array.isArray(v)) { for (const x of v) idsIn(x, out, depth + 1); return out; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'id' && typeof x === 'string') { const p = findHome(x); if (p) out.add(p.id); } else idsIn(x, out, depth + 1);
  }
  return out;
}

/* ───────────── claims the assistant must never make in Streetkey's voice ───────────── */

/** "it", "this home", "the flat", "its": the home an answer is about. */
const HOME = String.raw`(?:it|this|that|(?:this|that|the)\s+(?:home|property|house|flat|bungalow|maisonette|cottage))`;
const HOMES = String.raw`(?:its|it['’]s|(?:this|that|the)\s+(?:home|property|house|flat|bungalow|maisonette|cottage)['’]s)`;
const ABOUT = String.raw`(?:about\s+|around\s+|roughly\s+|approximately\s+|exactly\s+|at\s+least\s+|over\s+|more\s+than\s+|just\s+(?:over|under)\s+)?`;
/**
 * A valuation stated as fact: "it is valued at £…", "it’s worth £…", "Streetkey values it at…",
 * "Streetkey’s valuation is…", "this home’s value is £…", "Streetkey puts its value at £…",
 * "it would sell for £…", "Streetkey’s estimate for it is £…". Hedged estimates ("could be worth",
 * "could sell for", "Streetkey’s indicative range") and other estimates ("Streetkey’s refurbishment
 * estimate is…", "the rent estimate for it is…", "a loft could add value of…") are fine, as is advice
 * ("for a formal valuation, ask an RICS surveyor").
 */
const VALUATION_CLAIM = new RegExp([
  String.raw`\b(?:is|are|was|been|it['’]s|currently)\s+valued\s+at\b`,
  String.raw`\b(?:streetkey|we|i)\s+(?:has\s+|have\s+)?valued\b`,
  String.raw`\b(?:is|are|it['’]s|was)\s+(?:currently\s+|really\s+|actually\s+|definitely\s+|certainly\s+)?worth\s+${ABOUT}(?:£|\d)`,
  String.raw`\b(?:streetkey|we|i)\s+(?:would\s+)?values?\s+(?:it|this|the\s+(?:home|property|house|flat)|that)\b`,
  String.raw`\b(?:streetkey['’]s|our|my)\s+valuation\b`,
  String.raw`\bstreetkey\s+valuation\b`,
  String.raw`\bvaluation\s+(?:of|is|at)\s+(?:about\s+|around\s+)?£`,
  // "This home’s value is £…", "its market value would be £…", "its estimated value is £…".
  String.raw`\b${HOMES}\s+(?:(?:market|current|true|real|actual|likely|estimated|sale|resale)\s+)?value\s+(?:is|was|would\s+be|will\s+be|should\s+be|stands\s+at|comes\s+to|sits\s+at)\s+${ABOUT}(?:£|\d)`,
  // "Streetkey puts its value at £…", "comparables put the home’s value at £…", "we estimate its value at £…".
  String.raw`\b(?:puts?|places?|pegs?|sets?|estimates?)\s+(?:its|the|this|that)\s+(?:(?:home|property|house|flat)['’]s\s+)?(?:(?:market|current|true|real|sale|resale)\s+)?value\s+(?:at|to\s+be)\s+${ABOUT}(?:£|\d)`,
  // "It would sell for £…", "this home will go for £…" (not "could sell for", not "is selling for": the asking price).
  String.raw`\b${HOME}\s+(?:would|will|should|is\s+(?:going|likely|expected|set|certain)\s+to)\s+(?:probably\s+|likely\s+|easily\s+|definitely\s+|certainly\s+)?(?:sell|go)\s+for\s+${ABOUT}(?:£|\d)`,
  // "Streetkey’s estimate for it is £…", "our value estimate is £…", "its estimated value of £…".
  String.raw`\b(?:streetkey['’]s|streetkey|our|my)\s+(?:(?:value|price|sale|market|own)\s+)?estimate\s+(?:for|of)\s+(?:${HOME}|its\s+(?:value|price|worth))\s+(?:is|was|would\s+be|comes\s+to|stands\s+at)\s+${ABOUT}(?:£|\d)`,
  String.raw`\b(?:streetkey['’]s|streetkey|our|my)\s+(?:value|price|sale|market)\s+estimate\s+(?:is|was|would\s+be|comes\s+to|stands\s+at|of)\s+${ABOUT}(?:£|\d)`,
  String.raw`\bestimated\s+(?:market\s+|sale\s+)?value\s+(?:is|was|of|at|would\s+be)\s+${ABOUT}£`,
].join('|'), 'i');
/** Hedged on purpose: "…, not a valuation", "Streetkey’s indicative range…". */
const NOT_A_VALUATION = /\bnot\s+(?:a|an)\s+(?:formal\s+|official\s+|professional\s+)?valuation\b|\bindicative\b/i;
export const claimsValuation = (s: string) => VALUATION_CLAIM.test(s) && !NOT_A_VALUATION.test(s);

/** Phone numbers, email addresses, links to other websites and messaging apps (people contact listers through Streetkey). */
export const hasContactDetails = (s: string) => contactDetails(s.replace(/\[([^\]\n]*)\]\(\/[^)\s]*\)/g, '$1')).length > 0;

/**
 * Things named after a place or a people that are not about who lives anywhere: a facility named
 * after a place ("Leyton community centre", "the Walthamstow community garden"), polish as a finish
 * ("polish the floors", "French polish"), materials and products ("Indian sandstone", "a Turkish
 * bath", "an Islamic mortgage", "expat mortgages"). They are taken out before the checks for
 * questions and text about who lives somewhere, so they never trip them.
 * A facility named for a group of people ("the Jewish community centre", "Polish community hall")
 * still counts, and so do places of worship: Streetkey's search policy treats "near a church/mosque"
 * as a proxy for who lives somewhere, for every faith alike, and the assistant follows it.
 */
const FACILITY = /\b([\w'’-]+)\s+community\s+(?:centres?|centers?|gardens?|halls?|hospitals?|hubs?|librar(?:y|ies)|caf[eé]s?|groups?|trusts?|spaces?|schools?|colleges?|farms?|orchards?|allotments?|pubs?|shops?|stores?|clubs?|projects?|rooms?|buildings?|interest\s+compan(?:y|ies)|energy|land\s+trusts?)\b/gi;
const NOT_PEOPLE = [
  /\bpolish(?:es|ing)?\s+(?:up\s+)?(?:the\s+|your\s+|my\s+|our\s+|its\s+)?(?:floors?|floorboards|boards|woodwork|wood|furniture|worktops?|brass|silver|tiles?|marble|shoes|windows?|doors?|surfaces?|taps?|stairs?|banisters?)\b/gi,
  /\b(?:french|floor|wax|furniture|shoe|metal|brass|silver|nail)\s+polish(?:ed|ing)?\b/gi,
  /\b(?:turkish|moroccan|indian|chinese|portuguese|greek)\s+(?:baths?|hammams?|delight|coffee|rugs?|carpets?|kilims?|tiles?|lanterns?|sandstone|stone|slate|limestone|marble|granite)\b/gi,
  /\b(?:islamic|sharia|shari['’]a)[- ](?:mortgages?|finance|home\s+(?:finance|purchase\s+plans?)|banks?|banking|lenders?|compliant\s+(?:mortgages?|finance))\b/gi,
  /\bexpats?[- ](?:mortgages?|buy[- ]to[- ]lets?|lenders?|loans?)\b/gi,
];
/** `text` without the words above, for the checks on who lives somewhere. */
export function notPeople(text: string): string {
  let s = text.replace(FACILITY, (m: string, word: string) => (mentionsProtected(word) || asksForDemographics(`${word} people`) ? m : ' '));
  for (const re of NOT_PEOPLE) s = s.replace(re, ' ');
  return s;
}
/** A question (or text) asking to pick or describe areas by who lives there. */
export const asksAboutPeople = (text: string) => asksForDemographics(notPeople(text));

/** Describing or ranking places by who lives there. Streetkey declining to do so is fine. */
const DECLINES = /\b(?:streetkey|i|we)\s+(?:doesn['’]t|does\s+not|don['’]t|do\s+not|can['’]t|cannot|won['’]t|will\s+not|never)\b/i;
export const describesPeople = (s: string) => asksAboutPeople(s) && !DECLINES.test(s);

export const VALUATION_NOTE = 'Streetkey’s figures are indicative ranges, not a valuation: an RICS surveyor can value a home.';
export const CONTACT_NOTE = 'To get in touch with a lister, use the enquiry form on the listing.';
export const PEOPLE_NOTE = 'Streetkey doesn’t describe or rank areas by who lives there.';

/**
 * Removes sentences that state a valuation as fact, give contact details or describe areas by
 * who lives there, and says briefly why. Runs on the final reply, after the figure checks.
 */
export function dropClaims(text: string): { text: string; removed: number } {
  const notes = new Set<string>();
  const r = dropSentences(text, (s) => {
    if (claimsValuation(s)) { notes.add(VALUATION_NOTE); return true; }
    if (hasContactDetails(s)) { notes.add(CONTACT_NOTE); return true; }
    if (describesPeople(s)) { notes.add(PEOPLE_NOTE); return true; }
    return false;
  });
  if (!r.removed) return { text, removed: 0 };
  return { text: [r.text, ...notes].filter(Boolean).join('\n\n'), removed: r.removed };
}

/** Short model-written text (suggested questions, button labels) the website may show. */
export const fitToShow = (s: string) => !claimsValuation(s) && !hasContactDetails(s) && !mentionsProtected(notPeople(s));
