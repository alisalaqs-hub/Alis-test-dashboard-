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

export function ServerProvider({ children }: { children: ReactNode }) {
  const store = useStore();
  const [status, setStatus] = useState<ServerCtx['status']>('checking');
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [user, setUser] = useState<UserDTO | null>(null);
  const searchIds = useRef(new Map<string, string>());
  const synced = useRef<{ saved: Set<string>; searches: Set<string> } | null>(null);

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
      if (!h) { setStatus('offline'); return; }
      setHealth(h); setStatus('online');
      const me = await api.auth.me().catch(() => ({ user: null }));
      if (live) setUser(me.user);
      await refreshListings();
    })();
    return () => { live = false; };
  }, [refreshListings]);

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

  const signOut = useCallback(async () => { await api.auth.logout().catch(() => {}); setUser(null); }, []);

  const value = useMemo<ServerCtx>(() => ({ status, online: status === 'online', health, user, setUser, signOut, refreshListings, loadListing }), [status, health, user, signOut, refreshListings, loadListing]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useServer() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useServer outside ServerProvider');
  return c;
}
