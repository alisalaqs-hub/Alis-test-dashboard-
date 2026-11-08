import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { describeQuery, parseQuery, runSearch } from '../engine/search';
import { estimateRefurb } from '../engine/refurb';
import { dealScore, refurbInputFor } from '../engine/insights';
import { analyse, DEFAULT_INVESTMENT } from '../engine/investment';
import { valuationScenario } from '../engine/valuation';
import { engagementFor, totals } from '../engine/engagement';
import { getProperty } from '../data/properties';
import { gbp, gbpK, HouseArt, Tag } from '../components/ui';

const EXAMPLES = [
  'Find me a three-bedroom house within 45 minutes of central London for under £500,000 that requires refurbishment but has potential for a good investment return.',
  'Find me properties in Croydon that could potentially be converted into multiple flats.',
  'Find me a two-bedroom flat with good rental demand, low service charges and potential for refurbishment.',
  'Office building near London suitable for office-to-residential conversion',
  'HMO opportunity in Manchester under £300k with 7% yield',
];

export default function Home() {
  const [q, setQ] = useState(EXAMPLES[0]);
  const nav = useNavigate();
  const parsed = useMemo(() => parseQuery(q), [q]);
  const hits = useMemo(() => runSearch(parsed), [parsed]);
  const go = () => nav(`/search?q=${encodeURIComponent(q)}`);

  // Live "connected journey" on one demo property — every number below comes from an engine.
  const journey = useMemo(() => {
    const p = getProperty('wal-001')!;
    const ds = dealScore(p);
    const v = valuationScenario(p);
    const base = refurbInputFor(p);
    const full = estimateRefurb(base);
    const kitchen = estimateRefurb({ ...base, spec: 'premium', bathrooms: 0, scope: { ...base.scope, stripOut: false, rewire: false, heating: 'none', replaster: 'none', windows: false, roof: 'none', flooring: false, decoration: false, damp: false, external: false, insulation: false, structuralOpenings: 0, kitchen: true } });
    const inv = analyse({ ...DEFAULT_INVESTMENT, price: p.price, refurbCost: full.total, monthlyRent: p.estRentPcm, gdv: p.estGdv });
    const eg = totals(engagementFor(p));
    return { p, ds, v, full, kitchen, inv, eg };
  }, []);
  const j = journey;

  return (
    <div className="stack" style={{ gap: 56 }}>
      <section className="hero">
        <div className="stack" style={{ gap: 16, maxWidth: 960 }}>
          <div className="row"><span className="eyebrow">The Intelligent Property Platform</span><Tag kind="demo" /></div>
          <h1>See beyond<br />the <em>property.</em></h1>
          <p className="muted" style={{ fontSize: 19, maxWidth: 720 }}>
            Every home on BRIXO comes with its own intelligence: what it’s really worth, what the work will cost, how it could look, what it could earn — and how buyers are responding to it.
          </p>
        </div>
        <div className="stack" style={{ gap: 12 }}>
          <div className="ask">
            <textarea aria-label="Describe the property you want" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } }} rows={2} />
            <button className="btn accent" onClick={go}>Search with AI →</button>
          </div>
          <div className="row small" style={{ gap: 8 }}>
            <span className="muted">BRIXO understood:</span>
            <div className="parsed">{describeQuery(parsed).map((d) => <span key={d}>{d}</span>)}</div>
            <span className="muted">· {hits.length} match{hits.length === 1 ? '' : 'es'} in the demo dataset</span>
          </div>
          <div className="chips">{EXAMPLES.slice(1).map((e) => <button key={e} className="chip" onClick={() => setQ(e)}>{e}</button>)}</div>
        </div>
      </section>

      <section className="grid g4 keep2">
        {[
          { to: '/search', k: 'AI SEARCH', t: 'Describe it. Don’t filter it.', b: 'Natural-language search that understands commute, budget, condition, conversion potential and returns — and explains every match.', v: `${hits.length} matches` },
          { to: '/estimate', k: 'REFURB INTELLIGENCE', t: 'Know the cost before you offer.', b: 'Regional, trade-by-trade estimates with ranges, VAT and programme — calibrated by verified contractor quotes over time.', v: gbpK(j.full.total) },
          { to: '/studio', k: 'INTERIOR DESIGN', t: 'See it finished. See it costed.', b: 'Upload a room, pick a style or a budget, and get a concept linked to a materials schedule and a quote request.', v: `${gbpK(j.kitchen.total)} kitchen` },
          { to: '/invest', k: 'INVESTMENT ANALYSIS', t: 'Underwrite in seconds.', b: 'BTL, BRRR, flips, HMOs and conversions with stamp duty, finance, scenarios and lender stress tests.', v: `${gbp(j.inv.monthlyCashflow)}/mo` },
        ].map((c) => (
          <Link key={c.k} to={c.to} className="card" style={{ textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="feature-num">{c.k}</span>
            <h3>{c.t}</h3>
            <p className="muted small" style={{ flex: 1 }}>{c.b}</p>
            <div className="row between"><span className="num">{c.v}</span><span className="small" style={{ fontWeight: 600 }}>Open →</span></div>
          </Link>
        ))}
      </section>

      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="split" style={{ gap: 0 }}>
          <div style={{ minHeight: 240, position: 'relative' }}><HouseArt hue={j.p.photoHue} type={j.p.type} /></div>
          <div style={{ padding: 22 }}>
            <div className="row between"><div><div className="eyebrow">How the AI works together · one property, every engine</div><h2 style={{ marginTop: 6 }}>{j.p.street.replace(' (fictional)', '')}, {j.p.town.split(',')[0]}</h2></div><Tag kind="demo">Fictional listing</Tag></div>
            <ol className="stack" style={{ marginTop: 16, paddingLeft: 18, gap: 8 }}>
              <li><b>Find</b> — AI search matched it to “3-bed under £500k with investment potential”; deal score <b className="num">{j.ds.total}/100 ({j.ds.grade})</b>.</li>
              <li><b>Understand</b> — asking {gbp(j.p.price)} is <b>{j.v.verdict}</b> of the indicative as-is range {gbpK(j.v.asIs.low)}–{gbpK(j.v.asIs.high)}.</li>
              <li><b>Cost</b> — refurbishment engine: <b className="num">{gbp(j.full.total)}</b> incl. VAT, {j.full.programmeWeeks} weeks, {j.full.confidence} confidence.</li>
              <li><b>Design</b> — a premium kitchen concept costs <b className="num">{gbpK(j.kitchen.total)}</b>, fed straight into the budget.</li>
              <li><b>Invest</b> — BRRR at 75% refinance: <b className="num">{gbp(j.inv.monthlyCashflow)}</b>/month pre-tax; lender stress test <b>{j.inv.icrPass ? 'passes' : 'fails'}</b>.</li>
              <li><b>Market</b> — {j.eg.views.toLocaleString('en-GB')} views but conversion is below comparables, so the owner’s AI suggests testing a new lead photo and adding a costed renovation concept.</li>
            </ol>
            <div className="row" style={{ marginTop: 16 }}>
              <Link className="btn" to={`/property/${j.p.id}/intelligence`}>Open intelligence profile</Link>
              <Link className="btn ghost" to="/owner">See the owner’s view</Link>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="page-head"><div><div className="eyebrow">For professionals</div><h2 style={{ marginTop: 6 }}>One intelligence layer, every side of the deal</h2></div><Link className="btn ghost sm" to="/enterprise">Embed BRIXO in your own site →</Link></div>
        <div className="ia-grid">
          {[
            ['/owner', 'Owners', 'Why isn’t it selling? Evidence, not guesswork.'],
            ['/agents', 'Estate agents', 'Command centre, AI seller reports, approvals.'],
            ['/landlord', 'Landlords', 'Compliance autopilot, voids, maintenance.'],
            ['/developer', 'Developers', 'Unit-mix demand and residual appraisals.'],
            ['/marketplace', 'Contractors', 'Standard scopes, benchmarked quotes.'],
            ['/automation', 'AI agents', 'Eight role-based agents with human approval.'],
          ].map(([to, a, b]) => <Link key={to} to={to} className="card" style={{ textDecoration: 'none' }}><b>{a}</b><div className="small muted" style={{ marginTop: 4 }}>{b}</div></Link>)}
        </div>
      </section>

      <section className="grid g2">
        <div className="card ink">
          <div className="eyebrow" style={{ color: 'inherit', opacity: 0.6 }}>Our unique selling proposition</div>
          <h2 style={{ marginTop: 10 }}>Portals show you the property. BRIXO shows you what it could become — and proves it with numbers.</h2>
          <p className="muted" style={{ marginTop: 12 }}>We connect value → cost → design → return → market response in one profile per property, built on deterministic engines and verified contractor costs. The same intelligence powers agents, landlords, developers and partner websites.</p>
        </div>
        <div className="card">
          <div className="eyebrow">Trust architecture</div>
          <h3 style={{ marginTop: 6, marginBottom: 12 }}>Where AI is used — and where it isn’t</h3>
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Layer</th><th>Does</th><th>Never</th></tr></thead>
            <tbody>
              <tr><td><Tag kind="ai">AI</Tag></td><td>Understands questions, reads documents, picks tools, explains</td><td>Invents prices, taxes, yields or market statistics</td></tr>
              <tr><td><Tag kind="est">Engine</Tag></td><td>Costs, tax, cash flow, valuation scenarios, stats — versioned & tested</td><td>Hides its assumptions</td></tr>
              <tr><td><Tag kind="obs">Observed</Tag></td><td>Aggregated engagement counts with sample sizes</td><td>Gets presented as buyer intent</td></tr>
              <tr><td><Tag kind="neutral">Human</Tag></td><td>Approves publishing, messaging, tenant & spending decisions</td><td>Gets bypassed by an agent</td></tr>
            </tbody>
          </table></div>
        </div>
      </section>
    </div>
  );
}
