/**
 * Website side of "Ask Streetkey": the chat call, the conversation kept for the browser session,
 * and helpers shared by the Ask sheet and the property assistant panels.
 * Without a server or with AI switched off, callers fall back to Streetkey's built-in rules.
 */
import { getProperty, type Property } from '../../data/properties';
import { isServerRef } from '../listingAdapter';
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

/** A message as the Ask sheet keeps it (assistant messages carry their structured extras). */
export interface ChatMsg { id: string; role: 'user' | 'assistant'; content: string; at: number; extras?: Omit<ChatReply, 'reply'> }

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
export const PROPERTY_STARTS = ['Is this home fairly priced?', 'What could it rent for?', 'What would it cost to refurbish?', 'What are the main risks?'];

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

/** The request body: last 12 messages, each within the size limit, ending with the question. */
export function toPayload(turns: Turn[], context?: ChatContext) {
  const usable = turns.map((t) => ({ ...t, content: t.content.trim().slice(0, MAX_CHARS) })).filter((t) => t.content);
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
