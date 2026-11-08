/**
 * Dashboard snapshots: the bounded, structured summary of what a professional dashboard
 * shows (listings, tenancies, appraisal figures…) that an AI briefing is grounded in.
 *
 * The same shape is used for every dashboard so the briefing engine stays generic:
 *   { title, scope, asOf, metrics: [{label, value, unit}], items: [{id, label, group, fields, notes}], notes }
 * Limits keep requests cheap and predictable: at most 60 items with 16 scalar fields each,
 * short strings only, and about 24 000 characters in total.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const LIMITS = { items: 60, fieldsPerItem: 16, metrics: 24, notes: 10, itemNotes: 5, chars: 24_000 } as const;

const text = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters.`);
const num = z.number().min(-1e12).max(1e12);
const fieldKey = z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9_ ]*$/, 'Field names use letters, numbers and spaces.');
const scalar = z.union([num, text(160), z.boolean(), z.null()]);

export const SnapshotItem = z.strictObject({
  id: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'Item ids use letters, numbers, dots, colons and dashes.'),
  label: text(120).min(1, 'Every item needs a label.'),
  group: text(40).optional(),
  fields: z.record(fieldKey, scalar).refine((o) => Object.keys(o).length <= LIMITS.fieldsPerItem, `An item can have up to ${LIMITS.fieldsPerItem} fields.`).default({}),
  notes: z.array(text(200)).max(LIMITS.itemNotes, `Up to ${LIMITS.itemNotes} notes per item.`).default([]),
});

export const Metric = z.strictObject({
  label: text(80).min(1),
  value: z.union([num, text(80)]),
  unit: text(16).optional(),
});

export const Snapshot = z.strictObject({
  title: text(120).optional(),
  scope: text(240).optional(),
  asOf: text(40).optional(),
  metrics: z.array(Metric).max(LIMITS.metrics, `Up to ${LIMITS.metrics} headline figures.`).default([]),
  items: z.array(SnapshotItem).max(LIMITS.items, `A snapshot can include up to ${LIMITS.items} items.`).default([]),
  notes: z.array(text(240)).max(LIMITS.notes, `Up to ${LIMITS.notes} notes.`).default([]),
}).superRefine((s, ctx) => {
  if (!s.items.length && !s.metrics.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'The snapshot is empty: include at least one item or figure.' });
  const seen = new Set<string>();
  s.items.forEach((it, i) => {
    if (seen.has(it.id)) ctx.addIssue({ code: 'custom', path: ['items', i, 'id'], message: 'Item ids must be unique.' });
    seen.add(it.id);
  });
  if (JSON.stringify(s).length > LIMITS.chars) ctx.addIssue({ code: 'custom', path: ['_'], message: 'The snapshot is too large. Include fewer items or shorter notes.' });
});
export type SnapshotT = z.infer<typeof Snapshot>;
export type SnapshotItemT = z.infer<typeof SnapshotItem>;

/** JSON with object keys sorted, so equal snapshots always hash the same. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const hashOf = (v: unknown) => createHash('sha256').update(stableJson(v)).digest('hex');

/** Item ids in a snapshot (for checking the ids the model refers to). */
export const itemIds = (s: SnapshotT) => new Set(s.items.map((i) => i.id));

/** Shorten a string to a limit on a word boundary (for snapshots built on the server). */
export function clip(s: string | null | undefined, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), Math.floor(max * 0.6)))}…`;
}
