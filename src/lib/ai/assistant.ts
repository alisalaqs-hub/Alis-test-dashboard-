/**
 * Website side of "Ask Streetkey": the chat call, the conversation kept for the browser session
 * (a small store outside React, so a reply that arrives while the Ask sheet is closed is shown when
 * it opens again), and helpers shared by the Ask sheet and the property assistant panels.
 * Without a server or with AI switched off, callers fall back to Streetkey's built-in rules.
 */
import { useSyncExternalStore } from 'react';
import { PROPERTY_STARTS } from '../../ai/skills';
import { getProperty, type Property } from '../../data/properties';
import { parseQuery } from '../../engine/search';
import { ApiError } from '../api';
import { isServerRef } from '../listingAdapter';
import { ACCOUNT_CHANGED_EVENT } from '../server';
import { aiPost } from './core';

export interface HomeCard { id: string; title: string; town: string; price: number; listing: 'sale' | 'rent' | 'auction'; beds: number; type: string; demo: boolean }
export interface ChatAction { label: string; to: string }
export interface ChatReply {
  reply: string;
  propertyIds: string[];
  homes: HomeCard[];
  actions: ChatAction[];
  followUps: string[];
  sources: string[];
  grounding: 'checked' | 'corrected' | 'trimmed' | 'none';
}
export interface ChatContext { propertyId?: string; page?: string }
export interface Turn { role: 'user' | 'assistant'; content: string; propertyIds?: string[] }

/**
 * A message as the Ask sheet keeps it (assistant messages carry their structured extras).
 * `failed`: a question the AI didn't answer (shown as "Not answered").
 */
export interface ChatMsg { id: string; role: 'user' | 'assistant'; content: string; at: number; extras?: Omit<ChatReply, 'reply'>; failed?: boolean }

export const MAX_TURNS = 12;
export const MAX_CHARS = 2000;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,79}$/i;
const PAGE_RE = /^\/[A-Za-z0-9\-._~/%]{0,159}$/;

export const QUICK_STARTS = [
  'Find a 3-bed house with a garden under £450k',
  'What’s the stamp duty on a £350,000 first home?',
  'Which homes look like good buy-to-let deals?',
  'What would a mid-range kitchen cost in Manchester?',
];
/** Starter questions about the home on the page (kept with the built-in skills, which can answer each one too). */
export { PROPERTY_STARTS };

const isItem = (l: string) => /^\s*(?:[-•*]|\d+\.)\s+/.test(l);
/** Blank line between prose and a list so AiText renders the list (also done by the server). */
export function tidyReply(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.trim() && line.trim() && isItem(line) !== isItem(prev)) out.push('');
    out.push(line);
  }
  return out.join('\n');
}

export const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Only internal Streetkey paths (defence in depth: the server already checks). */
export const isInternal = (to: unknown): to is string => typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') && !/[\s\\]/.test(to);

function cleanContext(c?: ChatContext): ChatContext | undefined {
  if (!c) return undefined;
  const out: ChatContext = {};
  if (c.propertyId && ID_RE.test(c.propertyId)) out.propertyId = c.propertyId;
  if (c.page && PAGE_RE.test(c.page)) out.page = c.page;
  return out.propertyId || out.page ? out : undefined;
}

/**
 * The request body: last 12 messages, each within the size limit, ending with the question.
 * A question that was never answered (followed directly by another question) is left out, so the
 * conversation the AI sees alternates and no earlier question looks ignored.
 */
export function toPayload(turns: Turn[], context?: ChatContext) {
  const usable = turns.map((t) => ({ ...t, content: t.content.trim().slice(0, MAX_CHARS) })).filter((t) => t.content)
    .filter((t, i, all) => !(t.role === 'user' && all[i + 1]?.role === 'user'));
  let recent = usable.slice(-MAX_TURNS);
  while (recent.length && recent[0].role !== 'user') recent = recent.slice(1);
  const ctx = cleanContext(context);
  return {
    messages: recent.map((t) => ({ role: t.role, content: t.content, ...(t.role === 'assistant' && t.propertyIds?.length ? { propertyIds: t.propertyIds.filter((id) => ID_RE.test(id)).slice(0, 6) } : {}) })),
    ...(ctx ? { context: ctx } : {}),
  };
}

/** Ask Streetkey AI. Throws ApiError (with a message written for people) when it can't answer. */
export const askStreetkey = (turns: Turn[], context?: ChatContext) => aiPost<ChatReply>('/api/ai/chat', toPayload(turns, context), 50_000);

export const toTurns = (msgs: ChatMsg[]): Turn[] => msgs.map((m) => ({ role: m.role, content: m.content, propertyIds: m.extras?.propertyIds }));

