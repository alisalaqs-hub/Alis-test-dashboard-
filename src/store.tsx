/** Client-side app state (saved properties, comparison set, designs, approvals, audit log).
 *  Persisted to localStorage when available; production stores these server-side per user. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ProposedAction } from './ai/agents';

export interface SavedDesign { id: string; propertyId: string; room: string; style: string; budget: number; total: number; createdAt: string }
export interface AuditEntry { at: string; actor: string; action: string; detail: string }
export interface Viewing { id: string; propertyId: string; slot: string; status: 'requested' }

interface State { saved: string[]; compare: string[]; designs: SavedDesign[]; queue: ProposedAction[]; audit: AuditEntry[]; viewings: Viewing[] }
const EMPTY: State = { saved: [], compare: [], designs: [], queue: [], audit: [], viewings: [] };
const KEY = 'brixo-state-v1';

function load(): State { try { const raw = localStorage.getItem(KEY); return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY; } catch { return EMPTY; } }

interface Ctx extends State {
  toggleSaved: (id: string) => void;
  toggleCompare: (id: string) => void;
  saveDesign: (d: Omit<SavedDesign, 'id' | 'createdAt'>) => void;
  enqueue: (a: ProposedAction[]) => void;
  decide: (id: string, approved: boolean, actor?: string) => void;
  log: (actor: string, action: string, detail: string) => void;
  requestViewing: (propertyId: string, slot: string) => void;
}
const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, set] = useState<State>(load);
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
    requestViewing: (propertyId, slot) => set((x) => ({ ...x, viewings: [...x.viewings, { id: `v${Date.now()}`, propertyId, slot, status: 'requested' }], audit: [{ at: new Date().toISOString(), actor: 'you', action: 'viewing requested', detail: `${propertyId} · ${slot}` }, ...x.audit] })),
  }), [s, log]);
  return <StoreCtx.Provider value={api}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const c = useContext(StoreCtx);
  if (!c) throw new Error('useStore outside provider');
  return c;
}
