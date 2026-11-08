import { useMemo, useState } from 'react';
import { compareQuotes, DEFAULT_INPUT, estimateRefurb, type ContractorQuote, type Trade } from '../engine/refurb';
import { gbpK, Section, Seg, Stat, Tag } from '../components/ui';

const CONTRACTORS = [
  { name: 'Lea Bridge Build Ltd (demo)', checks: { companiesHouse: true, insurance: '£5m PL · £10m EL', trustmark: true, gasSafe: true, niceic: true }, rating: 4.8, jobs: 37, verifiedQuotes: 22 },
  { name: 'Forest Gate Renovations (demo)', checks: { companiesHouse: true, insurance: '£2m PL · £10m EL', trustmark: false, gasSafe: true, niceic: false }, rating: 4.5, jobs: 14, verifiedQuotes: 6 },
  { name: 'QuickFix Homes (demo)', checks: { companiesHouse: false, insurance: 'Not uploaded', trustmark: false, gasSafe: false, niceic: false }, rating: 3.9, jobs: 3, verifiedQuotes: 0 },
];

const MILESTONES = [
  { name: 'Strip-out, structural opening & first fix', pct: 0.3, status: 'Complete', evidence: '14 photos · BC inspection passed' },
  { name: 'Plastering, second fix, kitchen & bathroom', pct: 0.4, status: 'In progress', evidence: '6 photos' },
  { name: 'Decoration, flooring, external & snagging', pct: 0.25, status: 'Not started', evidence: '' },
  { name: 'Retention (released after 3-month defects period)', pct: 0.05, status: 'Held', evidence: '' },
];

