import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PROPERTIES } from '../data/properties';
import { dealScore } from '../engine/insights';
import { gbp, gbpK, Section, Stat, Tag } from '../components/ui';

const LEADS = [
  { who: 'Investor · cash buyer', prop: 'wal-001', intent: 92, signal: 'Ran BRRR model 3×, saved report, viewed loft play', next: 'Call today — offer likely' },
  { who: 'First-time buyer · AIP £420k', prop: 'cro-002', intent: 74, signal: 'Viewed estimator; asked about SDLT relief', next: 'Book second viewing' },
  { who: 'Developer · portfolio', prop: 'bhm-006', intent: 81, signal: 'Downloaded constraints pack; Class MA question', next: 'Send legal pack & prior approval history' },
  { who: 'Home-mover · chain', prop: 'shf-008', intent: 55, signal: 'Saved, compared EPC pathway', next: 'Nurture: send EPC upgrade costs' },
];
const PROGRESSION = [
  { buyer: 'Sale · 9 Fernhill Rise (fictional)', stages: ['Offer accepted', 'Memorandum of sale', 'ID/AML', 'Searches', 'Mortgage offer', 'Enquiries raised', 'Enquiries answered', 'Exchange', 'Completion'], done: 5, eta: '2027-01-16', risk: 'Lender valuation down-valued by £8k — renegotiation risk' },
  { buyer: 'Sale · 4 Pretoria Ave (fictional)', stages: ['Offer accepted', 'Memorandum of sale', 'ID/AML', 'Searches', 'Mortgage offer', 'Enquiries raised', 'Enquiries answered', 'Exchange', 'Completion'], done: 7, eta: '2026-12-05', risk: 'On track' },
];

export default function Agent() {
  const [desc, setDesc] = useState('');
  const p = PROPERTIES[0];
  const ds = dealScore(p);
  const generate = () => setDesc(
    `${p.title.replace(/^./, (c) => c.toUpperCase())}, moments from ${p.station.name} (${p.station.walkMins} min walk; ${p.commute.minutes} min to ${p.commute.to}). This ${p.beds}-bedroom ${p.era === 'pre-1919' ? 'Victorian' : ''} ${p.type} offers ${p.floorArea}m² with ${p.features.slice(0, 3).join(', ').toLowerCase()}. ` +
    `Plinth Intelligence attached: indicative refurbishment budget ${gbpK(ds.refurbEstimate)}, strong loft potential with comparable dormers approved nearby, EPC ${p.epc.current} with a costed route to ${p.epc.potential}. ` +
    `Material information: freehold · council tax band ${p.councilTax} · flood risk ${p.risks.flood}.`,
  );

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">Estate agent portal</div><h2 style={{ marginTop: 6 }}>Northbank Estates · Walthamstow branch</h2>
          <p className="muted" style={{ marginTop: 6 }}>Listings that arrive pre-underwritten convert serious buyers faster and win instructions. Plinth sits alongside — not instead of — your CRM and portal feeds.</p></div>
        <div className="row"><Tag kind="demo" /><Tag kind="live">CRM sync: Reapit · Alto · Street · Jupix</Tag></div>
      </div>

      <div className="grid g4 keep2">
        <div className="card"><Stat label="Active listings" value="23" sub="18 with Intelligence attached" /></div>
        <div className="card"><Stat label="Qualified leads (30d)" value="41" sub="+38% vs listings without reports" /></div>
        <div className="card"><Stat label="Avg days to offer" value="19" sub="Branch avg 31 (demo)" /></div>
        <div className="card"><Stat label="Pipeline fee value" value={gbpK(68_400)} sub="12 sales agreed" /></div>
      </div>

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <Section title="Hot leads" kicker="Behavioural intent from report usage" right={<Tag kind="ai">Ranking model</Tag>}>
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Lead</th><th>Property</th><th className="r">Intent</th><th>Signals</th><th>Next action</th></tr></thead>
              <tbody>{LEADS.map((l) => { const pp = PROPERTIES.find((x) => x.id === l.prop)!; return (
                <tr key={l.who}><td className="small"><b>{l.who}</b></td><td className="small"><Link to={`/property/${pp.id}`}>{pp.town.split(',')[0]}</Link></td><td className="r num">{l.intent}</td><td className="xs muted">{l.signal}</td><td className="xs">{l.next}</td></tr>
              ); })}</tbody>
            </table></div>
            <p className="xs muted" style={{ marginTop: 8 }}>Only for users who consented to share activity with the listing agent (UK GDPR / PECR).</p>
          </Section>

          <Section title="Sales progression" kicker="Conveyancing tracker" right={<Tag kind="live">Conveyancer case-management APIs</Tag>}>
            {PROGRESSION.map((s) => (
              <div key={s.buyer} style={{ marginBottom: 16 }}>
                <div className="row between"><b className="small">{s.buyer}</b><span className="xs muted">Predicted completion <b className="mono">{s.eta}</b></span></div>
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${s.stages.length}, 1fr)`, gap: 3, marginTop: 8 }}>
                  {s.stages.map((st, k) => <div key={st} title={st} style={{ height: 8, borderRadius: 4, background: k < s.done ? 'var(--sage)' : k === s.done ? 'var(--gold)' : 'var(--surface-2)' }} />)}
                </div>
                <div className="row between xs muted" style={{ marginTop: 4 }}><span>{s.stages[0]}</span><span>Now: {s.stages[s.done]}</span><span>{s.stages[s.stages.length - 1]}</span></div>
                <div className={`xs ${s.risk === 'On track' ? 'pos' : ''}`} style={{ marginTop: 4, color: s.risk === 'On track' ? undefined : 'var(--danger)' }}>{s.risk === 'On track' ? '✓ On track' : `⚠ ${s.risk}`}</div>
              </div>
            ))}
          </Section>
        </div>
        <div className="stack sticky" style={{ gap: 16 }}>
          <Section title="Listing copy" kicker={p.street} right={<Tag kind="ai" />}>
            <button className="btn sm" onClick={generate}>Draft description</button>
            {desc && <><textarea className="input" rows={8} style={{ marginTop: 10 }} value={desc} onChange={(e) => setDesc(e.target.value)} />
              <p className="xs muted" style={{ marginTop: 6 }}>Draft only — the agent edits and approves. Material information fields (Trading Standards NTSELAT guidance) are inserted from verified data, never generated.</p></>}
          </Section>
          <Section title="Valuation pitch pack" kicker="Win the instruction">
            <ul className="ticks small"><li>Comparable evidence & area trend</li><li>Buyer demand by segment from Plinth searches in the postcode</li><li>Refurb & value-add scenarios to support pricing</li><li>Your branch’s days-to-offer vs competitors (where data permits)</li></ul>
            <div className="row" style={{ marginTop: 10 }}><span className="num" style={{ fontSize: 20 }}>{gbp(149)}</span><span className="xs muted">/branch/mo in Agent Pro</span></div>
          </Section>
        </div>
      </div>
    </div>
  );
}
