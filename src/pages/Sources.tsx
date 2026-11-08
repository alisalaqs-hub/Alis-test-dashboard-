import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { baseListings, PROPERTIES } from '../data/properties';
import { dedupe, parseBLM, type FeedReport } from '../engine/listings';
import { SAMPLE_AGENT, SAMPLE_BLM } from '../data/sampleFeed';
import { gbp, Section, Stat, Tag } from '../components/ui';
import { useStore } from '../store';

const JSON_SCHEMA = `POST /v1/listings            (BRIXO Listing Feed v1 — for CRMs with an API)
Authorization: Bearer sk_live_…   Idempotency-Key: <agent_ref>
{
  "agent_ref": "LVH002",
  "status": "available",            // available | under_offer | sold_stc | let_agreed | withdrawn
  "transaction": "sale",            // sale | let
  "price": { "amount": 340000, "qualifier": "guide" },
  "address": { "line1": "Hoe Street", "town": "Walthamstow", "postcode": "E17 7JP", "display": "Hoe Street, Walthamstow" },
  "property": { "type": "flat", "bedrooms": 2, "bathrooms": 1, "floor_area_m2": 61 },
  "material_information": { "tenure": "leasehold", "lease_years": 125, "service_charge": 1400, "ground_rent": 0, "council_tax_band": "B", "epc": "C" },
  "features": ["Balcony", "Lift"], "description": "…",
  "media": [{ "url": "https://cdn.agent.example/1.jpg", "type": "photo", "virtually_staged": false }]
}`;

export default function Sources() {
  const { feedListings, myListings, tracked, ingestFeed, removeFeed } = useStore();
  const [agent, setAgent] = useState(SAMPLE_AGENT);
  const [report, setReport] = useState<(FeedReport & { dupes: number }) | null>(null);
  const load = (raw: string) => {
    const r = parseBLM(raw, agent);
    const { duplicates } = dedupe([...baseListings().map((b) => ({ ...b })), ...r.accepted.map((p) => ({ ...p }))]);
    setReport({ ...r, dupes: duplicates.length });
  };
  const counts = useMemo(() => {
    const c = { demo: baseListings().length, owner: myListings.length, feed: feedListings.length, tracked: tracked.length };
    return c;
  }, [feedListings, myListings, tracked]);
  const agents = [...new Set(feedListings.map((f) => f.source!.name.replace(' (agent feed)', '')))];

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">Listing sources & feeds</div><h2 style={{ marginTop: 6 }}>Where BRIXO listings come from</h2>
          <p className="muted" style={{ marginTop: 6 }}>Agents own their listings and already send them to every portal from their CRM. BRIXO is simply another destination — plus homes posted directly by owners and landlords.</p></div>
        <Link to="/list" className="btn">List a property yourself</Link>
      </div>

      <div className="grid g4 keep2">
        <div className="card"><Stat label="Agent feed listings" value={counts.feed} sub={`${agents.length} connected agenc${agents.length === 1 ? 'y' : 'ies'}`} /></div>
        <div className="card"><Stat label="Owner & landlord posts" value={counts.owner} sub="Posted on BRIXO" /></div>
        <div className="card"><Stat label="Demo listings" value={counts.demo} sub="Fictional seed data" /></div>
        <div className="card"><Stat label="Tracked from other sites" value={counts.tracked} sub="Private to each user" /></div>
      </div>

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <Section title="Connect an agent feed" kicker="BLM v3 bulk file — exported by most UK agency CRMs">
            <div className="grid g2" style={{ gap: 10 }}>
              <label className="field">Agency name<input className="input" value={agent} onChange={(e) => setAgent(e.target.value)} /></label>
              <label className="field">Feed file (.blm)<input className="input" type="file" accept=".blm,.txt" onChange={async (e) => { const file = e.target.files?.[0]; if (file) load(await file.text()); }} /></label>
            </div>
            <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => load(SAMPLE_BLM)}>Load sample feed ({SAMPLE_AGENT.replace(" (demo agency)", "")})</button>
            {report && <div className="stack" style={{ marginTop: 14 }}>
              <div className="row"><Tag kind="ok">{report.accepted.length} accepted</Tag><Tag kind="warn">{report.rejected.length} rejected</Tag><Tag kind="neutral">{report.dupes} duplicate merged</Tag><span className="xs muted">BLM v{report.version} · {report.fields} fields</span></div>
              <div className="table-wrap"><table className="t"><thead><tr><th>Listing</th><th className="r">Price</th><th>Status</th></tr></thead>
                <tbody>{report.accepted.map((p) => <tr key={p.id}><td className="small"><b>{p.title}</b><div className="xs muted">{p.street}, {p.town} · {p.postcode} · {p.beds} bed · EPC {p.epc.current}</div></td><td className="r num">{p.listing === 'rent' ? `${gbp(p.price)} pcm` : gbp(p.price)}</td><td><Tag kind="ok">{p.status}</Tag></td></tr>)}
                  {report.rejected.map((r) => <tr key={r.ref}><td className="small mono">{r.ref}</td><td /><td className="xs" style={{ color: 'var(--danger)' }}>{r.reason}</td></tr>)}</tbody></table></div>
              <div className="row"><button className="btn accent" onClick={() => ingestFeed(agent, report.accepted)}>Publish {report.accepted.length} listings to BRIXO</button><Link to="/search?q=Walthamstow" className="btn ghost sm">Then search Walthamstow →</Link></div>
            </div>}
          </Section>
          <Section title="Or integrate by API" kicker="For CRMs and developers"><pre className="code">{JSON_SCHEMA}</pre></Section>
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <Section title="Connected agencies">
            {agents.length === 0 ? <p className="small muted">None yet — load the sample feed.</p> : <ul className="clean small">{agents.map((a) => <li key={a} className="row between"><span>{a} · {feedListings.filter((f) => f.source!.name.startsWith(a)).length} listings</span><button className="btn ghost sm" onClick={() => removeFeed(a)}>Disconnect</button></li>)}</ul>}
          </Section>
          <Section title="How each source can be used">
            <div className="table-wrap"><table className="t"><thead><tr><th>Source</th><th>Shown publicly?</th></tr></thead><tbody>
              <tr><td className="small"><b>Agent CRM feed</b><div className="xs muted">Agent consent & feed agreement</div></td><td className="small">Yes, as supplied; updates every feed run</td></tr>
              <tr><td className="small"><b>Owner / landlord post</b><div className="xs muted">BRIXO terms; owner declares authority</div></td><td className="small">Yes, after checks</td></tr>
              <tr><td className="small"><b>Listing found elsewhere</b><div className="xs muted">User-pasted details</div></td><td className="small">No — private analysis, links back</td></tr>
              <tr><td className="small"><b>Other portals’ sites</b><div className="xs muted">Their terms & database rights</div></td><td className="small">Never copied; we link out</td></tr>
            </tbody></table></div>
          </Section>
          <div className="callout small"><b>Why BRIXO doesn’t scrape other portals.</b> Portal terms prohibit automated copying, their listing databases are protected by UK database right, and agents control where their listings appear. Getting listings from agents directly is legal, more complete and updates in real time.</div>
          <div className="xs muted">{PROPERTIES.length} listings in the registry right now.</div>
        </div>
      </div>
    </div>
  );
}
