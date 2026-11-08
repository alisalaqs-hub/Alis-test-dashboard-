import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { describeQuery, parseQuery, runSearch, type SearchHit, type SearchQuery } from '../engine/search';
import { gbp, gbpK, HouseArt, Tag, UKMap } from '../components/ui';

function narrate(q: SearchQuery, hits: SearchHit[]): string[] {
  const out: string[] = [];
  if (!hits.length) {
    out.push('Nothing in the current dataset satisfies the hard constraints (beds, budget, location/commute, listing type). Try widening the budget or commute.');
    return out;
  }
  const best = hits[0];
  out.push(`I found ${hits.length} propert${hits.length === 1 ? 'y' : 'ies'} meeting your hard constraints and ranked them by underwritten potential — refurb cost from the Plinth engine, value from comparable evidence, plus risk and demand.`);
  if (q.minRefurbProfit) {
    const meeting = hits.filter((h) => h.estProfit >= q.minRefurbProfit!);
    if (meeting.length) out.push(`${meeting.length} clear your £${Math.round(q.minRefurbProfit / 1000)}k profit target on base-case assumptions.`);
    else {
      const gap = q.minRefurbProfit - best.estProfit;
      out.push(`Honest answer: none clear £${Math.round(q.minRefurbProfit / 1000)}k on base-case numbers. The closest is ${best.property.town} at ≈£${Math.round(best.estProfit / 1000)}k. To reach your target you’d need to buy at about ${gbp(best.property.price - gap)} (${((gap / best.property.price) * 100).toFixed(1)}% below asking) or find extra value beyond the comparables.`);
    }
  }
  out.push(`Top pick: ${best.property.title} — ${best.reasons.slice(0, 2).join('; ')}.`);
  if (best.cautions.length) out.push(`Watch out: ${best.cautions.join('; ')}.`);
  return out;
}

export default function Search() {
  const [params, setParams] = useSearchParams();
  const initial = params.get('q') ?? 'Find me a three-bedroom house within 45 minutes of central London, under £500,000, with potential for a loft conversion and refurbishment profit of £60,000.';
  const [text, setText] = useState(initial);
  const [submitted, setSubmitted] = useState(initial);
  const [active, setActive] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const q = useMemo(() => parseQuery(submitted), [submitted]);
  const hits = useMemo(() => runSearch(q), [q]);
  const narrative = useMemo(() => narrate(q, hits), [q, hits]);
  const submit = () => { setSubmitted(text); setParams({ q: text }); };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div><div className="eyebrow">Discover</div><h2 style={{ marginTop: 6 }}>Conversational deal search</h2></div>
        <div className="row"><Tag kind="demo">12 fictional listings</Tag><Tag kind="live">Licensed feeds: agent CRM / RTDF / auction partners</Tag></div>
      </div>
      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <div className="card">
            <div className="chat">
              <div className="msg user">{submitted}</div>
              <div className="msg ai">
                <div className="row" style={{ marginBottom: 6 }}><Tag kind="ai">Plinth assistant</Tag><span className="xs muted">explanation generated from engine outputs</span></div>
                <div className="stack" style={{ gap: 6 }}>{narrative.map((n, i) => <p key={i}>{n}</p>)}</div>
                {q.unsupported.length > 0 && <div className="callout info" style={{ marginTop: 10 }}><b>Not yet covered:</b> {q.unsupported.join(' ')}</div>}
              </div>
            </div>
            <div className="ask" style={{ marginTop: 12, boxShadow: 'none' }}>
              <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} aria-label="Refine search" />
              <button className="btn accent sm" onClick={submit}>Search</button>
            </div>
            <div className="row between" style={{ marginTop: 10 }}>
              <div className="parsed">{describeQuery(q).map((d) => <span key={d}>{d}</span>)}</div>
              <button className="btn ghost sm" onClick={() => setShowJson(!showJson)}>{showJson ? 'Hide' : 'Show'} structured query</button>
            </div>
            {showJson && <pre className="code" style={{ marginTop: 10 }}>{`// In production the LLM emits this via tool-calling (JSON-schema validated).\n// Filtering, costing and ranking below are deterministic.\nsearch_properties(${JSON.stringify(q, null, 2)})`}</pre>}
          </div>

          {hits.map((h, i) => (
            <Link key={h.property.id} to={`/property/${h.property.id}`} className={`listing${active === h.property.id ? ' hl' : ''}`} onMouseEnter={() => setActive(h.property.id)}>
              <div className="ph"><HouseArt hue={h.property.photoHue} type={h.property.type} seed={i} /></div>
              <div className="stack" style={{ gap: 6, minWidth: 0 }}>
                <div className="row between" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="num" style={{ fontSize: 22 }}>{h.property.listing === 'rent' ? `${gbp(h.property.price)} pcm` : gbp(h.property.price)}{h.property.listing === 'auction' && <span className="xs muted"> guide</span>}</div>
                    <div style={{ fontWeight: 600 }}>{h.property.title}</div>
                    <div className="small muted">{h.property.street}, {h.property.town} · {h.property.beds} bed · {h.property.floorArea}m² · EPC {h.property.epc.current}</div>
                  </div>
                  {h.property.listing !== 'rent' && <div className={`grade grade-${h.dealGrade}`} title="Plinth deal grade">{h.dealGrade}</div>}
                </div>
                <ul className="ticks">{h.reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>
                {h.cautions.length > 0 && <div className="xs" style={{ color: 'var(--danger)' }}>⚠ {h.cautions.slice(0, 2).join(' · ')}</div>}
                <div className="row" style={{ gap: 6 }}>
                  {h.property.listing === 'auction' && <Tag kind="warn">Auction</Tag>}
                  {h.property.listing !== 'rent' && <Tag kind="est">Indicative profit {gbpK(h.estProfit)}</Tag>}
                  <Tag kind="demo" />
                </div>
              </div>
            </Link>
          ))}
        </div>
        <div className="sticky stack">
          <UKMap pins={hits.map((h) => ({ id: h.property.id, lat: h.property.lat, lng: h.property.lng, label: h.property.town.split(',')[0], active: active === h.property.id }))} onPin={setActive} />
          <div className="card flat small">
            <div className="eyebrow" style={{ marginBottom: 6 }}>Data provenance</div>
            <ul className="ticks muted">
              <li>Listings: fictional demo set. Production: agent CRM feeds (Reapit/Alto/Street), auction partners and user-submitted listings — never scraped portals.</li>
              <li>Commute: stored per listing. Production: TfL Unified API + NaPTAN + door-to-door routing.</li>
              <li>Schools: Ofsted/Estyn/Education Scotland open data (planned).</li>
              <li>Sold prices: HM Land Registry Price Paid (OGL) — planned.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
