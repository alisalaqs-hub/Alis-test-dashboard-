import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PROPERTIES, photosFor, type Property } from '../data/properties';
import { benchmark, engagementFor, insightsFor, totals } from '../engine/engagement';
import { dealScore } from '../engine/insights';
import { weeklyOwnerReport } from '../engine/reports';
import { agentSkills } from '../ai/skills';
import { AssistantPanel } from '../components/Assistant';
import { gbpK, pct, Section, Stat, Tag } from '../components/ui';
import { useStore } from '../store';

const BRANCH = PROPERTIES.filter((p) => p.listing !== 'rent' && p.type !== 'commercial');
const street = (p: Property) => p.street.replace(' (fictional)', '');

/** Listing quality: completeness of information buyers need (deterministic checklist). */
export function listingQuality(p: Property) {
  const checks = [
    { item: '6+ photos', ok: photosFor(p).length >= 6 },
    { item: 'Floor plan', ok: true },
    { item: 'EPC uploaded', ok: (p.documents ?? []).some((d) => /EPC/.test(d)) },
    { item: 'Material information complete', ok: !!p.councilTax && !!p.tenure && (p.tenure !== 'leasehold' || p.serviceChargeAnnual != null) },
    { item: 'Description ≥ 3 features', ok: p.features.length >= 3 },
    { item: 'Renovation concept / costing shown', ok: false },
    { item: 'Lead photo performing', ok: !insightsFor(p).some((i) => i.id === 'photo-test') },
  ];
  return { score: Math.round((checks.filter((c) => c.ok).length / checks.length) * 100), checks };
}

const FEEDBACK: Record<string, string[]> = {
  'wal-001': ['Loved the period features and garden (4 of 6 viewings)', 'Worried about the cost of works and damp in the rear reception (5 of 6)', 'Felt price high relative to work needed (3 of 6)'],
  'cro-002': ['Liked the driveway and garden', 'Concern about subsidence history'],
  'cro-013': ['Developers interested in conversion; families put off by condition'],
};

