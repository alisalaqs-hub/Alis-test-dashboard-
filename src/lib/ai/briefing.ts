/**
 * Website side of AI briefings (agent, landlord and developer dashboards) and AI agent
 * proposals (automation page). Dashboards send a bounded snapshot of what they show; the
 * server's AI explains and prioritises it, and statements whose £/% figures don't match a
 * figure of the same kind in that snapshot are removed. Without a server or with AI off,
 * pages keep their rule-based views.
 */
import type { ProposedAction } from '../../ai/agents';
import { ApiError } from '../api';
import { aiPost, pollJob, type AiJob } from './core';

export type BriefingKind = 'agent' | 'landlord' | 'developer' | 'my-agency';
export type Scalar = number | string | boolean | null;
export interface SnapshotItem { id: string; label: string; group?: string; fields?: Record<string, Scalar>; notes?: string[] }
export interface SnapshotMetric { label: string; value: number | string; unit?: string }
export interface BriefingSnapshot { title?: string; scope?: string; asOf?: string; metrics?: SnapshotMetric[]; items: SnapshotItem[]; notes?: string[] }

export interface BriefingPriority { title: string; why: string; action: string; impact: 'high' | 'medium' | 'low'; relatedIds: string[] }
export interface Briefing {
  kind: BriefingKind;
  headline: string;
  summary: string;
  priorities: BriefingPriority[];
  risks: string[];
  opportunities: string[];
  questions: string[];
  labels: Record<string, string>;
  /** dropped: removed because a £/% figure wasn't in the data; withheld: removed under the content rules. */
  grounding: { checked: number; dropped: number; withheld?: number };
  source: 'dashboard' | 'live';
  generatedAt: string;
}

export interface AiProposal { id: string; agent: string; title: string; detail: string; consequential: boolean; rationale: string }
export interface AutomationResult {
  agent: string; basis: 'demo' | 'demo+context'; cached: boolean;
  findings: string[]; toolsCalled: string[]; proposals: AiProposal[]; grounding: { checked: number; dropped: number; withheld?: number };
  /** Proposals left out because the same one is already waiting in the approval queue. */
  alreadyWaiting?: number;
}

/** The server's limits (server/src/ai/briefing/snapshot.ts). */
export const SNAPSHOT_LIMITS = { items: 60, fields: 16, metrics: 24, notes: 10, itemNotes: 5, chars: 40_000 } as const;