/* ───────────── conversation for this browser session (sessionStorage) ───────────── */
export const CHAT_KEY = 'streetkey-ask-v1';
const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);

function revive(v: unknown): ChatMsg | null {
  const m = v as Partial<ChatMsg> | null;
  if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content) return null;
  const x = m.extras as Partial<ChatReply> | undefined;
  return {
    id: typeof m.id === 'string' ? m.id : uid(), role: m.role, content: m.content.slice(0, 4000), at: typeof m.at === 'number' ? m.at : Date.now(),
    ...(m.role === 'user' && m.failed === true ? { failed: true } : {}),
    extras: m.role === 'assistant' && x ? {
      propertyIds: strings(x.propertyIds, 6), followUps: strings(x.followUps, 3), sources: strings(x.sources, 8),
      homes: Array.isArray(x.homes) ? x.homes.filter((h) => h && typeof h.id === 'string' && typeof h.title === 'string').slice(0, 6) : [],
      actions: Array.isArray(x.actions) ? x.actions.filter((a) => a && typeof a.label === 'string' && isInternal(a.to)).slice(0, 4) : [],
      grounding: x.grounding ?? 'none',
    } : undefined,
  };
}

export function loadChat(key = CHAT_KEY): ChatMsg[] {
  try {
    const raw = sessionStorage.getItem(key);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.map(revive).filter((m): m is ChatMsg => !!m).slice(-40) : [];
  } catch { return []; }
}
export function saveChat(msgs: ChatMsg[], key = CHAT_KEY) {
  try {
    if (msgs.length) sessionStorage.setItem(key, JSON.stringify(msgs.slice(-40)));
    else sessionStorage.removeItem(key);
  } catch { /* storage unavailable (private mode, blocked): the chat still works for this visit */ }
}

/* ───────────── the conversation store (outlives the Ask sheet) ───────────── */

export interface ChatState {
  msgs: ChatMsg[];
  /** A question is with the AI right now. */
  busy: boolean;
  /** Why the last question wasn't answered, if it failed in this visit. */
  error: ApiError | null;
}
interface ChatStore { state: ChatState; listeners: Set<() => void>; gen: number }
const stores = new Map<string, ChatStore>();

function storeFor(key: string): ChatStore {
  let st = stores.get(key);
  if (!st) { st = { state: { msgs: loadChat(key), busy: false, error: null }, listeners: new Set(), gen: 0 }; stores.set(key, st); }
  return st;
}
function setChat(key: string, next: (s: ChatState) => ChatState) {
  const st = storeFor(key);
  st.state = next(st.state);
  saveChat(st.state.msgs, key);
  for (const l of st.listeners) l();
}

async function request(key: string, convo: ChatMsg[], context?: ChatContext) {
  const st = storeFor(key);
  const gen = st.gen;
  setChat(key, () => ({ msgs: convo, busy: true, error: null }));
  try {
    const r = await askStreetkey(toTurns(convo), context);
    if (st.gen !== gen) return; // the chat was cleared (new chat, or someone else signed in) while waiting
    const { reply, ...extras } = r;
    setChat(key, (s) => ({ msgs: [...s.msgs, { id: uid(), role: 'assistant', content: reply, at: Date.now(), extras }], busy: false, error: null }));
  } catch (e) {
    if (st.gen !== gen) return;
    const error = e instanceof ApiError ? e : new ApiError(0, 'Something went wrong. Please try again.');
    const lastId = convo[convo.length - 1]?.id;
    setChat(key, (s) => ({ msgs: s.msgs.map((m) => (m.id === lastId ? { ...m, failed: true } : m)), busy: false, error }));
  }
}

/** Asks a question. Returns false (and does nothing) while another answer is on its way. */
export function sendChat(question: string, context?: ChatContext, key = CHAT_KEY): boolean {
  const q = question.trim().slice(0, MAX_CHARS);
  const st = storeFor(key);
  if (!q || st.state.busy) return false;
  void request(key, [...st.state.msgs, { id: uid(), role: 'user', content: q, at: Date.now() }], context);
  return true;
}

/** Asks the last, unanswered question again. */
export function retryChat(context?: ChatContext, key = CHAT_KEY): boolean {
  const st = storeFor(key);
  const last = st.state.msgs[st.state.msgs.length - 1];
  if (st.state.busy || last?.role !== 'user') return false;
  void request(key, st.state.msgs.map((m) => (m === last ? { ...m, failed: undefined } : m)), context);
  return true;
}

/** Starts a new chat; an answer still on its way is ignored. */
export function clearChat(key = CHAT_KEY) {
  const st = storeFor(key);
  st.gen++;
  setChat(key, () => ({ msgs: [], busy: false, error: null }));
}

