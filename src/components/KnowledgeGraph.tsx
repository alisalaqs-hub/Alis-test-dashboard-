import { useState } from 'react';
import type { Property } from '../data/properties';
import { estimateRefurb } from '../engine/refurb';
import { refurbInputFor } from '../engine/insights';
import { engagementFor, totals } from '../engine/engagement';

type Access = 'public' | 'verified' | 'owner/agent' | 'aggregated' | 'private';
const ACCESS_COLOUR: Record<Access, string> = { public: 'var(--blue)', verified: 'var(--sage)', 'owner/agent': 'var(--gold)', aggregated: 'var(--ai)', private: 'var(--danger)' };

/** Radial view of the property's node in the Brixo knowledge graph, with each edge's access level. */
export function KnowledgeGraph({ p }: { p: Property }) {
  const [hover, setHover] = useState<string | null>(null);
  const est = estimateRefurb(refurbInputFor(p));
  const eg = totals(engagementFor(p));
  const nodes: { id: string; label: string; detail: string; access: Access }[] = [
    { id: 'listing', label: 'Listing', detail: `${p.listing} · ${p.agent}`, access: 'public' },
    { id: 'chars', label: 'Characteristics', detail: `${p.type}, ${p.era}, ${p.floorArea}m², EPC ${p.epc.current}`, access: 'verified' },
    { id: 'comps', label: 'Comparables', detail: `${p.comparables.length} linked sales/lets`, access: 'public' },
    { id: 'planning', label: 'Planning', detail: `${p.planningNearby.length} nearby applications; constraint layers`, access: 'public' },
    { id: 'docs', label: 'Documents', detail: `${(p.documents ?? []).length} documents in vault`, access: 'owner/agent' },
    { id: 'refurb', label: 'Refurb estimate', detail: `£${Math.round(est.total / 1000)}k · ${est.basis.version}`, access: 'public' },
    { id: 'designs', label: 'Designs', detail: 'Saved concepts & material schedules', access: 'private' },
    { id: 'engagement', label: 'Engagement', detail: `${eg.views} views (aggregated, k≥10)`, access: 'aggregated' },
    { id: 'quotes', label: 'Quotes', detail: 'Contractor quotes vs standard scope', access: 'owner/agent' },
    { id: 'invest', label: 'Investment models', detail: 'Per-user scenarios', access: 'private' },
    { id: 'maint', label: 'Maintenance', detail: 'Works & certificate history', access: 'owner/agent' },
    { id: 'owner', label: 'Owner', detail: 'Identity never exposed to other users', access: 'private' },
    { id: 'txn', label: 'Transaction', detail: 'Offer → exchange → completion milestones', access: 'owner/agent' },
  ];
  const W = 520, H = 330, cx = W / 2, cy = H / 2;
  const pos = nodes.map((n, i) => { const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2; return { ...n, x: cx + Math.cos(a) * 205, y: cy + Math.sin(a) * 128 }; });
  const h = pos.find((n) => n.id === hover);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Property knowledge graph">
        {pos.map((n) => <line key={n.id} x1={cx} y1={cy} x2={n.x} y2={n.y} stroke={ACCESS_COLOUR[n.access]} strokeOpacity={hover && hover !== n.id ? 0.15 : 0.55} strokeWidth={hover === n.id ? 2.5 : 1.5} strokeDasharray={n.access === 'private' ? '4 3' : undefined} />)}
        <circle cx={cx} cy={cy} r={34} fill="var(--ink)" />
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--paper)" fontFamily="var(--sans)">UPRN · {p.district}</text>
        {pos.map((n) => (
          <g key={n.id} className="graph-node" onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => setHover(n.id)}>
            <circle cx={n.x} cy={n.y} r={7} fill={ACCESS_COLOUR[n.access]} />
            <text x={n.x} y={n.y + (n.y > cy ? 20 : -12)} textAnchor="middle" fontSize={11} fill="var(--ink)" fontFamily="var(--sans)" fontWeight={hover === n.id ? 700 : 500}>{n.label}</text>
          </g>
        ))}
      </svg>
      <div className="small" style={{ minHeight: 22 }}>{h ? <><b>{h.label}</b> — {h.detail} · <span style={{ color: ACCESS_COLOUR[h.access] }}>{h.access}</span></> : <span className="muted">Hover a node to see what is linked and who can see it.</span>}</div>
      <div className="row xs" style={{ gap: 12, marginTop: 6 }}>{(Object.keys(ACCESS_COLOUR) as Access[]).map((a) => <span key={a} className="row" style={{ gap: 4 }}><i style={{ width: 9, height: 9, borderRadius: 9, background: ACCESS_COLOUR[a], display: 'inline-block' }} />{a}</span>)}</div>
    </div>
  );
}
