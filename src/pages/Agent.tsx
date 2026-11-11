import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { baseListings, photosFor, type Property } from '../data/properties';
import { benchmark, engagementFor, insightsFor, PERIOD_DAYS, PERIOD_END, totals } from '../engine/engagement';
import { dealScore } from '../engine/insights';
import { weeklyOwnerReport } from '../engine/reports';
import { AGENTS } from '../ai/agents';
import { agentSkills } from '../ai/skills';
import { AssistantPanel } from '../components/Assistant';
import { AiBriefing, BriefingFallback } from '../components/ai/AiBriefing';
import { gbp, gbpK, pct, Section, Stat, Tag } from '../components/ui';
import type { BriefingSnapshot } from '../lib/ai/briefing';
import { useStore, type EnqueueResult } from '../store';

/**
 * The demonstration branch: Streetkey's fictional sale listings only. The shared listing registry also
 * holds real listings once the site has loaded them (including private sellers' homes); those must
 * never get simulated engagement, alerts, drafts or a place in the briefing. Real listings are briefed
 * on only through "My agency (live)", which uses their real figures.
 */
const BRANCH = baseListings().filter((p) => p.listing !== 'rent' && p.type !== 'commercial');
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

const signed = (n: number, dp = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(dp)}`;
const propertyLink = (id: string) => `/property/${encodeURIComponent(id)}`;
const agentName = (id: string) => AGENTS.find((a) => a.id === id)?.name ?? id;
/** What happened when something was sent to the approval queue, in words. */
function queueMessage(r: EnqueueResult, what: string) {
  if (r.added.length) return `${what}: added to the approval queue.`;
  if (r.duplicates.length) return `${what} is already waiting in the approval queue.`;
  if (r.full.length) return 'The approval queue is full. Approve or reject some waiting items first.';
  return '';
}

const FEEDBACK: Record<string, string[]> = {
  'wal-001': ['Loved the period features and garden (4 of 6 viewings)', 'Worried about the cost of works and damp in the rear reception (5 of 6)', 'Felt price high relative to work needed (3 of 6)'],
  'cro-002': ['Liked the driveway and garden', 'Concern about subsidence history'],
  'cro-013': ['Developers interested in conversion; families put off by condition'],
};

export default function Agent() {
  const { queue, enqueue, decide, audit } = useStore();
  const [preview, setPreview] = useState<string | null>(null);
  const [queueNote, setQueueNote] = useState('');
  const [sortBy, setSortBy] = useState<'gap' | 'views' | 'quality'>('gap');
  const rows = useMemo(() => BRANCH.map((p) => {
    const t = totals(engagementFor(p)); const wk = totals(engagementFor(p), 21, 28); const prev = totals(engagementFor(p), 14, 21);
    const bm = benchmark(p); const q = listingQuality(p);
    const flag = t.enquiryRate.high < bm.rate.low ? 'Low conversion' : wk.views < prev.views * 0.85 ? 'Interest falling' : t.enquiryRate.low > bm.rate.high ? 'Strong' : null;
    return { p, t, wk, prev, bm, q, flag, gap: t.enquiryRate.p - bm.rate.p };
  }).sort((a, b) => (sortBy === 'gap' ? a.gap - b.gap : sortBy === 'views' ? b.t.views - a.t.views : a.q.score - b.q.score)), [sortBy]);
  const tot = rows.reduce((a, r) => ({ v: a.v + r.t.views, e: a.e + r.t.enquiries + r.t.viewingRequests, u: a.u + r.t.unique }), { v: 0, e: 0, u: 0 });
  const attention = rows.filter((r) => r.flag && r.flag !== 'Strong');

  /** What the command centre shows, for the AI briefing (fixed order, so re-sorting the table doesn't change it). */
  const briefing = useMemo<BriefingSnapshot>(() => {
    const ordered = [...rows].sort((a, b) => a.gap - b.gap || a.p.id.localeCompare(b.p.id));
    return {
      title: 'Northbank Estates · branch listings',
      scope: `Example branch: ${ordered.length} example sale listings with example engagement figures over the last ${PERIOD_DAYS} days.`,
      asOf: PERIOD_END,
      metrics: [
        { label: 'Active listings', value: ordered.length },
        { label: 'Listings needing attention', value: ordered.filter((r) => r.flag && r.flag !== 'Strong').length },
        { label: `Views (${PERIOD_DAYS} days)`, value: tot.v },
        { label: `Unique visitors (${PERIOD_DAYS} days)`, value: tot.u },
        { label: 'Enquiries and viewing requests', value: tot.e },
        { label: 'Portfolio conversion', value: pct(tot.e / tot.u) },
        { label: 'Proposals awaiting approval', value: queue.length },
      ],
      items: ordered.map((r) => {
        const gaps = r.q.checks.filter((c) => !c.ok).map((c) => c.item);
        const history = r.p.priceHistory.map((h) => `${h.event} ${gbp(h.price)} (${h.date})`).join('; ');
        return {
          id: r.p.id, label: `${street(r.p)}, ${r.p.town.split(',')[0]}`, group: 'listing',
          fields: {
            askingPrice: r.p.price, property: `${r.p.beds}-bed ${r.p.type}`, daysOnMarket: r.p.daysOnMarket,
            views7d: r.wk.views, viewsPrior7d: r.prev.views, views28d: r.t.views, saves28d: r.t.saves,
            enquiries28d: r.t.enquiries, viewingRequests28d: r.t.viewingRequests,
            conversion: pct(r.t.enquiryRate.p), comparablesConversion: pct(r.bm.rate.p), gapVsComparables: `${signed(r.gap * 100)} percentage points`,
            qualityScore: r.q.score, alert: r.flag ?? 'none',
          },
          notes: [
            ...(history ? [`Price history: ${history}`] : []),
            ...(gaps.length ? [`Listing quality gaps: ${gaps.join(', ')}`] : []),
            ...(FEEDBACK[r.p.id] ?? []).slice(0, 2).map((f) => `Viewing feedback: ${f}`),
          ],
        };
      }),
      notes: [
        'Engagement figures on this page are examples.',
        'Conversion is enquiries plus viewing requests per unique visitor; a gap against comparables is flagged only when the 95% intervals don’t overlap.',
      ],
    };
  }, [rows, tot.v, tot.u, tot.e, queue.length]);
  const briefingFallback = (
    <BriefingFallback title="Needs attention" items={[...attention].sort((a, b) => a.gap - b.gap).slice(0, 4).map((r) => (
      <><Link to={propertyLink(r.p.id)}><b>{street(r.p)}</b></Link>: {r.flag?.toLowerCase()}, {pct(r.t.enquiryRate.p)} conversion against {pct(r.bm.rate.p)} for comparables</>
    ))} />
  );

  // Both drafts come from Streetkey's own templates and figures (not AI), and wait for approval.
  const proposeReport = (p: Property) => setQueueNote(queueMessage(enqueue([{ id: `rep-${p.id}-${Date.now()}`, agent: 'estate-agent', title: `Email weekly report to owner of ${street(p)}`, detail: 'Seller report drafted from this listing’s engagement figures; requires your review before sending.', consequential: true, payload: weeklyOwnerReport(p, 'agent-draft') }]), `Seller report for ${street(p)}`));
  const proposeCopy = (p: Property) => {
    const ds = dealScore(p);
    const top = [...engagementFor(p).photos].sort((a, b) => b.enlargements / b.impressions - a.enlargements / a.impressions)[0];
    const copy = `${p.title}. A ${p.beds}-bedroom ${p.type} of ${p.floorArea}m², ${p.station.walkMins} minutes’ walk from ${p.station.name} (${p.commute.minutes} min to ${p.commute.to}). Highlights: ${p.features.slice(0, 3).join(', ').toLowerCase()}.\n\nStreetkey Intelligence: indicative refurbishment budget ${gbpK(ds.refurbEstimate)}; ${p.loftPotential !== 'none' ? 'loft conversion potential; ' : ''}EPC ${p.epc.current} with a costed route to ${p.epc.potential}.\n\nSuggested lead photo: “${top.label}” (highest engagement).\n\nMaterial information (inserted from verified fields, not generated): ${p.tenure}; council tax ${p.councilTax}; flood risk ${p.risks.flood}.`;
    setQueueNote(queueMessage(enqueue([{ id: `copy-${p.id}-${Date.now()}`, agent: 'estate-agent', title: `Publish revised description & lead photo for ${street(p)}`, detail: 'Draft from Streetkey’s listing template and verified fields; edits to a live listing need approval.', consequential: true, payload: copy }]), `Draft copy for ${street(p)}`));
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">Estate agent command centre</div><h2 style={{ marginTop: 6 }}>Northbank Estates · portfolio intelligence</h2>
          <p className="muted" style={{ marginTop: 6 }}>Every listing’s engagement, conversion, quality and pricing evidence in one place. Streetkey drafts reports and listing changes; nothing is published or sent without your approval.</p></div>
        <div className="row"><Tag kind="demo">Example data</Tag></div>
      </div>

      <div className="grid g4 keep2">
        <div className="card"><Stat label="Active listings" value={rows.length} sub={`${attention.length} need attention`} /></div>
        <div className="card"><Stat label="Views (28d)" value={tot.v.toLocaleString('en-GB')} sub={`${tot.u.toLocaleString('en-GB')} unique`} /></div>
        <div className="card"><Stat label="Enquiries + viewing requests" value={tot.e} sub={`Portfolio conversion ${pct(tot.e / tot.u)}`} /></div>
        <div className="card"><Stat label="Awaiting your approval" value={queue.length} tone={queue.length ? 'neg' : undefined} sub="Drafts & agent proposals" /></div>
      </div>

      <AiBriefing kind="agent" title="Branch briefing" snapshot={briefing} allowMyAgency linkFor={propertyLink} fallback={briefingFallback}
        intro="A prioritised read of this branch: what needs attention first, why, and the next step." />

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
              <td><div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}><button className="btn ghost sm" aria-label={`Seller report: ${street(r.p)}`} onClick={() => proposeReport(r.p)}>Seller report</button><button className="btn ghost sm" aria-label={`Draft copy: ${street(r.p)}`} onClick={() => proposeCopy(r.p)}>Draft copy</button></div></td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="xs muted" style={{ marginTop: 8 }}>“vs comps” = difference in enquiry + viewing conversion from comparable listings; flagged only when 95% intervals don’t overlap. “Seller report” and “Draft copy” prepare drafts from Streetkey’s templates and figures for the approval queue.</p>
        <p className="small" role="status" style={{ margin: queueNote ? '6px 0 0' : 0 }}>{queueNote}</p>
      </Section>

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <AssistantPanel title="Ask about your portfolio" kicker="Estate agency assistant" skills={agentSkills} ctx={{ listings: BRANCH }} />

          <section className="card" id="approvals">
            <div className="card-head"><div><div className="eyebrow">Human in the loop</div><h3>Approval queue</h3></div><Tag kind="neutral">{queue.length} pending</Tag></div>
            {queue.length === 0 && <p className="small muted">Nothing awaiting approval. Use “Seller report” or “Draft copy” above, or run the agents on the <Link to="/automation">AI agents</Link> page.</p>}
            <ul className="clean">{queue.map((q) => (
              <li key={q.id} className="card flat" style={{ padding: 12 }}>
                <div className="row between"><b className="small">{q.title}</b><Tag kind="neutral">{agentName(q.agent)}</Tag></div>
                <div className="xs muted" style={{ marginTop: 4 }}>{q.detail}</div>
                <div className="row" style={{ marginTop: 8 }}>
                  {q.payload && <button className="btn ghost sm" aria-expanded={preview === q.id} aria-label={`${preview === q.id ? 'Hide draft' : 'Review draft'}: ${q.title}`} onClick={() => setPreview(preview === q.id ? null : q.id)}>{preview === q.id ? 'Hide' : 'Review draft'}</button>}
                  <button className="btn sm" aria-label={`Approve: ${q.title}`} onClick={() => decide(q.id, true)}>Approve</button>
                  <button className="btn ghost sm" aria-label={`Reject: ${q.title}`} onClick={() => decide(q.id, false)}>Reject</button>
                </div>
                {preview === q.id && <pre tabIndex={0} className="code" style={{ marginTop: 8, whiteSpace: 'pre-wrap', maxHeight: 320 }}>{q.payload}</pre>}
              </li>
            ))}</ul>
            <p className="xs muted" style={{ marginTop: 8 }}>Prototype: approval records the decision in the audit log; no email is sent and no listing is changed.</p>
          </section>

          <div className="grid g2">
            <Section title="Buyer feedback summaries" kicker="From viewing feedback" right={<Tag kind="demo" />}>
              {Object.entries(FEEDBACK).map(([pid, items]) => <div key={pid} style={{ marginBottom: 10 }}><b className="small">{street(BRANCH.find((x) => x.id === pid) ?? baseListings().find((x) => x.id === pid)!)}</b><ul className="ticks xs">{items.map((i) => <li key={i}>{i}</li>)}</ul></div>)}
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
            {audit.length === 0 ? <p className="small muted">No actions yet.</p> : (
              // Focusable, so keyboard users can scroll it in every browser.
              <div tabIndex={0} role="region" aria-label="Audit log" style={{ maxHeight: 220, overflow: 'auto' }}>
                <ul className="clean xs mono">{audit.slice(0, 15).map((a, i) => <li key={i}>{a.at.slice(11, 19)} {a.actor} · {a.action} · {a.detail}</li>)}</ul>
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
