/** Client-side app state (saved properties, comparison set, designs, approvals, audit log).
 *  Persisted to localStorage when available; production stores these server-side per user. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ProposedAction } from './ai/agents';
import { baseListings, setDynamicListings, type Property } from './data/properties';
import { dedupe } from './engine/listings';

export interface SavedDesign { id: string; propertyId: string; room: string; style: string; budget: number; total: number; createdAt: string }
export interface AuditEntry { at: string; actor: string; action: string; detail: string }
export interface Viewing { id: string; propertyId: string; slot: string; status: 'requested' }
export interface RecentSearch { q: string; mode: string; at: string }

interface State { saved: string[]; compare: string[]; designs: SavedDesign[]; queue: ProposedAction[]; audit: AuditEntry[]; viewings: Viewing[]; recent: RecentSearch[]; savedSearches: RecentSearch[]; myListings: Property[]; feedListings: Property[]; tracked: Property[] }
const EMPTY: State = { saved: [], compare: [], designs: [], queue: [], audit: [], viewings: [], recent: [], savedSearches: [], myListings: [], feedListings: [], tracked: [] };
const KEY = 'streetkey-state-v1';

function load(): State { try { const raw = localStorage.getItem(KEY); return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY; } catch { return EMPTY; } }

interface Ctx extends State {
  toggleSaved: (id: string) => void;
  toggleCompare: (id: string) => void;
  saveDesign: (d: Omit<SavedDesign, 'id' | 'createdAt'>) => void;
  enqueue: (a: ProposedAction[]) => void;
  decide: (id: string, approved: boolean, actor?: string) => void;
  log: (actor: string, action: string, detail: string) => void;
  requestViewing: (propertyId: string, slot: string) => void;
  addRecent: (q: string, mode: string) => void;
  toggleSavedSearch: (q: string, mode: string) => void;
  publishListing: (p: Property) => void;
  setListingStatus: (id: string, status: Property['status']) => void;
  ingestFeed: (agent: string, list: Property[]) => void;
  removeFeed: (agent: string) => void;
  trackListing: (p: Property) => void;
  untrack: (id: string) => void;
}
const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, set] = useState<State>(load);
  // Register dynamic listings into the shared registry during render so every screen sees them.
  useMemo(() => {
    const base = baseListings();
    base.forEach((b) => { b.alsoListedBy = undefined; });
    const dynamic = [...s.myListings, ...s.feedListings, ...s.tracked].map((p) => ({ ...p, alsoListedBy: undefined }));
    const { merged } = dedupe([...base, ...dynamic.filter((p) => p.visibility !== 'private')]);
    const ids = new Set(base.map((b) => b.id));
    setDynamicListings([...merged.filter((p) => !ids.has(p.id)), ...dynamic.filter((p) => p.visibility === 'private')]);
  }, [s.myListings, s.feedListings, s.tracked]);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } }, [s]);
  const log = useCallback((actor: string, action: string, detail: string) => set((x) => ({ ...x, audit: [{ at: new Date().toISOString(), actor, action, detail }, ...x.audit].slice(0, 200) })), []);
  const api = useMemo<Ctx>(() => ({
    ...s,
    toggleSaved: (id) => set((x) => ({ ...x, saved: x.saved.includes(id) ? x.saved.filter((y) => y !== id) : [...x.saved, id] })),
    toggleCompare: (id) => set((x) => ({ ...x, compare: x.compare.includes(id) ? x.compare.filter((y) => y !== id) : [...x.compare, id].slice(-3) })),
    saveDesign: (d) => set((x) => ({ ...x, designs: [{ ...d, id: `d${Date.now()}`, createdAt: new Date().toISOString() }, ...x.designs].slice(0, 20) })),
    enqueue: (a) => set((x) => ({ ...x, queue: [...a.filter((n) => n.consequential), ...x.queue].slice(0, 50), audit: [...a.map((n) => ({ at: new Date().toISOString(), actor: `agent:${n.agent}`, action: n.consequential ? 'proposed (awaiting approval)' : 'completed (non-consequential)', detail: n.title })), ...x.audit].slice(0, 200) })),
    decide: (id, approved, actor = 'you') => set((x) => { const a = x.queue.find((q) => q.id === id); return { ...x, queue: x.queue.filter((q) => q.id !== id), audit: a ? [{ at: new Date().toISOString(), actor, action: approved ? 'approved' : 'rejected', detail: a.title }, ...x.audit] : x.audit }; }),
    log,
    addRecent: (q, mode) => set((x) => ({ ...x, recent: [{ q, mode, at: new Date().toISOString() }, ...x.recent.filter((r) => r.q.toLowerCase() !== q.toLowerCase())].slice(0, 6) })),
    toggleSavedSearch: (q, mode) => set((x) => ({ ...x, savedSearches: x.savedSearches.some((r) => r.q === q) ? x.savedSearches.filter((r) => r.q !== q) : [{ q, mode, at: new Date().toISOString() }, ...x.savedSearches].slice(0, 20) })),
    publishListing: (p) => set((x) => ({ ...x, myListings: [p, ...x.myListings.filter((m) => m.id !== p.id)], audit: [{ at: new Date().toISOString(), actor: 'you', action: 'listing published', detail: p.title }, ...x.audit] })),
    setListingStatus: (id, status) => set((x) => ({ ...x, myListings: x.myListings.map((m) => (m.id === id ? { ...m, status } : m)) })),
    ingestFeed: (agent, list) => set((x) => ({ ...x, feedListings: [...x.feedListings.filter((f) => f.source?.name !== `${agent} (agent feed)`), ...list], audit: [{ at: new Date().toISOString(), actor: `feed:${agent}`, action: 'feed ingested', detail: `${list.length} listings` }, ...x.audit] })),
    removeFeed: (agent) => set((x) => ({ ...x, feedListings: x.feedListings.filter((f) => f.source?.name !== `${agent} (agent feed)`) })),
    trackListing: (p) => set((x) => ({ ...x, tracked: [p, ...x.tracked.filter((t) => t.id !== p.id)].slice(0, 30) })),
    untrack: (id) => set((x) => ({ ...x, tracked: x.tracked.filter((t) => t.id !== id) })),
    requestViewing: (propertyId, slot) => set((x) => ({ ...x, viewings: [...x.viewings, { id: `v${Date.now()}`, propertyId, slot, status: 'requested' }], audit: [{ at: new Date().toISOString(), actor: 'you', action: 'viewing requested', detail: `${propertyId} · ${slot}` }, ...x.audit] })),
  }), [s, log]);
  return <StoreCtx.Provider value={api}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const c = useContext(StoreCtx);
  if (!c) throw new Error('useStore outside provider');
  return c;
}
