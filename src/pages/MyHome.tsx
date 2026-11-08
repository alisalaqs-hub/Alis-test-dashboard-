import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PROPERTIES, type Property } from '../data/properties';
import { epcPathway, refurbInputFor } from '../engine/insights';
import { developmentOptions } from '../engine/development';
import { estimateRefurb, REGIONS, regionFromPostcode, type Condition, type Era, type PropertyType } from '../engine/refurb';
import { gbp, gbpK, Section, Seg, Stat, Tag } from '../components/ui';

const EPC_SCORE: Record<string, number> = { A: 94, B: 84, C: 72, D: 61, E: 47, F: 30, G: 15 };

/** Build a Property-shaped record for the user's own home so the same engines apply. */
function myProperty(f: { postcode: string; type: PropertyType; beds: number; area: number; era: Era; condition: Condition; epc: string }): Property {
  const district = f.postcode.trim().toUpperCase().split(' ')[0];
  return {
    id: 'my-home', title: 'My home', street: 'Your address', district, postcode: f.postcode.toUpperCase(), town: district, nation: /^(CF|LD|LL|NP|SA|SY)/.test(district) ? 'wales' : regionFromPostcode(f.postcode) === 'scotland' ? 'scotland' : 'england',
    lat: 0, lng: 0, listing: 'sale', price: 0, type: f.type, tenure: f.type === 'flat' ? 'leasehold' : 'freehold', beds: f.beds, baths: 1, floorArea: f.area, storeys: f.type === 'flat' || f.type === 'bungalow' ? 1 : 2,
    era: f.era, condition: f.condition, epc: { current: f.epc, potential: 'B', score: EPC_SCORE[f.epc] ?? 60 }, councilTax: 'D', features: f.type === 'terraced' ? ['Side return'] : [],
    loftPotential: f.type === 'flat' ? 'none' : 'possible', extensionPotential: f.type === 'flat' ? 'none' : 'possible', estRentPcm: 0, estGdv: 0,
    commute: { to: '', minutes: 0, mode: '' }, station: { name: '', walkMins: 0 }, schools: [],
    risks: { flood: 'low', conservationArea: false, article4: false, listed: false, subsidence: 'low', radon: 'low' },
    priceHistory: [], areaIndex: [], rentDemand: 0, comparables: [], planningNearby: [], agent: '', daysOnMarket: 0, photoHue: 20,
  };
}

/** Indicative £/m² from demo listings in the same district, else same region. Honest about coverage. */
function evidence(postcode: string) {
  const district = postcode.trim().toUpperCase().split(' ')[0];
  const region = regionFromPostcode(postcode);
  const resi = PROPERTIES.filter((p) => p.listing !== 'rent' && p.type !== 'commercial');
  const near = resi.filter((p) => p.district === district);
  const pool = near.length ? near : resi.filter((p) => regionFromPostcode(p.postcode) === region);
  if (!pool.length) return null;
  const refurbishedPerM2 = pool.reduce((s, p) => s + p.estGdv / p.floorArea, 0) / pool.length;
  return { refurbishedPerM2, n: pool.length, scope: near.length ? `postcode district ${district}` : `${region ? REGIONS[region].label : 'region'}` };
}