export default function Agent() {
  const { queue, enqueue, decide, audit } = useStore();
  const [preview, setPreview] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'gap' | 'views' | 'quality'>('gap');
  const rows = useMemo(() => BRANCH.map((p) => {
    const t = totals(engagementFor(p)); const wk = totals(engagementFor(p), 21, 28); const prev = totals(engagementFor(p), 14, 21);
    const bm = benchmark(p); const q = listingQuality(p);
    const flag = t.enquiryRate.high < bm.rate.low ? 'Low conversion' : wk.views < prev.views * 0.85 ? 'Interest falling' : t.enquiryRate.low > bm.rate.high ? 'Strong' : null;
    return { p, t, wk, prev, bm, q, flag, gap: t.enquiryRate.p - bm.rate.p };
  }).sort((a, b) => (sortBy === 'gap' ? a.gap - b.gap : sortBy === 'views' ? b.t.views - a.t.views : a.q.score - b.q.score)), [sortBy]);
  const tot = rows.reduce((a, r) => ({ v: a.v + r.t.views, e: a.e + r.t.enquiries + r.t.viewingRequests, u: a.u + r.t.unique }), { v: 0, e: 0, u: 0 });

  const proposeReport = (p: Property) => enqueue([{ id: `rep-${p.id}-${Date.now()}`, agent: 'estate-agent', title: `Email weekly report to owner of ${street(p)}`, detail: 'AI-drafted seller report; requires your review before sending.', consequential: true, payload: weeklyOwnerReport(p, 'agent-draft') }]);
  const proposeCopy = (p: Property) => {
    const ds = dealScore(p);
    const top = [...engagementFor(p).photos].sort((a, b) => b.enlargements / b.impressions - a.enlargements / a.impressions)[0];
    const copy = `${p.title}. A ${p.beds}-bedroom ${p.type} of ${p.floorArea}m², ${p.station.walkMins} minutes’ walk from ${p.station.name} (${p.commute.minutes} min to ${p.commute.to}). Highlights: ${p.features.slice(0, 3).join(', ').toLowerCase()}.\n\nBrixo Intelligence: indicative refurbishment budget ${gbpK(ds.refurbEstimate)}; ${p.loftPotential !== 'none' ? 'loft conversion potential; ' : ''}EPC ${p.epc.current} with a costed route to ${p.epc.potential}.\n\nSuggested lead photo: “${top.label}” (highest engagement).\n\nMaterial information (inserted from verified fields, not generated): ${p.tenure}; council tax ${p.councilTax}; flood risk ${p.risks.flood}.`;
    enqueue([{ id: `copy-${p.id}-${Date.now()}`, agent: 'estate-agent', title: `Publish revised description & lead photo for ${street(p)}`, detail: 'AI draft — edits to a live listing need approval.', consequential: true, payload: copy }]);
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">Estate agent command centre</div><h2 style={{ marginTop: 6 }}>Northbank Estates · portfolio intelligence</h2>
          <p className="muted" style={{ marginTop: 6 }}>Every listing’s engagement, conversion, quality and pricing evidence in one place. AI drafts reports and listing changes; nothing is published or sent without your approval.</p></div>
        <div className="row"><Tag kind="demo">Simulated engagement</Tag><Tag kind="live">CRM sync: Reapit · Alto · Street · Jupix</Tag></div>
      </div>

      <div className="grid g4 keep2">
        <div className="card"><Stat label="Active listings" value={rows.length} sub={`${rows.filter((r) => r.flag && r.flag !== 'Strong').length} need attention`} /></div>
        <div className="card"><Stat label="Views (28d)" value={tot.v.toLocaleString('en-GB')} sub={`${tot.u.toLocaleString('en-GB')} unique`} /></div>
        <div className="card"><Stat label="Enquiries + viewing requests" value={tot.e} sub={`Portfolio conversion ${pct(tot.e / tot.u)}`} /></div>
        <div className="card"><Stat label="Awaiting your approval" value={queue.length} tone={queue.length ? 'neg' : undefined} sub="AI drafts & agent proposals" /></div>
      </div>

      <Section title="Listing performance" kicker="Portfolio overview" right={<select className="input" aria-label="Sort listings" style={{ width: 'auto' }} value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}><option value="gap">Sort: weakest conversion</option><option value="views">Sort: most viewed</option><option value="quality">Sort: lowest quality score</option></select>}>
        <div className="table-wrap" tabIndex={0}><table className="t">
          <thead><tr><th>Listing</th><th className="r">Price</th><th className="r">Views 7d</th><th className="r">Conversion</th><th className="r">vs comps</th><th className="r">Quality</th><th>Alert</th><th>Actions</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.p.id}>
              <td className="small"><Link to={`/property/${r.p.id}`}><b>{street(r.p)}</b></Link><div className="xs muted">{r.p.town.split(',')[0]} · {r.p.daysOnMarket}d on market</div></td>
              <td className="r num">{gbpK(r.p.price)}</td>
              <td className="r num">{r.wk.views} <span className={`xs ${r.wk.views >= r.prev.views ? 'pos' : 'neg'}`}>{r.wk.views >= r.prev.views ? '▲' : '▼'}{Math.abs(Math.round(((r.wk.views - r.prev.views) / Math.max(1, r.prev.views)) * 100))}%</span></td>
              <td className="r num">{pct(r.t.enquiryRate.p)}</td>
              <td className={`r num ${r.gap < 0 ? 'neg' : 'pos'}`}>{r.gap >= 0 ? '+' : ''}{(r.gap * 100).toFixed(1)}pt</td>
              <td className="r num">{r.q.score}</td>
              <td>{r.flag && <Tag kind={r.flag === 'Strong' ? 'ok' : 'warn'}>{r.flag}</Tag>}</td>
              <td><div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}><button className="btn ghost sm" onClick={() => proposeReport(r.p)}>Seller report</button><button className="btn ghost sm" onClick={() => proposeCopy(r.p)}>AI copy</button></div></td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="xs muted" style={{ marginTop: 8 }}>“vs comps” = difference in enquiry + viewing conversion from comparable listings; flagged only when 95% intervals don’t overlap.</p>
      </Section>

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <AssistantPanel title="Ask about your portfolio" kicker="AI estate agency assistant" skills={agentSkills} ctx={{ listings: BRANCH }} />

          <section className="card" id="approvals">
            <div className="card-head"><div><div className="eyebrow">Human in the loop</div><h3>Approval queue</h3></div><Tag kind="neutral">{queue.length} pending</Tag></div>
            {queue.length === 0 && <p className="small muted">Nothing awaiting approval. Use “Seller report” or “AI copy” above, or run the agents on the <Link to="/automation">AI agents</Link> page.</p>}
            <ul className="clean">{queue.map((q) => (
              <li key={q.id} className="card flat" style={{ padding: 12 }}>
                <div className="row between"><b className="small">{q.title}</b><Tag kind="ai">{q.agent}</Tag></div>
                <div className="xs muted" style={{ marginTop: 4 }}>{q.detail}</div>
                <div className="row" style={{ marginTop: 8 }}>
                  {q.payload && <button className="btn ghost sm" onClick={() => setPreview(preview === q.id ? null : q.id)}>{preview === q.id ? 'Hide' : 'Review draft'}</button>}
                  <button className="btn sm" onClick={() => decide(q.id, true)}>Approve</button>
                  <button className="btn ghost sm" onClick={() => decide(q.id, false)}>Reject</button>
                </div>
                {preview === q.id && <pre tabIndex={0} className="code" style={{ marginTop: 8, whiteSpace: 'pre-wrap', maxHeight: 320 }}>{q.payload}</pre>}
              </li>
            ))}</ul>
            <p className="xs muted" style={{ marginTop: 8 }}>Prototype: approval records the decision in the audit log; no email is sent and no listing is changed.</p>
          </section>

          <div className="grid g2">
            <Section title="Buyer feedback summaries" kicker="From viewing feedback" right={<Tag kind="demo" />}>
              {Object.entries(FEEDBACK).map(([pid, items]) => <div key={pid} style={{ marginBottom: 10 }}><b className="small">{street(PROPERTIES.find((x) => x.id === pid)!)}</b><ul className="ticks xs">{items.map((i) => <li key={i}>{i}</li>)}</ul></div>)}
            </Section>
            <Section title="Photography recommendations" kicker="From photo engagement">
              <ul className="clean small">{rows.slice(0, 5).map((r) => { const ph = [...engagementFor(r.p).photos].sort((a, b) => b.enlargements / b.impressions - a.enlargements / a.impressions); return <li key={r.p.id}><b>{street(r.p)}</b>: strongest “{ph[0].label}”, weakest “{ph[ph.length - 1].label}”{ph[0].photoId !== engagementFor(r.p).photos[0].photoId ? ' — consider testing as lead' : ''}</li>; })}</ul>
            </Section>
          </div>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <Section title="Automated alerts" kicker="This week">
            <ul className="clean small">{rows.flatMap((r) => insightsFor(r.p).filter((i) => i.id === 'conv-low' || i.id === 'trend').map((i) => <li key={r.p.id + i.id}><Tag kind="obs" /> <b>{street(r.p)}</b> — {i.title}</li>))}</ul>
          </Section>
          <Section title="Listing quality" kicker={street(rows[0].p)}>
            <ul className="clean small">{rows[0].q.checks.map((c) => <li key={c.item}>{c.ok ? '✅' : '⬜'} {c.item}</li>)}</ul>
          </Section>
          <Section title="Lead conversion by channel" kicker="Portfolio">
            {(() => { const ch = new Map<string, { c: number; e: number }>(); rows.forEach((r) => engagementFor(r.p).campaigns.forEach((x) => { const v = ch.get(x.channel) ?? { c: 0, e: 0 }; ch.set(x.channel, { c: v.c + x.clicks, e: v.e + x.enquiries }); })); return <ul className="clean small">{[...ch].map(([k, v]) => <li key={k} className="row between"><span>{k}</span><span className="num">{pct(v.e / Math.max(1, v.c))}</span></li>)}</ul>; })()}
          </Section>
          <Section title="Audit log" kicker="Approvals & agent actions">
            {audit.length === 0 ? <p className="small muted">No actions yet.</p> : <ul className="clean xs mono" style={{ maxHeight: 220, overflow: 'auto' }}>{audit.slice(0, 15).map((a, i) => <li key={i}>{a.at.slice(11, 19)} {a.actor} · {a.action} · {a.detail}</li>)}</ul>}
          </Section>
        </div>
      </div>
    </div>
  );
}