export default function Marketplace() {
  const [view, setView] = useState<'owner' | 'contractor'>('owner');
  const est = useMemo(() => estimateRefurb(DEFAULT_INPUT), []);
  const quotes: ContractorQuote[] = useMemo(() => {
    const mk = (f: (t: Trade, v: number) => number | undefined): Partial<Record<Trade, number>> => Object.fromEntries(est.byTrade.map(({ trade, total }) => [trade, f(trade, total)]).filter(([, v]) => v != null));
    return [
      { contractor: CONTRACTORS[0].name, verified: true, programmeWeeks: 14, lines: mk((t, v) => Math.round(v * (t === 'Kitchen' ? 1.08 : t === 'Plastering' ? 0.94 : 1.03) * 1.25)) },
      { contractor: CONTRACTORS[1].name, verified: true, programmeWeeks: 12, lines: mk((t, v) => (t === 'Damp & timber' || t === 'External works' ? undefined : Math.round(v * (t === 'Electrical' ? 0.62 : 0.98) * 1.25))) },
      { contractor: CONTRACTORS[2].name, verified: false, programmeWeeks: 8, lines: mk((t, v) => Math.round(v * (t === 'Plumbing & heating' ? 1.55 : 0.78) * 1.25)) },
    ];
  }, [est]);
  // Benchmark compared at trade level incl. contractor on-costs (prelims + OH&P), ex VAT.
  const onCost = (est.measuredWorks + est.preliminaries + est.overheadsProfit) / est.measuredWorks;
  const bench = useMemo(() => ({ ...est, byTrade: est.byTrade.map((t) => ({ ...t, total: Math.round(t.total * onCost) })) }), [est, onCost]);
  const cmp = useMemo(() => compareQuotes(bench, quotes), [bench, quotes]);
  const benchTotal = bench.byTrade.reduce((s, t) => s + t.total, 0);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">MVP feature 05 · contractor marketplace</div><h2 style={{ marginTop: 6 }}>Like-for-like quotes against a standard scope</h2>
          <p className="muted" style={{ marginTop: 6 }}>Project: full refurbishment, 92m² pre-1919 terrace, E17. Scope issued from the Plinth BoQ so every contractor prices the same thing.</p></div>
        <Seg value={view} onChange={setView} options={[{ value: 'owner', label: 'Property owner view' }, { value: 'contractor', label: 'Contractor view' }]} />
      </div>

      {view === 'owner' ? <>
        <div className="grid g4 keep2">
          <div className="card"><Stat label="Plinth benchmark (ex VAT, excl. contingency/fees)" value={gbpK(benchTotal)} /></div>
          {cmp.map((c) => <div className="card" key={c.contractor}><Stat label={c.contractor.replace(' (demo)', '')} value={gbpK(c.quotedTotal)} tone={c.missing.length ? 'neg' : undefined} sub={`${c.programmeWeeks} weeks · ${c.missing.length ? `${c.missing.length} trades missing` : 'complete scope'}`} /></div>)}
        </div>
        <Section title="Trade-by-trade comparison" kicker="Variance vs benchmark (±25% flagged)" right={<Tag kind="demo">Demo quotes</Tag>}>
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Trade</th><th className="r">Benchmark</th>{cmp.map((c) => <th key={c.contractor} className="r">{c.contractor.split(' ')[0]} {c.contractor.split(' ')[1]}</th>)}</tr></thead>
            <tbody>{bench.byTrade.map((t, k) => (
              <tr key={t.trade}><td>{t.trade}</td><td className="r num">{gbpK(t.total)}</td>
                {cmp.map((c) => { const row = c.rows[k]; return <td key={c.contractor} className="r num" style={{ color: row.flag === 'high' ? 'var(--danger)' : row.flag === 'low' ? 'var(--gold)' : undefined }}>{row.quoted == null ? <Tag kind="warn">Missing</Tag> : <>{gbpK(row.quoted)} <span className="xs">{row.variance! > 0 ? '+' : ''}{Math.round(row.variance! * 100)}%</span></>}</td>; })}
              </tr>
            ))}</tbody>
            <tfoot><tr><td>Total</td><td className="r num">{gbpK(benchTotal)}</td>{cmp.map((c) => <td key={c.contractor} className="r num">{gbpK(c.quotedTotal)}</td>)}</tr></tfoot>
          </table></div>
          <div className="grid g3" style={{ marginTop: 14 }}>
            <div className="callout ok small"><b>Lea Bridge Build</b> — complete scope, within ±10% on every trade, fully verified. Strongest value, not cheapest.</div>
            <div className="callout small"><b>Forest Gate</b> — damp and external works missing; electrical 38% under benchmark. Ask whether rewire includes certification & consumer unit.</div>
            <div className="callout small"><b>QuickFix</b> — lowest headline price but unverified, no insurance on file, 8-week programme is unrealistic for this scope, heating priced 55% over.</div>
          </div>
        </Section>
        <div className="grid g2">
          <Section title="Verification" kicker="Trust & safety">
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Contractor</th><th>Companies House</th><th>Insurance</th><th>TrustMark</th><th>Gas Safe</th><th>NICEIC/NAPIT</th></tr></thead>
              <tbody>{CONTRACTORS.map((c) => (
                <tr key={c.name}><td className="small">{c.name}<div className="xs muted">★ {c.rating} · {c.jobs} jobs · {c.verifiedQuotes} verified quotes</div></td>
                  <td>{c.checks.companiesHouse ? '✓' : '✗'}</td><td className="xs">{c.checks.insurance}</td><td>{c.checks.trustmark ? '✓' : '—'}</td><td>{c.checks.gasSafe ? '✓' : '—'}</td><td>{c.checks.niceic ? '✓' : '—'}</td></tr>
              ))}</tbody>
            </table></div>
            <p className="xs muted" style={{ marginTop: 8 }}>Production checks: Companies House API (live), Gas Safe & competent-person register lookups, insurance certificate OCR with expiry monitoring, reviews only from completed, paid Plinth jobs.</p>
          </Section>
          <Section title="Progress, payments & variations" kicker="Live project · Lea Bridge Build">
            <ul className="clean">{MILESTONES.map((m) => (
              <li key={m.name} className="row between" style={{ flexWrap: 'nowrap' }}>
                <div className="small">{m.name}<div className="xs muted">{m.evidence || 'Awaiting evidence'}</div></div>
                <div style={{ textAlign: 'right' }}><div className="num small">{gbpK(cmp[0].quotedTotal * m.pct)}</div><Tag kind={m.status === 'Complete' ? 'ok' : m.status === 'In progress' ? 'demo' : 'neutral'}>{m.status}</Tag></div>
              </li>
            ))}</ul>
            <div className="hr" />
            <div className="small"><b>Variation V-03</b>: replace rotten joists, front bay (found on opening up) — <span className="num">£2,840</span> · <Tag kind="demo">Awaiting owner approval</Tag></div>
            <p className="xs muted" style={{ marginTop: 8 }}>Stage payments released against photo evidence via escrow partner (requires FCA-authorised payments provider). Disputes: structured evidence pack → mediation → independent adjudication.</p>
          </Section>
        </div>
      </> : (
        <div className="grid g2">
          <Section title="Opportunities matched to you" kicker="Lea Bridge Build · E10 · 8-mile radius">
            <ul className="clean">{[
              ['Full refurb, 3-bed terrace', 'E17', '£130–180k', 'Scope + BoQ ready', 3],
              ['Loft conversion (rear dormer)', 'E4', '£55–75k', 'Drawings attached', 5],
              ['Kitchen & side-return extension', 'E11', '£70–95k', 'Planning approved', 2],
            ].map(([t, pc, v, s, n]) => (
              <li key={t as string} className="card flat" style={{ padding: 12 }}>
                <div className="row between"><b>{t}</b><span className="mono small">{pc}</span></div>
                <div className="small muted">{v} benchmark · {s} · {n} contractors invited</div>
                <div className="row" style={{ marginTop: 8 }}><button className="btn sm">Price this scope</button><button className="btn ghost sm">Decline</button></div>
              </li>
            ))}</ul>
          </Section>
          <Section title="Your profile" kicker="Verification & performance">
            <dl className="kv">
              <dt>Win rate (90 days)</dt><dd className="num">31%</dd>
              <dt>Avg variance to benchmark</dt><dd className="num">+4.2%</dd>
              <dt>On-time completion</dt><dd className="num">92%</dd>
              <dt>Insurance expiry</dt><dd>14 Mar 2027</dd>
              <dt>Plan</dt><dd>Pro · £79/mo + 2% success fee</dd>
            </dl>
            <p className="xs muted" style={{ marginTop: 8 }}>Submitting itemised quotes against the standard scope (and later, actual invoices) earns a “Verified pricing” badge and higher ranking — and is the data that calibrates the cost engine, with your consent.</p>
          </Section>
        </div>
      )}
    </div>
  );
}