export default function MyHome() {
  const [f, setF] = useState({ postcode: 'E17 4QH', type: 'terraced' as PropertyType, beds: 3, area: 92, era: 'pre-1919' as Era, condition: 'fair' as Condition, epc: 'D' });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const p = useMemo(() => myProperty(f), [f]);
  const ev = useMemo(() => evidence(f.postcode), [f.postcode]);
  // Full renovation = whole-house scope (as for a 'needs work' home), priced at the home's actual condition.
  const full = useMemo(() => estimateRefurb({ ...refurbInputFor({ ...p, condition: 'poor' }), condition: f.condition }), [p, f.condition]);
  const light = useMemo(() => { const b = refurbInputFor(p); return estimateRefurb({ ...b, bathrooms: 0, spec: 'standard', scope: { ...b.scope, stripOut: false, rewire: false, heating: 'none', replaster: 'none', windows: false, roof: 'none', damp: false, external: false, structuralOpenings: 0, kitchen: false, flooring: true, decoration: true, insulation: true } }); }, [p]);
  const dev = useMemo(() => developmentOptions(p).filter((o) => o.status !== 'not applicable' && o.id !== 'energy'), [p]);
  const epc = useMemo(() => epcPathway(p), [p]);
  const condAdj = { good: 0.97, fair: 0.9, poor: 0.8, derelict: 0.68 }[f.condition];
  const mid = ev ? ev.refurbishedPerM2 * f.area * condAdj : 0;
  const spread = ev && ev.n >= 3 ? 0.08 : 0.12;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">My Home</div><h2 style={{ marginTop: 6 }}>Your home — what it’s worth and what it could become</h2>
          <p className="muted" style={{ marginTop: 6 }}>Tell us five things. No sign-up needed to see the result.</p></div>
        <Tag kind="demo">Indicative · demo evidence</Tag>
      </div>
      <div className="split">
        <Section title="About your home" kicker="Step 1 of 1">
          <div className="grid g2" style={{ gap: 10 }}>
            <label className="field">Postcode<input className="input mono" value={f.postcode} onChange={(e) => set('postcode', e.target.value)} /></label>
            <label className="field">Bedrooms<input className="input num" type="number" min={0} max={8} value={f.beds} onChange={(e) => set('beds', Math.max(0, Number(e.target.value) || 0))} /></label>
            <label className="field">Floor area (m²)<input className="input num" type="number" min={20} value={f.area} onChange={(e) => set('area', Math.max(20, Number(e.target.value) || 20))} /></label>
            <label className="field">Built<select className="input" value={f.era} onChange={(e) => set('era', e.target.value as Era)}>{['pre-1919', '1919-1944', '1945-1979', '1980-1999', '2000+'].map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="field">Current EPC<select className="input" value={f.epc} onChange={(e) => set('epc', e.target.value)}>{'ABCDEFG'.split('').map((x) => <option key={x}>{x}</option>)}</select></label>
          </div>
          <div className="stack" style={{ marginTop: 12 }}>
            <label className="field">Type<Seg value={f.type} onChange={(v) => set('type', v)} options={[{ value: 'terraced', label: 'Terraced' }, { value: 'semi-detached', label: 'Semi' }, { value: 'detached', label: 'Detached' }, { value: 'flat', label: 'Flat' }, { value: 'bungalow', label: 'Bungalow' }]} /></label>
            <label className="field">Condition<Seg value={f.condition} onChange={(v) => set('condition', v)} options={[{ value: 'good', label: 'Good' }, { value: 'fair', label: 'Fair' }, { value: 'poor', label: 'Needs work' }, { value: 'derelict', label: 'Major works' }]} /></label>
          </div>
          <p className="xs muted" style={{ marginTop: 10 }}>Production looks up your address (UPRN) and pre-fills floor area, EPC and construction age from the EPC register, plus flood, conservation and planning constraints.</p>
        </Section>

        <div className="stack" style={{ gap: 16 }}>
          <section className="card ink">
            <div className="eyebrow" style={{ color: 'inherit', opacity: 0.6 }}>Indicative value today</div>
            {ev ? <>
              <div className="num" style={{ fontSize: 'clamp(2rem, 7vw, 3rem)', marginTop: 6 }}>{gbpK(mid * (1 - spread))} – {gbpK(mid * (1 + spread))}</div>
              <div className="muted small">From {ev.n} demo listing{ev.n === 1 ? '' : 's'} in {ev.scope}, adjusted for condition. Not a valuation.</div>
            </> : <div className="small" style={{ marginTop: 6 }}>No evidence for this postcode in the demo dataset. Live version uses HM Land Registry sold prices.</div>}
            <div className="row" style={{ marginTop: 14 }}><Link to="/prices" className="btn ghost sm" style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.3)' }}>See sold prices nearby</Link><Link to="/owner" className="btn accent sm">Thinking of selling?</Link></div>
          </section>
          <div className="grid g2">
            <div className="card"><Stat label={<>Refresh (decorate, floors, insulation) <Tag kind="est" /></>} value={gbpK(light.total)} sub={`${light.programmeWeeks} weeks · ${light.confidence} confidence`} /><Link to="/estimate" className="xs">Adjust scope →</Link></div>
            <div className="card"><Stat label={<>Full renovation <Tag kind="est" /></>} value={gbpK(full.total)} sub={`${gbpK(full.low)}–${gbpK(full.high)} · ${full.programmeWeeks} weeks`} /><Link to="/studio" className="xs">Design rooms first →</Link></div>
          </div>
          <Section title="Ways to add space & value" kicker="Screening — not a planning opinion" right={<Tag kind="warn">Verify with a professional</Tag>}>
            {dev.length === 0 ? <p className="small muted">Flats have no permitted-development rights for extensions or lofts.</p> :
              <ul className="clean">{dev.map((o) => <li key={o.id} className="row between" style={{ flexWrap: 'nowrap', gap: 10 }}><div className="small"><b>{o.name}</b><div className="xs muted">{o.status}{o.cost ? ` · cost ≈ ${gbpK(o.cost)}` : ''}</div></div>{ev && o.cost ? <span className="num small">{gbpK(ev.refurbishedPerM2 * (o.id === 'loft' ? 22 : o.id === 'rear' ? 15 : 8) * 0.85)} added</span> : null}</li>)}</ul>}
            <p className="xs muted" style={{ marginTop: 8 }}>Value added = new m² × local £/m² × 0.85 (demo heuristic). Constraints (conservation area, Article 4, listing) are not checked without your address.</p>
          </Section>
          <Section title="Energy upgrade plan" kicker={`EPC ${f.epc} today`}>
            <ul className="clean small">{epc.steps.slice(0, 4).map((s) => <li key={s.measure} className="row between"><span>{s.measure}</span><span className="num">{gbpK(s.cost)} → {s.band}</span></li>)}</ul>
          </Section>
          <p className="xs muted">Brixo is not a RICS valuer. For lending, probate or tax purposes you need a formal valuation.</p>
          <div className="small"><Link to={`/estimate`}>Cost works</Link> · <Link to="/studio">Redesign a room</Link> · <Link to="/invest">Investment view</Link> · <span className="muted">Values update as you edit — {gbp(Math.round(ev?.refurbishedPerM2 ?? 0))}/m² refurbished benchmark</span></div>
        </div>
      </div>
    </div>
  );
}
