/**
 * Website side of Streetkey AI: availability, calls, background-job polling, screen-reader
 * announcements and the shared reading of AI errors.
 * Every AI feature falls back to Streetkey's built-in rules when AI isn't available
 * (static preview, AI switched off or paused, or the request fails), so pages never break.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { apiCall, ApiError } from '../api';
import { ACCOUNT_CHANGED_EVENT, useServer } from '../server';

export interface AiJob<T = unknown> { id: string; kind: string; status: 'queued' | 'running' | 'done' | 'failed'; progress: string | null; output: T | null; error: string | null; createdAt: string }

/**
 * Why AI can't be used right now. 'disabled': switched off or not set up on this server.
 * 'paused': temporarily unavailable (the OpenAI account is out of credit, or today's site-wide budget is used up).
 */
export type AiOffReason = 'checking' | 'offline' | 'disabled' | 'paused' | null;

/** The reasons GET /api/ai/status gives (server/src/ai/core.ts aiOffReason). */
export type ServerAiOffReason = 'disabled' | 'no_key' | 'paused' | 'budget' | null;

/** This person (or visitor network) has used today's AI allowance: AI works, but not for them until it resets. */
export interface AiLimit {
  /** The server's message, written for people (it says whether a free account would help). */
  message: string;
  /** When the allowance comes back, if the server said. */
  resetAt: Date | null;
  /** A visitor's allowance: signing in lifts it. */
  visitor: boolean;
}

/* ───────────── Shared AI state: paused, today's limit reached, and what the server said ───────────── */

interface AiShared {
  /** The server answered 503 'ai_unavailable', 'ai_quota', 'ai_budget'… a moment ago. */
  paused: boolean;
  limit: AiLimit | null;
  /** GET /api/ai/status, asked when /api/health says AI isn't available (null until it answers). */
  server: { enabled: boolean; reason: ServerAiOffReason; note: string | null } | null;
}
const PAUSE_MS = 5 * 60_000;
/** How long "today's limit reached" stands when the server didn't say when it resets (the next request checks again). */
const LIMIT_FALLBACK_MS = 30 * 60_000;
let shared: AiShared = { paused: false, limit: null, server: null };
let pauseTimer: ReturnType<typeof setTimeout> | undefined;
let limitTimer: ReturnType<typeof setTimeout> | undefined;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let statusAsking = false;
const subs = new Set<() => void>();
const update = (patch: Partial<AiShared>) => { shared = { ...shared, ...patch }; subs.forEach((f) => f()); };
const subscribeShared = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const sharedSnapshot = () => shared;
const SERVER_SNAPSHOT: AiShared = { paused: false, limit: null, server: null };

/**
 * Server codes (with status 503) meaning AI as a whole can't be used right now: switched off,
 * not set up, out of credit or over the site's daily budget. ('ai_busy' is a moment's congestion: retry.)
 */
const AI_OFF_CODES = new Set(['ai_unavailable', 'ai_quota', 'ai_budget', 'ai_disabled', 'ai_key']);
/** True for an error that means AI as a whole is unavailable (fall back to the built-in rules). */
export const isAiOffError = (e: unknown): boolean => e instanceof ApiError && e.status === 503 && AI_OFF_CODES.has(e.code);

/**
 * True for a 429 meaning this person (or visitor network) has used today's AI allowance: the per-person
 * token cap ('ai_user_limit'), or the daily request limit ('daily_limit'; older servers: 'rate_limited' with a message about today or 24 hours).
 * A per-minute or per-feature limit is not this: other AI features still work.
 */
export const isDailyAiLimitError = (e: unknown): e is ApiError =>
  e instanceof ApiError && (e.code === 'ai_user_limit' || e.code === 'daily_limit' || (e.code === 'rate_limited' && /\btoday|24 hours/i.test(e.message)));

/**
 * Called for every failed AI request. When the server says AI as a whole is unavailable
 * (switched off, out of credit or over the daily budget), every AI widget falls back to the
 * built-in rules for a few minutes instead of offering buttons that can't work. When the person
 * has used today's AI allowance, useAi() reports `limited` until it resets, so pages can stop
 * advertising AI that won't answer them (and suggest signing in, for a visitor).
 */
