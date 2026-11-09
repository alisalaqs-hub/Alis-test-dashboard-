/**
 * Live-server state for the website: is a Streetkey server reachable, who is signed in,
 * and keeping saved homes / saved searches in step with the account.
 * With no server (static preview) everything stays local and the site runs in demo mode.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Property } from '../data/properties';
import { useStore, type RecentSearch } from '../store';
import { api, ApiError } from './api';
import type { HealthDTO, UserDTO } from './apiTypes';
import { dtoToProperty, isServerRef } from './listingAdapter';

interface ServerCtx {
  status: 'checking' | 'offline' | 'online';
  online: boolean;
  health: HealthDTO | null;
  user: UserDTO | null;
  setUser: (u: UserDTO | null) => void;
  signOut: () => Promise<void>;
  refreshListings: () => Promise<void>;
  /** Fetch one listing (e.g. a direct link) and make it available to every screen. */
  loadListing: (ref: string) => Promise<Property | null>;
}
const Ctx = createContext<ServerCtx | null>(null);

/**
 * Fired on `window` when the person using this tab changes: they signed out, or the session now
 * belongs to someone else (or no one). Anything kept in memory for one person (the Ask Streetkey
 * conversation, assistant answers) listens and forgets it.
 */
export const ACCOUNT_CHANGED_EVENT = 'streetkey:account-changed';
/**
 * sessionStorage keys starting with these hold one person's work in this tab: the Ask Streetkey
 * conversation (src/lib/ai/assistant.ts) and form drafts ('streetkey-draft:…': My Home, Estimator,
 * Investment, List a property, Studio). Cleared here as well as by each page, because a page only
 * hears ACCOUNT_CHANGED_EVENT once it has loaded in the tab.
 */
const PERSONAL_SESSION_PREFIXES = ['streetkey-ask', 'streetkey-draft:'];
/** Who the conversation in this tab belongs to: a user id, or '' for a visitor. */
const OWNER_KEY = 'streetkey-ask-owner';

/** Forgets this tab's per-person session state (the AI conversation, form drafts) and tells listeners. */
function forgetSession() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k && PERSONAL_SESSION_PREFIXES.some((x) => k.startsWith(x))) keys.push(k); }
    for (const k of keys) sessionStorage.removeItem(k);
  } catch { /* storage unavailable: nothing was kept */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
}
const readOwner = (): string | null => { try { return sessionStorage.getItem(OWNER_KEY); } catch { return null; } };
const writeOwner = (id: string) => { try { sessionStorage.setItem(OWNER_KEY, id); } catch { /* storage unavailable */ } };

/**
 * Saves a search to the account with the filters the person saw. If the server won't take those
 * filters (they no longer pass its checks), the words are saved without them rather than not at all:
 * alerts then read the words, as for searches saved before filters were kept.
 */
async function saveSearch(s: RecentSearch) {
  try {
    return await api.me.addSearch(s.q, s.mode, 'daily', s.filters ?? undefined);
  } catch (e) {
    if (s.filters && e instanceof ApiError && e.status === 400) return api.me.addSearch(s.q, s.mode, 'daily');
    throw e;
  }
}

