import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { describeQuery, parseQuery, runSearch } from '../engine/search';
import { estimateRefurb, DEFAULT_INPUT } from '../engine/refurb';
import { gbpK, Tag } from '../components/ui';

const EXAMPLES = [
  'Find me a three-bedroom house within 45 minutes of central London, under £500,000, with potential for a loft conversion and refurbishment profit of £60,000.',
  'HMO opportunity in Manchester under £300k with 7% yield',
  'Auction property in Birmingham suitable for commercial to residential conversion',
  '2 bed flat to rent in Nottingham',
  'Family house in Sheffield near good schools with extension potential',
];

const MVP = [
  { n: '01', title: 'Refurbishment cost engine', body: 'Trade-by-trade, room-by-room UK estimates with regional indices, prelims, OH&P, contingency, fees and VAT treatment. Budget / standard / premium. Exportable bill of quantities.', to: '/estimate', cta: 'Price a project' },
  { n: '02', title: 'Investment underwriter', body: 'BTL, BRRR, flip and HMO models with SDLT/LTT/LBTT, bridging, refinance, lender ICR stress tests, scenarios and two-way sensitivity.', to: '/invest', cta: 'Underwrite a deal' },
  { n: '03', title: 'Property intelligence report', body: 'One page per property: deal score, refurb budget, value-add plays, EPC pathway, constraints, comparables and cost of ownership.', to: '/property/wal-001', cta: 'Open a report' },
  { n: '04', title: 'Conversational deal search', body: 'Describe the deal you want. Plinth turns it into a structured query, ranks properties by underwritten potential, and says plainly when nothing qualifies.', to: '/search', cta: 'Try a search' },
  { n: '05', title: 'Quote comparison & BoQ', body: 'Send a standardised scope to contractors and compare like-for-like against the benchmark. Every verified quote improves the pricing model.', to: '/marketplace', cta: 'Compare quotes' },
];