export function noteAiError(e: unknown) {
  if (isDailyAiLimitError(e)) {
    const after = retryAfterOf(e);
    const ms = Math.min(after != null ? after * 1000 : LIMIT_FALLBACK_MS, 86_400_000);
    clearTimeout(limitTimer);
    limitTimer = setTimeout(() => update({ limit: null }), ms);
    update({ limit: { message: e.message, resetAt: after != null ? new Date(Date.now() + after * 1000) : null, visitor: /\bvisitors?\b|free account/i.test(e.message) } });
    return;
  }
  if (!isAiOffError(e)) return;
  clearTimeout(pauseTimer);
  pauseTimer = setTimeout(() => update({ paused: false }), PAUSE_MS);
  update({ paused: true });
}

// A limit belongs to whoever reached it: when this tab signs out or changes account it no longer applies.
if (typeof window !== 'undefined') window.addEventListener(ACCOUNT_CHANGED_EVENT, () => { clearTimeout(limitTimer); if (shared.limit) update({ limit: null }); });

/**
 * /api/health only says whether AI is available. When it isn't, ask the server why (switched off, or
 * paused for a while), and while it is paused ask again every few minutes, so AI comes back without a reload.
 */
function askServerWhyOff(again = false) {
  if (statusAsking || (shared.server && !again)) return;
  statusAsking = true;
  void apiCall<{ enabled?: boolean; reason?: ServerAiOffReason; note?: string | null }>('GET', '/api/ai/status', undefined, { timeout: 10_000 })
    .then((s): AiShared['server'] => ({ enabled: s.enabled === true, reason: s.reason ?? null, note: typeof s.note === 'string' ? s.note : null }), () => null)
    .then((answer) => {
      statusAsking = false;
      // Couldn't tell: keep what the server said last, or (the first time) treat AI as switched off, as before the server gave reasons.
      const server = answer ?? shared.server ?? { enabled: false, reason: null, note: null };
      if (server !== shared.server) update({ server });
      clearTimeout(statusTimer);
      // Paused: keep saying so while asking again (no flicker), and switch AI back on once the server says it's on.
      if (!server.enabled && (server.reason === 'paused' || server.reason === 'budget')) statusTimer = setTimeout(() => askServerWhyOff(true), PAUSE_MS);
    });
}

/**
 * Is AI usable right now, and why not if it isn't.
 * `photos` / `images`: AI can read photos / make room images here (false when AI is off, or on a provider without them).
 * `limited`: AI is on, but this person has used today's allowance (`limit` says until when, and whether
 * signing in would help). `note`: the server's own words when AI is off or paused, if it gave any.
 */
export function useAi() {
  const { status, online, health, user } = useServer();
  const s = useSyncExternalStore(subscribeShared, sharedSnapshot, () => SERVER_SNAPSHOT);
  const healthOff = online && !health?.features.ai;
  useEffect(() => { if (healthOff && !s.server) askServerWhyOff(); }, [healthOff, s.server]);
  const server = healthOff ? s.server : null;
  const reason: AiOffReason = status === 'checking' ? 'checking' : !online ? 'offline'
    : healthOff ? (!server ? 'checking' : server.enabled ? (s.paused ? 'paused' : null) : server.reason === 'paused' || server.reason === 'budget' ? 'paused' : 'disabled')
    : s.paused ? 'paused' : null;
  // A visitor's limit is lifted by signing in.
  const limit = s.limit && !(s.limit.visitor && user) ? s.limit : null;
  // AI can be on while the provider behind it has no way to read photos or make room images (a chat-only plan).
  const available = reason === null;
  const photos = available && health?.features.aiPhotos !== false;
  const images = available && health?.features.aiImages !== false;
  return { available, photos, images, reason, signedIn: !!user, user, limited: reason === null && !!limit, limit: reason === null ? limit : null, note: reason === 'disabled' || reason === 'paused' ? server?.note ?? null : null };
}

const noted = <T>(p: Promise<T>) => p.catch((e: unknown) => { noteAiError(e); throw e; });
export const aiPost = <T>(path: string, body: unknown, timeout = 60_000) => noted(apiCall<T>('POST', path, body, { timeout }));
export const aiGet = <T>(path: string, timeout = 30_000) => noted(apiCall<T>('GET', path, undefined, { timeout }));

