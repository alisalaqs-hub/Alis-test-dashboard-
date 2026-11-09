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

/**
 * A valuation stated as fact: "it is valued at £…", "it’s worth £…", "Streetkey values it at…",
 * "Streetkey’s valuation is…". Hedged estimates ("could be worth", "Streetkey’s indicative range")
 * and advice ("for a formal valuation, ask an RICS surveyor") are fine.
 */
const VALUATION_CLAIM = new RegExp([
  String.raw`\b(?:is|are|was|been|it['’]s|currently)\s+valued\s+at\b`,
  String.raw`\b(?:streetkey|we|i)\s+(?:has\s+|have\s+)?valued\b`,
  String.raw`\b(?:is|are|it['’]s|was)\s+(?:currently\s+|really\s+|actually\s+|definitely\s+|certainly\s+)?worth\s+(?:about\s+|around\s+|roughly\s+|approximately\s+|exactly\s+|at\s+least\s+|over\s+|more\s+than\s+)?(?:£|\d)`,
  String.raw`\b(?:streetkey|we|i)\s+(?:would\s+)?values?\s+(?:it|this|the\s+(?:home|property|house|flat)|that)\b`,
  String.raw`\b(?:streetkey['’]s|our|my)\s+valuation\b`,
  String.raw`\bstreetkey\s+valuation\b`,
  String.raw`\bvaluation\s+(?:of|is|at)\s+(?:about\s+|around\s+)?£`,
].join('|'), 'i');
/** Hedged on purpose: "…, not a valuation", "Streetkey’s indicative range…". */
const NOT_A_VALUATION = /\bnot\s+(?:a|an)\s+(?:formal\s+|official\s+|professional\s+)?valuation\b|\bindicative\b/i;
export const claimsValuation = (s: string) => VALUATION_CLAIM.test(s) && !NOT_A_VALUATION.test(s);

/** Phone numbers, email addresses, links to other websites and messaging apps (people contact listers through Streetkey). */
export const hasContactDetails = (s: string) => contactDetails(s.replace(/\[([^\]\n]*)\]\(\/[^)\s]*\)/g, '$1')).length > 0;

/** Describing or ranking places by who lives there. Streetkey declining to do so is fine. */
const DECLINES = /\b(?:streetkey|i|we)\s+(?:doesn['’]t|does\s+not|don['’]t|do\s+not|can['’]t|cannot|won['’]t|will\s+not|never)\b/i;
export const describesPeople = (s: string) => asksForDemographics(s) && !DECLINES.test(s);

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
export const fitToShow = (s: string) => !claimsValuation(s) && !hasContactDetails(s) && !mentionsProtected(s);
