import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { describeQuery, parseQuery, runSearch, type SearchHit, type SearchQuery } from '../engine/search';
import { gbp, gbpK, HouseArt, Seg, Tag, UKMap } from '../components/ui';
import { useStore } from '../store';

function narrate(q: SearchQuery, hits: SearchHit[]): string[] {
  const out: string[] = [];
  if (!hits.length) return ['Nothing in the current dataset meets the hard constraints (type, budget, beds, location/commute). Try widening the budget, commute or area.'];
  const best = hits[0];
  out.push(`I found ${hits.length} propert${hits.length === 1 ? 'y' : 'ies'} meeting your hard constraints, ranked by fit and underwritten potential (refurb cost from the BRIXO engine, value from comparables, risk and demand).`);
  if (q.minRefurbProfit) {
    const meeting = hits.filter((h) => h.estProfit >= q.minRefurbProfit!);
    if (meeting.length) out.push(`${meeting.length} clear your £${Math.round(q.minRefurbProfit / 1000)}k profit target on base-case assumptions.`);
    else { const gap = q.minRefurbProfit - best.estProfit; out.push(`Honest answer: none clear £${Math.round(q.minRefurbProfit / 1000)}k on base-case numbers. The closest is ≈£${Math.round(best.estProfit / 1000)}k; you’d need to buy at about ${gbp(best.property.price - gap)} to reach it.`); }
  }
  if (q.conversion) out.push('Conversion potential is a screening result, not a planning opinion — check local policy on loss of family housing and space standards.');
  out.push(`Top pick: ${best.property.title} — ${best.reasons.slice(0, 2).join('; ') || 'best overall fit'}.`);
  if (best.cautions.length) out.push(`Watch out: ${best.cautions.join('; ')}.`);
  return out;
}

type Channel = 'any' | 'buy' | 'rent' | 'commercial';