/** Polls a background job until it finishes. Resolves with its output; rejects with ApiError on failure. */
export async function pollJob<T>(id: string, o: { onProgress?: (job: AiJob<T>) => void; signal?: AbortSignal; intervalMs?: number; timeoutMs?: number } = {}): Promise<T> {
  const until = Date.now() + (o.timeoutMs ?? 5 * 60_000);
  let wait = o.intervalMs ?? 1500;
  const cancelled = () => new ApiError(0, 'Cancelled.', 'cancelled');
  for (;;) {
    if (o.signal?.aborted) throw cancelled();
    const { job } = await noted(apiCall<{ job: AiJob<T> }>('GET', `/api/ai/jobs/${id}`));
    if (o.signal?.aborted) throw cancelled();
    o.onProgress?.(job);
    if (job.status === 'done') return job.output as T;
    if (job.status === 'failed') throw new ApiError(502, job.error ?? 'The AI couldn’t finish that. Please try again.', 'ai_failed');
    if (Date.now() > until) throw new ApiError(504, 'This is taking longer than expected. We’ll keep working on it: check back in a few minutes.', 'ai_slow');
    await new Promise<void>((r) => {
      const t = setTimeout(done, wait);
      function done() { clearTimeout(t); o.signal?.removeEventListener('abort', done); r(); }
      o.signal?.addEventListener('abort', done, { once: true });
    });
    wait = Math.min(4000, wait * 1.25);
  }
}

/* ───────────── Screen-reader announcements ───────────── */

let regions: { polite: HTMLElement; assertive: HTMLElement } | null = null;
const announceTimers: Partial<Record<'polite' | 'assertive', ReturnType<typeof setTimeout>>> = {};

/** Creates the page's two visually hidden live regions (once). They must exist before anything is announced. */
export function ensureAnnouncer() {
  if (typeof document === 'undefined' || !document.body) return null;
  if (regions?.polite.isConnected && regions.assertive.isConnected) return regions;
  const make = (politeness: 'polite' | 'assertive') => {
    const el = document.createElement('div');
    el.setAttribute('aria-live', politeness);
    el.setAttribute('aria-atomic', 'true');
    if (politeness === 'polite') el.setAttribute('role', 'status');
    el.dataset.announcer = politeness;
    el.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;';
    document.body.appendChild(el);
    return el;
  };
  regions = { polite: make('polite'), assertive: make('assertive') };
  return regions;
}

/**
 * Tells screen-reader users something happened (an AI result arrived, work started).
 * One shared, always-present live region, so messages are read reliably wherever the result appears.
 */
export function announce(message: string, politeness: 'polite' | 'assertive' = 'polite') {
  const r = ensureAnnouncer();
  if (!r) return;
  const el = r[politeness];
  clearTimeout(announceTimers[politeness]);
  el.textContent = '';
  if (!message) return;
  // A short gap so the same message twice in a row is still read, and a new region is registered first.
  announceTimers[politeness] = setTimeout(() => { el.textContent = message; }, 120);
}

/* ───────────── Which AI action did the person ask for? ───────────── */

/**
 * AiButton records the button the person pressed. useAiAction uses it to announce results only
 * for actions someone asked for (not background checks), and AiCard to move focus to a result
 * that replaced the button the person pressed.
 */
let aiClick: { el: HTMLElement; scope: HTMLElement | null; at: number } | null = null;
let inAiClick = 0;
/** Runs an AiButton's click handler, recording that the person asked for this action. */
export function runAsAiClick(el: HTMLElement, fn: () => void) {
  aiClick = { el, scope: el.closest<HTMLElement>('.ai-card2, section, .card'), at: Date.now() };
  inAiClick++;
  try { fn(); } finally { inAiClick--; }
}
/** The AI button pressed in the last two minutes, if any (for focus management). */
export function recentAiClick() { return aiClick && Date.now() - aiClick.at < 120_000 ? aiClick : null; }
/** Forget the pressed button (App calls this on every page change, so focus is never moved on a new page). */
export function clearAiClick() { aiClick = null; }
/** Is an AI action being started by the person right now (inside an AiButton click, or a moment after one)? */
export const askedJustNow = () => inAiClick > 0 || (aiClick != null && Date.now() - aiClick.at < 1500);

/*
 * The person's last use of a control on this page: pressing a button (not following a link), sending a
 * form, or changing a field (picking photos, choosing an option). AiThinking uses it to tell work the
 * person started from the page's own controls (a search box, a chat form, a photo picker) from work
 * that starts by itself when a page opens, which shouldn't interrupt a screen reader.
 */
