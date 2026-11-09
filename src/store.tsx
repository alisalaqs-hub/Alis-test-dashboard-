/** Client-side app state (saved properties, comparison set, designs, approvals, audit log).
 *  Persisted to localStorage when available; production stores these server-side per user. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { mergeQueue, QUEUE_CAP, type ProposedAction } from './ai/agents';
import { baseListings, setDynamicListings, type Property } from './data/properties';
import { dedupe } from './engine/listings';
import type { SavedSearchFilters } from './lib/ai/search';

export interface SavedDesign { id: string; propertyId: string; room: string; style: string; budget: number; total: number; createdAt: string }
export interface AuditEntry { at: string; actor: string; action: string; detail: string }
export interface Viewing { id: string; propertyId: string; slot: string; status: 'requested' }
export interface RecentSearch {
  q: string; mode: string; at: string;
  /** Saved searches: the filters the person saw (after removing chips and setting page filters), so alerts run exactly that search. */
  filters?: SavedSearchFilters | null;
}

interface State { saved: string[]; compare: string[]; designs: SavedDesign[]; queue: ProposedAction[]; audit: AuditEntry[]; viewings: Viewing[]; recent: RecentSearch[]; savedSearches: RecentSearch[]; myListings: Property[]; feedListings: Property[]; tracked: Property[]; serverListings: Property[] }
const EMPTY: State = { saved: [], compare: [], designs: [], queue: [], audit: [], viewings: [], recent: [], savedSearches: [], myListings: [], feedListings: [], tracked: [], serverListings: [] };
const KEY = 'streetkey-state-v1';

function load(): State { try { const raw = localStorage.getItem(KEY); return raw ? { ...EMPTY, ...JSON.parse(raw), serverListings: [] } : EMPTY; } catch { return EMPTY; } }

interface Ctx extends State {
  toggleSaved: (id: string) => void;
  toggleCompare: (id: string) => void;
  saveDesign: (d: Omit<SavedDesign, 'id' | 'createdAt'>) => void;
  /**
   * Send proposals to the approval queue. Only consequential ones are queued; one that is already
   * waiting isn't queued twice, and when the queue is full new ones are turned away (with an audit
   * entry) instead of older pending ones being dropped. Returns what happened to each.
   */
  enqueue: (a: ProposedAction[]) => EnqueueResult;
  decide: (id: string, approved: boolean, actor?: string) => void;
  log: (actor: string, action: string, detail: string) => void;
  requestViewing: (propertyId: string, slot: string) => void;
  addRecent: (q: string, mode: string) => void;
  /** Saves the search (with the filters shown, when given) or, if it is already saved, removes it. */
  toggleSavedSearch: (q: string, mode: string, filters?: SavedSearchFilters | null) => void;
  publishListing: (p: Property) => void;
  setListingStatus: (id: string, status: Property['status']) => void;
  ingestFeed: (agent: string, list: Property[]) => void;
  removeFeed: (agent: string) => void;
  trackListing: (p: Property) => void;
  untrack: (id: string) => void;
  /**
   * Listings from the Streetkey server (live site only; never stored on the device). Replaces the
   * current ones, except those `keep` returns true for that aren't in `list`.
   */
  setServerListings: (list: Property[], keep?: (p: Property) => boolean) => void;
  addServerListing: (p: Property) => void;
  replaceSaved: (keys: string[]) => void;
  replaceSavedSearches: (list: RecentSearch[]) => void;
  /**
   * Forget everything personal kept in this browser (saved homes and searches, recent searches,
   * designs, viewings, listings, tracked and feed listings, the approval queue and audit log), so the
   * next person on the device sees none of it. Call on sign-out, after the session has ended and
   * the user is cleared (the account's own copies stay on the server and come back at sign-in).
   */
  clearPersonal: () => void;
}
export interface EnqueueResult { added: string[]; duplicates: string[]; full: string[] }
const StoreCtx = createContext<Ctx | null>(null);

