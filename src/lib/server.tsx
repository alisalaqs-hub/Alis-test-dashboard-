/**
 * Live-server state for the website: is a Streetkey server reachable, who is signed in,
 * and keeping saved homes / saved searches in step with the account.
 * With no server (static preview) everything stays local and the site runs in demo mode.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Property } from '../data/properties';
import { useStore, type RecentSearch } from '../store';
import { api } from './api';
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
/** sessionStorage keys starting with this hold one person's Ask Streetkey conversation (src/lib/ai/assistant.ts). */
const PERSONAL_SESSION_PREFIX = 'streetkey-ask';
/** Who the conversation in this tab belongs to: a user id, or '' for a visitor. */
const OWNER_KEY = 'streetkey-ask-owner';

/** Forgets this tab's per-person session state (the AI conversation) and tells listeners. */
function forgetSession() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k?.startsWith(PERSONAL_SESSION_PREFIX)) keys.push(k); }
    for (const k of keys) sessionStorage.removeItem(k);
  } catch { /* storage unavailable: nothing was kept */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
}
const readOwner = (): string | null => { try { return sessionStorage.getItem(OWNER_KEY); } catch { return null; } };
const writeOwner = (id: string) => { try { sessionStorage.setItem(OWNER_KEY, id); } catch { /* storage unavailable */ } };

export function ServerProvider({ children }: { children: ReactNode }) {
  const store = useStore();
  const [status, setStatus] = useState<ServerCtx['status']>('checking');
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [user, setUser] = useState<UserDTO | null>(null);
  /** True once we know who is signed in (or that there is no server). */
  const [known, setKnown] = useState(false);
  const searchIds = useRef(new Map<string, string>());
  const synced = useRef<{ saved: Set<string>; searches: Set<string> } | null>(null);
  const storeRef = useRef(store);
  storeRef.current = store;

  const refreshListings = useCallback(async () => {
    const r = await api.listings.search({ pageSize: 200 }).catch(() => null);
    if (r) store.setServerListings(r.items.map(dtoToProperty));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      const h = await api.health();
      if (!live) return;
      if (!h) { setStatus('offline'); setKnown(true); return; }
      setHealth(h); setStatus('online');
      const me = await api.auth.me().catch(() => ({ user: null }));
      if (live) { setUser(me.user); setKnown(true); }
      await refreshListings();
    })();
    return () => { live = false; };
  }, [refreshListings]);

  // The AI conversation in this tab belongs to whoever was signed in when it was had. When that
  // account signs out, or the tab now has a different account (or none: an expired session), it is
  // forgotten, so the next person never sees it or sends it to the AI. A visitor keeps theirs on sign-in.
  useEffect(() => {
    if (!known) return;
    const now = user?.id ?? '';
    const before = readOwner();
    if (before && before !== now) {
      forgetSession();
      storeRef.current.clearPersonal();
    }
    writeOwner(now);
  }, [known, user?.id]);

  // On sign-in: merge what was saved on this device into the account, then keep them in step.
  useEffect(() => {
    if (!user) { synced.current = null; return; }
    let live = true;
    (async () => {
      const merged = await api.me.mergeSaved(store.saved.filter((k) => /^[a-z0-9-]{2,80}$/i.test(k))).catch(() => null);
      const server = await api.me.searches().catch(() => null);
      if (!live || !merged || !server) return;
      const have = new Set(server.items.map((s) => `${s.mode}|${s.query}`));
      for (const s of store.savedSearches) if (!have.has(`${s.mode}|${s.q}`)) {
        const r = await api.me.addSearch(s.q, s.mode).catch(() => null);
        if (r) server.items.unshift(r.search);
      }
      searchIds.current = new Map(server.items.map((s) => [s.query, s.id]));
      const searches: RecentSearch[] = server.items.map((s) => ({ q: s.query, mode: s.mode, at: s.createdAt }));
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
    for (const x of store.savedSearches) if (!s.searches.has(x.q)) void api.me.addSearch(x.q, x.mode).then((r) => searchIds.current.set(x.q, r.search.id)).catch(() => {});
    for (const q of s.searches) if (!now.has(q)) { const id = searchIds.current.get(q); if (id) void api.me.removeSearch(id).catch(() => {}); }
    s.searches = now;
  }, [store.savedSearches, user]);

  const loadListing = useCallback(async (ref: string) => {
    if (!isServerRef(ref)) return null;
    const r = await api.listings.get(ref).catch(() => null);
    if (!r) return null;
    const p = dtoToProperty(r.listing);
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
  }, []);

  const value = useMemo<ServerCtx>(() => ({ status, online: status === 'online', health, user, setUser, signOut, refreshListings, loadListing }), [status, health, user, signOut, refreshListings, loadListing]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useServer() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useServer outside ServerProvider');
  return c;
}