let activation: { at: number; path: string } | null = null;
/** The page the person is on: the route path, wherever the router keeps it (the address, or the part after # in portable builds). */
const pagePath = () => (typeof location === 'undefined' ? '' : location.pathname + location.hash.replace(/[?].*$/, ''));
const PRESSABLE = 'button, [role="button"], [role="radio"], [role="tab"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="option"], input[type="checkbox"], input[type="radio"], input[type="submit"], input[type="button"], input[type="file"], summary';
function noteActivation(e: Event) {
  if (!e.isTrusted) return;
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  // Following a link (to another page or within this one), or clicking into a text box, isn't asking for anything.
  if (e.type === 'click' && (t.closest('a[href]') || !t.closest(PRESSABLE))) return;
  activation = { at: Date.now(), path: pagePath() };
}
let watchingActivation = false;
/** Starts noting the person's use of controls (once; App and AiThinking call it). */
export function watchActivation() {
  if (watchingActivation || typeof document === 'undefined') return;
  watchingActivation = true;
  for (const type of ['click', 'submit', 'change']) document.addEventListener(type, noteActivation, true);
}
/**
 * Did the person start something on this page a moment ago (an AiButton, or any of the page's own
 * buttons, forms or fields)? Work that starts when a page opens is not counted, even if the person
 * clicked something on the page they came from.
 */
export const personStartedJustNow = () =>
  askedJustNow() || (activation != null && Date.now() - activation.at < 1500 && activation.path === pagePath());

/* ───────────── useAiAction ───────────── */

export interface AiActionOptions<T> {
  /** Short name for announcements, e.g. 'AI verdict' gives "AI verdict ready." */
  label?: string;
  /**
   * Screen-reader announcements. Default 'auto': announce the result when the action was started
   * from an AiButton. true: always. false: never (the page announces it itself).
   */
  announce?: boolean | 'auto';
  /** What to announce when the result arrives (default "<label> ready." or "Streetkey AI has finished."). */
  done?: string | ((data: T) => string | null);
  /** What to announce when the action starts (default: nothing; AiThinking announces its own label). */
  busy?: string;
}

/**
 * Run an AI action with busy/error state:
 *   const draft = useAiAction((facts) => aiPost<Out>('/api/ai/listing/describe', facts), { label: 'Description' })
 *   <AiButton busy={draft.busy} onClick={() => draft.run(facts)}>…</AiButton>
 * Always calls the latest version of `fn`, and only the latest run (since the last reset) can set the
 * result, so a slow earlier answer never overwrites a newer one.
 */
export function useAiAction<A extends unknown[], T>(fn: (...args: A) => Promise<T>, options: AiActionOptions<T> = {}) {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; busy: boolean }>({ data: null, error: null, busy: false });
  const live = useRef(true);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  const optsRef = useRef(options);
  // Keep the latest closure (so a caller never runs a stale one, e.g. the previous thread's id).
  useLayoutEffect(() => { fnRef.current = fn; optsRef.current = options; });
  useEffect(() => { live.current = true; ensureAnnouncer(); return () => { live.current = false; }; }, []);

  const run = useCallback(async (...args: A) => {
    const my = ++seq.current;
    const o = optsRef.current;
    const speak = o.announce === true || ((o.announce ?? 'auto') === 'auto' && askedJustNow());
    setState((s) => ({ ...s, busy: true, error: null }));
    if (speak && o.busy) announce(o.busy);
    const current = () => live.current && my === seq.current;
    try {
      const data = await fnRef.current(...args);
      if (current()) {
        setState({ data, error: null, busy: false });
        if (speak) {
          const msg = typeof o.done === 'function' ? o.done(data) : o.done ?? (o.label ? `${o.label} ready.` : 'Streetkey AI has finished.');
          if (msg) announce(msg);
        }
      }
      return current() ? data : null;
    } catch (e) {
      noteAiError(e);
      const err = e instanceof ApiError ? e : new ApiError(0, 'Something went wrong. Please try again.');
      if (current()) setState((s) => ({ ...s, error: err.code === 'cancelled' ? null : err, busy: false }));
      return null;
    }
  }, []);
  /** Forget the result and error, and ignore any run still in progress. */
  const reset = useCallback(() => { seq.current++; setState({ data: null, error: null, busy: false }); }, []);
  /** Hide the error (for example once the inputs that caused it have changed). */
  const clearError = useCallback(() => setState((s) => (s.error ? { ...s, error: null } : s)), []);
  const setData = useCallback((data: T | null) => setState((s) => ({ ...s, data })), []);
  return { ...state, run, reset, clearError, setData };
}

/* ───────────── Reading AI errors (shared by AiErrorNote and pages) ───────────── */