const clip = (s: unknown, max: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= max ? t : `${t.slice(0, max - 1)}…`; };
const cleanNum = (n: number) => (Number.isFinite(n) ? Math.max(-1e12, Math.min(1e12, Math.round(n * 1e4) / 1e4)) : null);
const cleanId = (s: string) => (clip(s, 40).replace(/[^A-Za-z0-9_.:-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'item').slice(0, 40);
const cleanKey = (s: string) => (s.replace(/[^A-Za-z0-9_ ]/g, ' ').replace(/^[^A-Za-z]+/, '').trim() || 'value').slice(0, 40);
const scalar = (v: Scalar): Scalar => (typeof v === 'number' ? cleanNum(v) : typeof v === 'string' ? clip(v, 160) : v);

/** Trim a snapshot to the server's limits, so a large dashboard never fails validation. */
export function boundSnapshot(s: BriefingSnapshot): BriefingSnapshot {
  const seen = new Set<string>();
  const items = s.items.flatMap((it) => {
    let id = cleanId(it.id);
    for (let n = 2; seen.has(id); n++) id = `${cleanId(it.id).slice(0, 36)}-${n}`;
    seen.add(id);
    const fields = Object.fromEntries(Object.entries(it.fields ?? {}).filter(([, v]) => v !== undefined).slice(0, SNAPSHOT_LIMITS.fields).map(([k, v]) => [cleanKey(k), scalar(v)]));
    return [{ id, label: clip(it.label, 120) || id, ...(it.group ? { group: clip(it.group, 40) } : {}), fields, notes: (it.notes ?? []).map((n) => clip(n, 200)).filter(Boolean).slice(0, SNAPSHOT_LIMITS.itemNotes) }];
  }).slice(0, SNAPSHOT_LIMITS.items);
  const out: BriefingSnapshot = {
    ...(s.title ? { title: clip(s.title, 120) } : {}), ...(s.scope ? { scope: clip(s.scope, 240) } : {}), ...(s.asOf ? { asOf: clip(s.asOf, 40) } : {}),
    metrics: (s.metrics ?? []).slice(0, SNAPSHOT_LIMITS.metrics).map((m) => ({ label: clip(m.label, 80) || 'Figure', value: typeof m.value === 'number' ? cleanNum(m.value) ?? 0 : clip(m.value, 80), ...(m.unit ? { unit: clip(m.unit, 16) } : {}) })),
    items, notes: (s.notes ?? []).map((n) => clip(n, 240)).filter(Boolean).slice(0, SNAPSHOT_LIMITS.notes),
  };
  while (out.items.length > 1 && JSON.stringify(out).length > SNAPSHOT_LIMITS.chars - 200) out.items = out.items.slice(0, -1);
  return out;
}

type BriefingOptions = { onProgress?: (job: AiJob<Briefing>) => void; signal?: AbortSignal };

/**
 * Ask for a briefing, and say whether it came from the cache (the server keeps each briefing for an
 * hour while the figures don't change). Resolves immediately when cached; otherwise follows the job.
 */
export async function fetchBriefing(kind: BriefingKind, snapshot: BriefingSnapshot | null, o: BriefingOptions = {}): Promise<{ briefing: Briefing; cached: boolean }> {
  const body = kind === 'my-agency' ? { kind } : { kind, snapshot: boundSnapshot(snapshot ?? { items: [] }) };
  const r = await aiPost<{ briefing: Briefing | null; jobId: string | null; cached: boolean }>('/api/ai/briefing', body, 30_000);
  if (o.signal?.aborted) throw new ApiError(0, 'Cancelled.', 'cancelled');
  if (r.briefing) return { briefing: r.briefing, cached: r.cached };
  if (!r.jobId) throw new ApiError(502, 'The AI couldn’t write a briefing just now. Please try again.', 'ai_failed');
  return { briefing: await pollJob<Briefing>(r.jobId, { onProgress: o.onProgress, signal: o.signal, timeoutMs: 3 * 60_000 }), cached: false };
}

/** Ask for a briefing. Resolves immediately when cached; otherwise follows the background job. */
export async function requestBriefing(kind: BriefingKind, snapshot: BriefingSnapshot | null, o: BriefingOptions = {}): Promise<Briefing> {
  return (await fetchBriefing(kind, snapshot, o)).briefing;
}

/** Ask the AI what an agent should do next, from the agent's deterministic findings. Nothing is executed. */
export const runAgentWithAi = (agent: string, context?: BriefingSnapshot | null) =>
  aiPost<AutomationResult>('/api/ai/automation/run', context && context.items.length ? { agent, context: boundSnapshot(context) } : { agent }, 45_000);

/**
 * The AI proposals that need approval, in the approval queue's ProposedAction shape. The
 * others are suggestions only: they are never queued, because the store records queued
 * non-consequential actions as completed, and nothing an AI suggests is ever carried out.
 */
export function toProposedActions(r: AutomationResult): ProposedAction[] {
  return r.proposals.filter((p) => p.consequential).map((p) => ({
    id: p.id, agent: p.agent, title: p.title, consequential: p.consequential,
    detail: `AI proposal: ${p.detail}`,
    payload: `Why Streetkey AI suggests this\n${p.rationale}\n\nAI-generated from the agent’s findings. Nothing has been sent, booked or changed: approving records your decision.`,
  }));
}

/** A snapshot of the proposals already waiting for approval, so AI runs don't repeat them. */
export function queueContext(queue: ProposedAction[], agent: string): BriefingSnapshot | null {
  const mine = queue.filter((q) => q.agent === agent).slice(0, 20);
  if (!mine.length) return null;
  return { title: 'Proposals already awaiting approval', items: mine.map((q) => ({ id: q.id, label: q.title, group: 'awaiting approval', fields: { consequential: q.consequential } })) };
}

/** Stable text form of a snapshot, to tell when the dashboard has changed since a briefing. */
export const snapshotKey = (s: BriefingSnapshot | null) => (s ? JSON.stringify(boundSnapshot(s)) : '');