export default function Search() {
  const [params, setParams] = useSearchParams();
  const initial = params.get('q') ?? 'Find me a three-bedroom house within 45 minutes of central London for under £500,000 that requires refurbishment but has potential for a good investment return.';
  const [text, setText] = useState(initial);
  const [submitted, setSubmitted] = useState(initial);
  const [active, setActive] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const modeParam = params.get('mode');
  const [channel, setChannel] = useState<Channel>(modeParam === 'rent' ? 'rent' : modeParam === 'commercial' ? 'commercial' : 'any');
  const [maxPrice, setMaxPrice] = useState<number | ''>('');
  const [minBeds, setMinBeds] = useState<number | ''>('');
  const [sort, setSort] = useState<'fit' | 'price' | 'score'>('fit');
  const { saved, compare, toggleSaved, toggleCompare, savedSearches, toggleSavedSearch, addRecent } = useStore();
  const searchSaved = savedSearches.some((s) => s.q === submitted);

  const q = useMemo(() => {
    const base = parseQuery(submitted);
    if (channel === 'rent') base.intent = 'rent';
    if (channel === 'buy' && base.intent === 'rent') base.intent = 'buy';
    if (channel === 'commercial') base.commercial = true;
    if (maxPrice !== '') base.maxPrice = maxPrice;
    if (minBeds !== '') base.minBeds = minBeds;
    return base;
  }, [submitted, channel, maxPrice, minBeds]);
  const hits = useMemo(() => {
    const h = runSearch(q);
    if (sort === 'price') return [...h].sort((a, b) => a.property.price - b.property.price);
    if (sort === 'score') return [...h].sort((a, b) => a.dealGrade.localeCompare(b.dealGrade) || b.score - a.score);
    return h;
  }, [q, sort]);
  const narrative = useMemo(() => narrate(q, hits), [q, hits]);
  const submit = () => { setSubmitted(text); setParams({ q: text }); addRecent(text, channel === 'rent' ? 'rent' : 'buy'); };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div><div className="eyebrow">AI property search</div><h2 style={{ marginTop: 6 }}>Describe what you want</h2></div>
        <div className="row"><Tag kind="demo">15 fictional listings</Tag><Tag kind="live">Licensed feeds: agent CRMs · auction partners · owner listings</Tag></div>
      </div>
      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <div className="card ai-card">
            <div className="ask" style={{ boxShadow: 'none' }}>
              <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} aria-label="Describe the property you want" />
              <button className="btn accent sm" onClick={submit}>Search</button>
            </div>
            <div className="msg ai" style={{ maxWidth: '100%', marginTop: 12 }}>
              <div className="row" style={{ marginBottom: 6 }}><Tag kind="ai">BRIXO AI</Tag><span className="xs muted">explanation composed from engine outputs</span></div>
              <div className="stack" style={{ gap: 6 }}>{narrative.map((n, i) => <p key={i}>{n}</p>)}</div>
              {q.unsupported.length > 0 && <div className="callout info" style={{ marginTop: 10 }}><b>Not yet covered:</b> {q.unsupported.join(' ')}</div>}
            </div>
            <div className="row between" style={{ marginTop: 10 }}>
              <div className="parsed">{describeQuery(q).map((d) => <span key={d}>{d}</span>)}</div>
              <button className={`save-btn${searchSaved ? ' on' : ''}`} onClick={() => toggleSavedSearch(submitted, channel === 'rent' ? 'rent' : 'buy')}>{searchSaved ? '♥ Search saved' : '♡ Save search & alerts'}</button>
              <button className="btn ghost sm" onClick={() => setShowJson(!showJson)}>{showJson ? 'Hide' : 'Show'} structured query</button>
            </div>
            {showJson && <pre className="code" style={{ marginTop: 10 }}>{`// Production: the LLM emits this via tool-calling (JSON-schema validated).\n// Filtering, costing and ranking are deterministic.\nsearch_properties(${JSON.stringify(q, null, 2)})`}</pre>}
          </div>

          <div className="card flat filters">
            <label className="field">Market<Seg value={channel} onChange={setChannel} options={[{ value: 'any', label: 'From query' }, { value: 'buy', label: 'Buy' }, { value: 'rent', label: 'Rent' }, { value: 'commercial', label: 'Commercial' }]} /></label>
            <label className="field">Max price<select className="input" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value === '' ? '' : Number(e.target.value))}><option value="">From query</option>{[250_000, 350_000, 500_000, 750_000, 1_000_000, 2_000_000].map((v) => <option key={v} value={v}>{gbpK(v)}</option>)}</select></label>
            <label className="field">Min beds<select className="input" value={minBeds} onChange={(e) => setMinBeds(e.target.value === '' ? '' : Number(e.target.value))}><option value="">From query</option>{[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v}+</option>)}</select></label>
            <label className="field">Sort<select className="input" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="fit">Best match</option><option value="score">Deal grade</option><option value="price">Price (low–high)</option></select></label>
          </div>

          {hits.map((h, i) => (
            <div key={h.property.id} className={`listing${active === h.property.id ? ' hl' : ''}`} onMouseEnter={() => setActive(h.property.id)}>
              <Link to={`/property/${h.property.id}`} className="ph"><HouseArt hue={h.property.photoHue} type={h.property.type} seed={i} /></Link>
              <div className="stack" style={{ gap: 6, minWidth: 0 }}>
                <div className="row between" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                  <Link to={`/property/${h.property.id}`} style={{ minWidth: 0, textDecoration: 'none' }}>
                    <div className="num" style={{ fontSize: 22 }}>{h.property.listing === 'rent' ? `${gbp(h.property.price)} pcm` : gbp(h.property.price)}{h.property.listing === 'auction' && <span className="xs muted"> guide</span>}</div>
                    <div style={{ fontWeight: 600 }}>{h.property.title}</div>
                    <div className="small muted">{h.property.street}, {h.property.town} · {h.property.beds ? `${h.property.beds} bed · ` : ''}{h.property.floorArea}m² · EPC {h.property.epc.current}</div>
                  </Link>
                  {h.property.listing !== 'rent' && <div className={`grade grade-${h.dealGrade}`} title="BRIXO deal grade">{h.dealGrade}</div>}
                </div>
                <ul className="ticks">{h.reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>
                {h.cautions.length > 0 && <div className="xs" style={{ color: 'var(--danger)' }}>⚠ {h.cautions.slice(0, 2).join(' · ')}</div>}
                <div className="row" style={{ gap: 6 }}>
                  <button className={`save-btn${saved.includes(h.property.id) ? ' on' : ''}`} onClick={() => toggleSaved(h.property.id)}>{saved.includes(h.property.id) ? '♥ Saved' : '♡ Save'}</button>
                  <button className={`save-btn${compare.includes(h.property.id) ? ' on' : ''}`} onClick={() => toggleCompare(h.property.id)}>{compare.includes(h.property.id) ? '✓ Comparing' : '+ Compare'}</button>
                  <Link className="save-btn" to={`/property/${h.property.id}/intelligence`} style={{ textDecoration: 'none' }}>Intelligence →</Link>
                  {h.property.listing !== 'rent' && <Tag kind="est">Indicative value-add {gbpK(h.estProfit)}</Tag>}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="sticky stack">
          <UKMap pins={hits.map((h) => ({ id: h.property.id, lat: h.property.lat, lng: h.property.lng, label: h.property.town.split(',')[0], active: active === h.property.id }))} onPin={setActive} />
          {compare.length > 0 && <Link to="/compare" className="btn">Compare {compare.length} selected →</Link>}
          <div className="card flat small">
            <div className="eyebrow" style={{ marginBottom: 6 }}>Data provenance</div>
            <ul className="ticks muted">
              <li>Listings: fictional demo set. Production: agent CRM feeds, auction partners and owner-submitted listings — never scraped portals.</li>
              <li>Commute: stored per listing. Production: TfL Unified API, NaPTAN, BODS + routing.</li>
              <li>Schools: Ofsted / Estyn / Education Scotland open data (planned).</li>
              <li>Sold prices: HM Land Registry Price Paid (OGL) — planned.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