const FIELD_NAMES: Record<string, string> = {
  postcode: 'Postcode', floorArea: 'Floor area', area: 'Floor area', beds: 'Bedrooms', bedrooms: 'Bedrooms', baths: 'Bathrooms', bathrooms: 'Bathrooms',
  storeys: 'Storeys', structuralOpenings: 'Structural openings', extensionArea: 'Extension area', loftArea: 'Loft conversion area', ensuites: 'En-suites',
  groundworksArea: 'Groundworks area', officeToResiArea: 'Office-to-residential area', propertyType: 'Property type', type: 'Property type', era: 'Age of the property',
  condition: 'Condition', epc: 'EPC rating', goals: 'Goals', budget: 'Budget', price: 'Purchase price', monthlyRent: 'Rent', gdv: 'Post-works value (GDV)',
  depositPct: 'Deposit', mortgageRate: 'Mortgage rate', lenderFeePct: 'Lender fee', bridgingRateMonthly: 'Bridging rate', refinanceLtv: 'Refinance LTV',
  voidPct: 'Voids', managementPct: 'Management', maintenancePct: 'Maintenance', sellingCostsPct: 'Selling costs', refurbCost: 'Refurbishment', refurbMonths: 'Refurbishment months',
  termYears: 'Mortgage term', legalFees: 'Legal fees', surveyFees: 'Survey', insuranceAnnual: 'Insurance', serviceChargeAnnual: 'Service charge / ground rent',
  hmoBillsMonthly: 'Bills', licensingAnnual: 'Licensing', holdingMonthly: 'Holding cost', description: 'Description', notes: 'Notes', text: 'Your text',
  q: 'Search', message: 'Message', photos: 'Photos', files: 'Photos', tone: 'Tone', intent: 'What the reply should do', strategy: 'Strategy', scenario: 'Scenario',
  addressLine: 'Address', town: 'Town', email: 'Email address', password: 'Password', name: 'Name',
};