export function ServerProvider({ children }: { children: ReactNode }) {
  const store = useStore();
  const [status, setStatus] = useState<ServerCtx['status']>('checking');
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [user, setUserState] = useState<UserDTO | null>(null);
  /**
   * True once the server has said who is signed in (GET /api/auth/me answered, or a sign-in,
   * sign-up or account change returned the user). Never true while the server can't be reached:
   * a network blip is not a sign-out, so it must not wipe anyone's conversation or saved homes.
   */
  const [known, setKnown] = useState(false);
  /** Every caller of setUser passes what the server just said (login, register, verify, profile, delete). */
  const setUser = useCallback((u: UserDTO | null) => { setUserState(u); setKnown(true); }, []);
  const searchIds = useRef(new Map<string, string>());
  const synced = useRef<{ saved: Set<string>; searches: Set<string> } | null>(null);
  const storeRef = useRef(store);
  storeRef.current = store;
  /** Listings fetched one by one (a link to one beyond the first page of results), kept across refreshes. */
  const loadedRefs = useRef(new Set<string>());

  /**
   * The first page of live listings. Ones loaded on their own that aren't on it are fetched again, so
   * they stay available (and up to date) for every screen; one that has gone (withdrawn, sold, no
   * longer visible to this account) is dropped. If it can't be checked right now, it is kept.
   */
  const refreshListings = useCallback(async () => {
    const r = await api.listings.search({ pageSize: 200 }).catch(() => null);
    if (!r) return;
    const page = r.items.map(dtoToProperty);
    const onPage = new Set(page.map((p) => p.id));
    const again = await Promise.all([...loadedRefs.current].filter((ref) => !onPage.has(ref)).map((ref) => api.listings.get(ref).then(
      (x) => dtoToProperty(x.listing),
      (e: unknown) => { if (e instanceof ApiError && [401, 403, 404, 410].includes(e.status)) loadedRefs.current.delete(ref); return null; },
    )));
    store.setServerListings([...page, ...again.filter((p): p is Property => !!p)], (p) => loadedRefs.current.has(p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** On sign-out or an account change: listings fetched one by one may be visible only to that account (their own drafts), so they go too. */
  const forgetLoaded = useCallback(() => {
    const gone = loadedRefs.current;
    if (!gone.size) return;
    loadedRefs.current = new Set();
    storeRef.current.setServerListings([], (p) => !gone.has(p.id));
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      const h = await api.health();
      if (!live) return;
      // Offline (static preview, or the server couldn't be reached): who is signed in stays unknown.
      if (!h) { setStatus('offline'); return; }
      setHealth(h); setStatus('online');
      // undefined = the request failed (network, 5xx): unknown, not signed out.
      const me = await api.auth.me().catch(() => undefined);
      if (live && me) setUser(me.user);
      await refreshListings();
    })();
    return () => { live = false; };
  }, [refreshListings, setUser]);

  // The AI conversation in this tab belongs to whoever was signed in when it was had. When that
  // account signs out, or the tab now has a different account (or none: an expired session), it is
  // forgotten, so the next person never sees it or sends it to the AI. A visitor keeps theirs on sign-in.
  // Only compared once the server has answered: while it is unknown the owner marker is never written.
  useEffect(() => {
    if (!known) return;
    const now = user?.id ?? '';
    const before = readOwner();
    if (before && before !== now) {
      forgetSession();
      storeRef.current.clearPersonal();
      forgetLoaded();
    }
    writeOwner(now);
  }, [known, user?.id, forgetLoaded]);

  // On sign-in: merge what was saved on this device into the account, then keep them in step.
  useEffect(() => {
    if (!user) { synced.current = null; return; }
    let live = true;
    (async () => {
      const merged = await api.me.mergeSaved(store.saved.filter((k) => /^[a-z0-9-]{2,80}$/i.test(k))).catch(() => null);
      const server = await api.me.searches().catch(() => null);
      if (!live || !merged || !server) return;
      const have = new Set(server.items.map((s) => `${s.mode}|${s.query}`));
      // Searches saved on this device (including any saved while this was loading), with their filters.
      for (const s of storeRef.current.savedSearches) if (!have.has(`${s.mode}|${s.q}`)) {
        const r = await saveSearch(s).catch(() => null);
        if (r) server.items.unshift(r.search);
      }
      searchIds.current = new Map(server.items.map((s) => [s.query, s.id]));
      const searches: RecentSearch[] = server.items.map((s) => ({ q: s.query, mode: s.mode, at: s.createdAt, filters: s.filters ?? null }));
      synced.current = { saved: new Set(merged.keys), searches: new Set(searches.map((s) => s.q)) };
      store.replaceSaved(merged.keys);
      store.replaceSavedSearches(searches);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    const s = synced.current; if (!user || !s) return;
    const now = new Set(store.saved);
    for (const k of now) if (!s.saved.has(k)) void api.me.save(k).catch(() => {});
    for (const k of s.saved) if (!now.has(k)) void api.me.unsave(k).catch(() => {});
    s.saved = now;
  }, [store.saved, user]);

  useEffect(() => {
    const s = synced.current; if (!user || !s) return;
    const now = new Set(store.savedSearches.map((x) => x.q));
    for (const x of store.savedSearches) if (!s.searches.has(x.q)) void saveSearch(x).then((r) => searchIds.current.set(x.q, r.search.id)).catch(() => {});
    for (const q of s.searches) if (!now.has(q)) { const id = searchIds.current.get(q); if (id) void api.me.removeSearch(id).catch(() => {}); }
    s.searches = now;
  }, [store.savedSearches, user]);

  const loadListing = useCallback(async (ref: string) => {
    if (!isServerRef(ref)) return null;
    const r = await api.listings.get(ref).catch(() => null);
    if (!r) return null;
    const p = dtoToProperty(r.listing);
    loadedRefs.current.add(p.id);
    store.addServerListing(p);
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sign-out ends the session, then forgets this person's conversation and everything personal kept on the device.
  const signOut = useCallback(async () => {
    await api.auth.logout().catch(() => {});
    forgetSession();
    writeOwner('');
    setUser(null);
    storeRef.current.clearPersonal();
    forgetLoaded();
  }, [setUser, forgetLoaded]);

  const value = useMemo<ServerCtx>(() => ({ status, online: status === 'online', health, user, setUser, signOut, refreshListings, loadListing }), [status, health, user, setUser, signOut, refreshListings, loadListing]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useServer() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useServer outside ServerProvider');
  return c;
}