/** The conversation, kept outside React so it survives the Ask sheet closing and opening. */
export function useChat(key = CHAT_KEY): ChatState {
  const st = storeFor(key);
  return useSyncExternalStore(
    (l) => { st.listeners.add(l); return () => { st.listeners.delete(l); }; },
    () => st.state,
    () => st.state,
  );
}

// Signing out (or another account in this tab) forgets every conversation, including one in flight.
if (typeof window !== 'undefined') {
  window.addEventListener(ACCOUNT_CHANGED_EVENT, () => { for (const key of stores.keys()) clearChat(key); });
}

/* ───────────── something useful to offer when the AI can't answer ───────────── */

export interface ChatAlternative { to: string; label: string; icon: 'search' | 'chart' | 'tools' | 'palette' | 'pound' }

const ASKS_SEARCH = /\b(?:find|show|search|looking for|look for|list|recommend)\b|\b(?:which|any|some)\s+(?:homes?|houses?|flats?|apartments?|properties|bungalows?|places|listings?)\b/i;
const TAX = /\b(?:stamp duty|sdlt|lbtt|ltt|land (?:and buildings )?transaction tax|purchase tax)\b/i;
const MONEY_CALC = /\b(?:mortgages?|repayments?|interest rates?|yields?|cash ?flow|buy[- ]to[- ]let|btl|brrr|roi|return on|rental income|investment)\b/i;
const WORKS = /\b(?:refurb\w*|renovat\w*|rewir\w*|re-?roof\w*|damp|extension|extend|loft conversion|building work|works|builders?|plaster\w*|insulat\w*|epc)\b/i;
const ROOM = /\b(?:kitchen|bathroom|en-?suite|bedroom|living room|lounge|interior|redesign)\b/i;
const SOLD = /\b(?:sold prices?|sold for|house prices|price history|recent sales|what (?:did|do) (?:homes|houses|flats) sell)\b/i;

/**
 * Where to go instead when Streetkey AI can't answer: a home search only for questions that look
 * like one (a place, bedrooms, a type or a budget, or "find/show me…"), otherwise the calculator
 * that answers it (stamp duty, mortgages and yields → the investment calculator, works →
 * refurbishment, rooms → design studio, sold prices), or nothing.
 */
export function chatAlternative(question: string): ChatAlternative | null {
  const t = question.trim();
  if (!t) return null;
  const pq = parseQuery(t.slice(0, 300));
  const place = pq.locations[0] ?? pq.districts[0] ?? '';
  if (SOLD.test(t)) return { to: place ? `/prices?q=${encodeURIComponent(place)}` : '/prices', label: 'See sold prices', icon: 'pound' };
  const calc: ChatAlternative | null = TAX.test(t) ? { to: '/invest', label: 'Work out stamp duty and costs', icon: 'pound' }
    : MONEY_CALC.test(t) ? { to: '/invest', label: 'Open the investment calculator', icon: 'chart' }
    : ROOM.test(t) ? { to: '/studio', label: 'Open the design studio', icon: 'palette' }
      : WORKS.test(t) ? { to: '/estimate', label: 'Open the refurbishment calculator', icon: 'tools' }
        : null;
  const criteria = !!(pq.locations.length || pq.districts.length || pq.types.length || pq.minBeds || pq.maxPrice);
  if (ASKS_SEARCH.test(t) || (criteria && !calc)) {
    const mode = pq.intent === 'rent' ? 'rent' : pq.intent === 'invest' ? 'invest' : 'buy';
    return { to: `/search?q=${encodeURIComponent(t.slice(0, 300))}&mode=${mode}`, label: 'Search homes for this instead', icon: 'search' };
  }
  return calc;
}

/* ───────────── homes ───────────── */
const isDemoHome = (p: Property) => !p.source || p.source.kind === 'demo';

/** Card for a home the assistant mentioned: the site's own data first, else what the server sent. */
export function cardFor(id: string, homes: HomeCard[] = []): HomeCard | null {
  const p = getProperty(id);
  if (p) return { id: p.id, title: p.title, town: p.town, price: p.price, listing: p.listing, beds: p.beds, type: p.type, demo: isDemoHome(p) };
  return homes.find((h) => h.id === id) ?? null;
}

/** The property id an assistant panel can ask the server about (homes the server knows), if any. */
export function assistantPropertyId(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined;
  const p = ctx as Partial<Property>;
  if (typeof p.id !== 'string' || typeof p.title !== 'string' || typeof p.price !== 'number' || !p.listing) return undefined;
  // Private imports, drafts and withdrawn homes aren't public, so the server can't (and mustn't) see them.
  if (p.visibility === 'private' || p.status === 'pending' || p.status === 'withdrawn' || !ID_RE.test(p.id)) return undefined;
  return !p.source || p.source.kind === 'demo' || isServerRef(p.id) ? p.id : undefined;
}