/** 'input.floorArea' → 'Floor area'; unknown names are turned into words ('serviceCharge' → 'Service charge'). */
export function fieldLabel(path: string, labels: Record<string, string> = {}): string {
  if (labels[path]) return labels[path];
  const parts = path.split('.').filter((p) => p && !/^\d+$/.test(p));
  const last = parts.at(-1) ?? path;
  if (labels[last]) return labels[last];
  if (FIELD_NAMES[last]) return FIELD_NAMES[last];
  if (last === '_' || !last) return 'Details';
  const words = last.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Validation messages written for people; the library's technical defaults are reworded. */
export function friendlyFieldMessage(msg: string): string {
  const m = msg.trim();
  let x: RegExpMatchArray | null;
  if ((x = m.match(/expected (?:number|int|bigint) to be <=?\s*([\d.,]+)/i))) return `Enter ${Number(x[1].replace(/,/g, '')).toLocaleString('en-GB')} or less.`;
  if ((x = m.match(/expected (?:number|int|bigint) to be >=?\s*([\d.,-]+)/i))) return `Enter ${Number(x[1].replace(/,/g, '')).toLocaleString('en-GB')} or more.`;
  if ((x = m.match(/expected string to have <=?\s*(\d+) characters?/i))) return `Keep this to ${Number(x[1]).toLocaleString('en-GB')} characters or fewer.`;
  if (/expected string to have >=?\s*1 characters?/i.test(m)) return 'Fill this in.';
  if ((x = m.match(/expected string to have >=?\s*(\d+) characters?/i))) return `Use at least ${x[1]} characters.`;
  if ((x = m.match(/expected array to have <=?\s*(\d+) items?/i))) return `Choose no more than ${x[1]}.`;
  if (/expected array to have >=?\s*1 items?/i.test(m)) return 'Choose at least one.';
  if ((x = m.match(/expected array to have >=?\s*(\d+) items?/i))) return `Choose at least ${x[1]}.`;
  if (/expected int, received number/i.test(m)) return 'Enter a whole number.';
  if (/received undefined|^required$/i.test(m)) return 'This is missing.';
  if (/^invalid option|invalid enum/i.test(m)) return 'Choose one of the options.';
  if (/expected number, received (string|nan)/i.test(m)) return 'Enter a number.';
  if (/^invalid input/i.test(m)) return 'This doesn’t look right.';
  return m;
}

export interface AiErrorAdvice {
  kind: 'invalid' | 'verify_email' | 'sign_in' | 'limit' | 'unavailable' | 'not_allowed' | 'cancelled' | 'retry';
  /** The server's message (already written for people). */
  message: string;
  /** Field-level problems for 'invalid'. */
  fields: { key: string; label: string; message: string }[];
  /** Offer "Try again" (after waitSec seconds). */
  retry: boolean;
  waitSec: number;
  /** When a long limit resets, if known. */
  resetAt: Date | null;
  /** A visitor hit a limit an account would lift: suggest a free account. */
  suggestAccount: boolean;
}

const retryAfterOf = (e: ApiError) => { const n = Number(e.fields?.retryAfter); return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null; };

/** How the website should react to an AI error: what to say, and whether a retry can work. */
export function describeAiError(e: ApiError, o: { signedIn?: boolean; now?: number } = {}): AiErrorAdvice {
  const now = o.now ?? Date.now();
  const base: AiErrorAdvice = { kind: 'retry', message: e.message, fields: [], retry: true, waitSec: 0, resetAt: null, suggestAccount: false };
  if (e.code === 'cancelled') return { ...base, kind: 'cancelled', retry: false };
  if (e.code === 'verify_email') return { ...base, kind: 'verify_email', retry: false };
  if (e.status === 401 || e.code === 'auth_required') return { ...base, kind: 'sign_in', retry: false };
  if (isAiOffError(e)) return { ...base, kind: 'unavailable', retry: false };
  if (e.status === 429 || e.code === 'rate_limited' || e.code === 'ai_user_limit') {
    const after = retryAfterOf(e) ?? (e.code === 'rate_limited' && !/today|hour|24/i.test(e.message) ? 60 : null);
    const short = after != null && after <= 120 && e.code !== 'ai_user_limit';
    const suggestAccount = !o.signedIn && (e.code === 'ai_user_limit' || /free account/i.test(e.message));
    return { ...base, kind: 'limit', retry: short, waitSec: short ? after : 0, resetAt: !short && after != null ? new Date(now + after * 1000) : null, suggestAccount };
  }
  const fieldEntries = Object.entries(e.fields ?? {}).filter(([k, v]) => k !== 'retryAfter' && typeof v === 'string' && v.trim());
  if (e.code === 'invalid' || e.code === 'checks_failed' || ((e.status === 400 || e.status === 422) && fieldEntries.length)) {
    return { ...base, kind: 'invalid', retry: false, fields: fieldEntries.map(([key, v]) => ({ key, label: fieldLabel(key), message: friendlyFieldMessage(v) })) };
  }
  if (e.status === 403) return { ...base, kind: 'not_allowed', retry: false };
  // Other 4xx (not found, conflicts, too large, bad input): repeating the same request can't help.
  if (e.status >= 400 && e.status < 500 && e.status !== 408) return { ...base, kind: 'not_allowed', retry: false };
  return base; // network problems, timeouts, 5xx, a slow job: worth another go
}

/** "at 14:35", "tomorrow at 07:10", "in about 20 minutes". */
export function formatResetTime(at: Date, now = Date.now()): string {
  const mins = Math.max(1, Math.round((at.getTime() - now) / 60_000));
  if (mins < 60) return `in about ${mins} minute${mins === 1 ? '' : 's'}`;
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(at) - day(new Date(now))) / 86_400_000);
  if (diff <= 0) return `at ${time}`;
  if (diff === 1) return `tomorrow at ${time}`;
  return `on ${at.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} at ${time}`;
}

/* ───────────── Sign-in return path ───────────── */

/** An internal path that is safe to return to after signing in ('/x?y'), or null. Never another site. */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  // One leading "/" only ("//host" and "/\host" are other sites), no spaces, backslashes or control characters.
  if (!/^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/.test(raw)) return null;
  return raw;
}

/** The sign-in page, returning to `next` afterwards (Account.tsx reads ?next=). */
export function signInPath(next?: string | null): string {
  const safe = safeNextPath(next ?? null);
  return safe && !/^\/account\/?(\?|$)/.test(safe) ? `/account?next=${encodeURIComponent(safe)}` : '/account';
}

/** The sign-in link for the current page: /account?next=<this page>. */
export function useSignInPath(): string {
  const { pathname, search } = useLocation();
  // A hand-typed address can hold raw spaces: encode them so the page still counts as a safe return path.
  return useMemo(() => signInPath(`${pathname}${search}`.replace(/ /g, '%20')), [pathname, search]);
}