export default function Home() {
  const [q, setQ] = useState(EXAMPLES[0]);
  const nav = useNavigate();
  const parsed = useMemo(() => parseQuery(q), [q]);
  const hits = useMemo(() => runSearch(parsed).length, [parsed]);
  const sample = useMemo(() => estimateRefurb(DEFAULT_INPUT), []);
  const go = () => nav(`/search?q=${encodeURIComponent(q)}`);

  return (
    <div className="stack" style={{ gap: 48 }}>
      <section className="hero">
        <div className="stack" style={{ gap: 14, maxWidth: 900 }}>
          <div className="row"><span className="eyebrow">AI property intelligence · United Kingdom</span><Tag kind="demo" /></div>
          <h1>Don’t search for a house.<br />Search for <em>the deal inside it.</em></h1>
          <p className="muted" style={{ fontSize: 18, maxWidth: 700 }}>
            Plinth prices the refurbishment, underwrites the investment and surfaces the planning and risk constraints <i>before</i> you book a viewing — and lets every agent, lender and contractor build on the same engine.
          </p>
        </div>
        <div className="stack" style={{ gap: 12 }}>
          <div className="ask">
            <textarea aria-label="Describe what you are looking for" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } }} rows={2} />
            <button className="btn accent" onClick={go}>Ask Plinth →</button>
          </div>
          <div className="row small" style={{ gap: 8 }}>
            <span className="muted">Understood as:</span>
            <div className="parsed">{describeQuery(parsed).map((d) => <span key={d}>{d}</span>)}</div>
            <span className="muted">· {hits} candidate{hits === 1 ? '' : 's'} in demo dataset</span>
          </div>
          <div className="chips">{EXAMPLES.slice(1).map((e) => <button key={e} className="chip" onClick={() => setQ(e)}>{e}</button>)}</div>
        </div>
      </section>

      <section className="grid g3">
        <div className="card ink">
          <div className="eyebrow" style={{ color: 'inherit', opacity: 0.6 }}>The problem</div>
          <h3 style={{ marginTop: 8 }}>Portals sell attention. Nobody prices the work.</h3>
          <p className="muted small" style={{ marginTop: 8 }}>Rightmove and Zoopla show what’s for sale. The decision that matters — what will it cost to make this right, and is it worth it? — still happens in spreadsheets, WhatsApp threads and builder guesswork.</p>
        </div>
        <div className="card">
          <div className="eyebrow">The proposition</div>
          <h3 style={{ marginTop: 8 }}>Underwritten property, not listed property.</h3>
          <p className="muted small" style={{ marginTop: 8 }}>Every property arrives with a costed refurb scope, an investment case and a constraint check. AI interprets and explains; deterministic engines do the maths, with every assumption shown and editable.</p>
        </div>
        <div className="card">
          <div className="eyebrow">The moat</div>
          <h3 style={{ marginTop: 8 }}>Verified cost & outcome data.</h3>
          <p className="muted small" style={{ marginTop: 8 }}>Each quote, invoice and completion feeds a permissioned UK refurbishment cost graph that portals don’t have. That data is what agents, lenders and developers license through the API.</p>
        </div>
      </section>

      <section>
        <div className="page-head"><div><div className="eyebrow">MVP · five features worth paying for</div><h2 style={{ marginTop: 6 }}>Start where the money is decided</h2></div><Link className="btn ghost sm" to="/developers">Same engine, via API →</Link></div>
        <div className="grid g3">
          {MVP.map((m) => (
            <Link key={m.n} to={m.to} className="card" style={{ textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span className="feature-num">{m.n}</span>
              <h3>{m.title}</h3>
              <p className="muted small" style={{ flex: 1 }}>{m.body}</p>
              <span className="small" style={{ fontWeight: 600 }}>{m.cta} →</span>
            </Link>
          ))}
          <div className="card flat" style={{ background: 'var(--surface-2)' }}>
            <div className="eyebrow">Live sample from the engine</div>
            <p className="small" style={{ marginTop: 8 }}>Full refurbishment, 92m² pre-1919 terrace, E17, standard spec:</p>
            <div className="num" style={{ fontSize: 32, marginTop: 6 }}>{gbpK(sample.total)}</div>
            <p className="xs muted">Range {gbpK(sample.low)}–{gbpK(sample.high)} · {sample.lines.length} measured items · {sample.programmeWeeks} weeks · incl. VAT</p>
            <div className="row" style={{ marginTop: 10 }}><Tag kind="est" /><Tag kind="demo">Demo rate library</Tag></div>
          </div>
        </div>
      </section>

      <section className="grid g2">
        <div className="card">
          <div className="eyebrow">Trust architecture</div>
          <h3 style={{ marginTop: 6, marginBottom: 12 }}>Where AI is used — and where it isn’t</h3>
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Layer</th><th>Does</th><th>Never</th></tr></thead>
            <tbody>
              <tr><td><Tag kind="ai">LLM</Tag></td><td>Interpret requests, read surveys, explain results, draft scopes</td><td>Produce prices, taxes, yields or legal conclusions</td></tr>
              <tr><td><Tag kind="est">Engine</Tag></td><td>Costing, SDLT/LTT/LBTT, cash flow, stress tests — versioned & testable</td><td>Hide assumptions</td></tr>
              <tr><td><Tag kind="ok">Verified</Tag></td><td>Licensed feeds, public datasets, contractor-verified quotes</td><td>Get blended with estimates without a label</td></tr>
              <tr><td><Tag kind="neutral">Human</Tag></td><td>Tenant decisions, quote validation, planning & structural sign-off</td><td>Get automated away</td></tr>
            </tbody>
          </table></div>
        </div>
        <div className="card">
          <div className="eyebrow">Built for</div>
          <h3 style={{ marginTop: 6, marginBottom: 12 }}>One engine, every side of the transaction</h3>
          <div className="grid g2" style={{ gap: 10 }}>
            {[
              ['Investors & developers', 'Underwrite more deals per hour', '/invest'],
              ['Homeowners & buyers', 'Know the real cost before you offer', '/estimate'],
              ['Landlords & letting agents', 'Renters’ Rights Act-ready management', '/landlord'],
              ['Contractors', 'Qualified leads with standardised scopes', '/marketplace'],
              ['Estate agents', 'Listings that arrive pre-underwritten', '/agents'],
              ['Lenders & portals', 'Embed estimates via API & widgets', '/developers'],
            ].map(([a, b, to]) => (
              <Link key={a} to={to} className="card flat" style={{ textDecoration: 'none', padding: 12 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{a}</div>
                <div className="xs muted">{b}</div>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