const idsOf = (xs: ProposedAction[]) => xs.map((x) => x.id);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, set] = useState<State>(load);
  // The queue as of the latest change, so enqueue() can report what it did even when it is called
  // several times before React re-renders (the state itself is always updated functionally).
  const queueRef = useRef(s.queue);
  useEffect(() => { queueRef.current = s.queue; }, [s.queue]);
  // Register dynamic listings into the shared registry during render so every screen sees them.
  useMemo(() => {
    const base = baseListings();
    base.forEach((b) => { b.alsoListedBy = undefined; });
    const dynamic = [...s.serverListings, ...s.myListings, ...s.feedListings, ...s.tracked].map((p) => ({ ...p, alsoListedBy: undefined }));
    const { merged, duplicates } = dedupe([...base, ...dynamic.filter((p) => p.visibility !== 'private')]);
    const ids = new Set(base.map((b) => b.id));
    // A listing merged into another one for the same home stays out of every list, but its own reference still finds it.
    const dropped = new Set(duplicates.map((d) => d.dropped));
    const hidden = dynamic.filter((p) => dropped.has(p.id)).map((p) => ({ ...p, alsoListedBy: undefined }));
    setDynamicListings([...merged.filter((p) => !ids.has(p.id)), ...dynamic.filter((p) => p.visibility === 'private')], hidden);
  }, [s.serverListings, s.myListings, s.feedListings, s.tracked]);
  useEffect(() => { try { const { serverListings: _skip, ...keep } = s; void _skip; localStorage.setItem(KEY, JSON.stringify(keep)); } catch { /* storage unavailable */ } }, [s]);
  const log = useCallback((actor: string, action: string, detail: string) => set((x) => ({ ...x, audit: [{ at: new Date().toISOString(), actor, action, detail }, ...x.audit].slice(0, 200) })), []);
  const api = useMemo<Ctx>(() => ({
    ...s,
    toggleSaved: (id) => set((x) => ({ ...x, saved: x.saved.includes(id) ? x.saved.filter((y) => y !== id) : [...x.saved, id] })),
    toggleCompare: (id) => set((x) => ({ ...x, compare: x.compare.includes(id) ? x.compare.filter((y) => y !== id) : [...x.compare, id].slice(-3) })),
    saveDesign: (d) => set((x) => ({ ...x, designs: [{ ...d, id: `d${Date.now()}`, createdAt: new Date().toISOString() }, ...x.designs].slice(0, 20) })),
    enqueue: (a) => {
      const preview = mergeQueue(queueRef.current, a);
      queueRef.current = preview.queue;
      set((x) => {
        const m = mergeQueue(x.queue, a);
        const at = new Date().toISOString();
        const entry = (n: ProposedAction, action: string): AuditEntry => ({ at, actor: `agent:${n.agent}`, action, detail: n.title });
        // In the order the proposals arrived, newest first like the rest of the log.
        const notes = a.map((n) => (m.added.includes(n) ? entry(n, 'proposed (awaiting approval)')
          : m.duplicates.includes(n) ? entry(n, 'not queued (already awaiting approval)')
          : m.full.includes(n) ? entry(n, `not queued (approval queue full: ${QUEUE_CAP} waiting)`)
          : entry(n, 'completed (non-consequential)'))).reverse();
        return { ...x, queue: m.queue, audit: [...notes, ...x.audit].slice(0, 200) };
      });
      return { added: idsOf(preview.added), duplicates: idsOf(preview.duplicates), full: idsOf(preview.full) };
    },
    decide: (id, approved, actor = 'you') => set((x) => { const a = x.queue.find((q) => q.id === id); return { ...x, queue: x.queue.filter((q) => q.id !== id), audit: a ? [{ at: new Date().toISOString(), actor, action: approved ? 'approved' : 'rejected', detail: a.title }, ...x.audit] : x.audit }; }),
    clearPersonal: () => { queueRef.current = []; set((x) => ({ ...EMPTY, serverListings: x.serverListings })); },
    log,
    addRecent: (q, mode) => set((x) => ({ ...x, recent: [{ q, mode, at: new Date().toISOString() }, ...x.recent.filter((r) => r.q.toLowerCase() !== q.toLowerCase())].slice(0, 6) })),
    toggleSavedSearch: (q, mode, filters) => set((x) => ({ ...x, savedSearches: x.savedSearches.some((r) => r.q === q) ? x.savedSearches.filter((r) => r.q !== q) : [{ q, mode, at: new Date().toISOString(), ...(filters ? { filters } : {}) }, ...x.savedSearches].slice(0, 20) })),
    publishListing: (p) => set((x) => ({ ...x, myListings: [p, ...x.myListings.filter((m) => m.id !== p.id)], audit: [{ at: new Date().toISOString(), actor: 'you', action: 'listing published', detail: p.title }, ...x.audit] })),
    setListingStatus: (id, status) => set((x) => ({ ...x, myListings: x.myListings.map((m) => (m.id === id ? { ...m, status } : m)) })),
    ingestFeed: (agent, list) => set((x) => ({ ...x, feedListings: [...x.feedListings.filter((f) => f.source?.name !== `${agent} (agent feed)`), ...list], audit: [{ at: new Date().toISOString(), actor: `feed:${agent}`, action: 'feed ingested', detail: `${list.length} listings` }, ...x.audit] })),
    removeFeed: (agent) => set((x) => ({ ...x, feedListings: x.feedListings.filter((f) => f.source?.name !== `${agent} (agent feed)`) })),
    trackListing: (p) => set((x) => ({ ...x, tracked: [p, ...x.tracked.filter((t) => t.id !== p.id)].slice(0, 30) })),
    untrack: (id) => set((x) => ({ ...x, tracked: x.tracked.filter((t) => t.id !== id) })),
    setServerListings: (list, keep) => set((x) => {
      if (!keep) return { ...x, serverListings: list };
      const ids = new Set(list.map((p) => p.id));
      return { ...x, serverListings: [...list, ...x.serverListings.filter((p) => !ids.has(p.id) && keep(p))] };
    }),
    addServerListing: (p) => set((x) => ({ ...x, serverListings: [p, ...x.serverListings.filter((y) => y.id !== p.id)] })),
    replaceSaved: (keys) => set((x) => ({ ...x, saved: keys })),
    replaceSavedSearches: (list) => set((x) => ({ ...x, savedSearches: list })),
    requestViewing: (propertyId, slot) => set((x) => ({ ...x, viewings: [...x.viewings, { id: `v${Date.now()}`, propertyId, slot, status: 'requested' }], audit: [{ at: new Date().toISOString(), actor: 'you', action: 'viewing requested', detail: `${propertyId} · ${slot}` }, ...x.audit] })),
  }), [s, log]);
  return <StoreCtx.Provider value={api}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const c = useContext(StoreCtx);
  if (!c) throw new Error('useStore outside provider');
  return c;
}
