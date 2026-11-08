import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getProperty } from '../data/properties';
import { refurbInputFor } from '../engine/insights';
import { analyse, DEFAULT_INVESTMENT, scenario, sensitivity, type InvestmentInput, type ScenarioName, type Strategy } from '../engine/investment';
import { estimateRefurb } from '../engine/refurb';
import type { BuyerType, Nation } from '../engine/tax';
import { gbp, gbpK, Money, Pct, Section, Seg, Stacked, Stat, Tag } from '../components/ui';

const STRATS: { value: Strategy; label: string }[] = [
  { value: 'btl', label: 'Buy-to-let' }, { value: 'brrr', label: 'BRRR' }, { value: 'flip', label: 'Flip' }, { value: 'hmo', label: 'HMO' },
];

function heatColour(v: number, base: number) {
  if (v < 0) return 'color-mix(in srgb, var(--danger) 26%, transparent)';
  const r = base ? v / Math.abs(base) : 1;
  return r >= 1.1 ? 'color-mix(in srgb, var(--sage) 28%, transparent)' : r >= 0.9 ? 'color-mix(in srgb, var(--sage) 12%, transparent)' : 'color-mix(in srgb, var(--gold) 22%, transparent)';
}

export default function Investment() {
  const [params] = useSearchParams();
  const prop = getProperty(params.get('property') ?? '');
  const [i, setI] = useState<InvestmentInput>(() => {
    if (!prop || prop.listing === 'rent') return DEFAULT_INVESTMENT;
    const refurb = estimateRefurb(refurbInputFor(prop)).total;
    return { ...DEFAULT_INVESTMENT, price: prop.price, nation: prop.nation, refurbCost: Math.round(refurb / 500) * 500, monthlyRent: prop.estRentPcm, gdv: prop.estGdv };
  });
  const [scen, setScen] = useState<ScenarioName>('base');
  const set = <K extends keyof InvestmentInput>(k: K, v: InvestmentInput[K]) => setI((s) => ({ ...s, [k]: v }));
  const setStrategy = (s: Strategy) => setI((x) => ({
    ...x, strategy: s,
    ...(s === 'hmo' ? { monthlyRent: Math.max(x.monthlyRent, 5 * 725), hmoBillsMonthly: 640, licensingAnnual: 260, managementPct: 0.14, voidPct: 0.06 } : { hmoBillsMonthly: 0, licensingAnnual: 0, managementPct: 0.1 }),
  }));
  const active = useMemo(() => scenario(i, scen), [i, scen]);
  const r = useMemo(() => analyse(active), [active]);
  const all = useMemo(() => (['downside', 'base', 'optimistic'] as ScenarioName[]).map((s) => ({ s, r: analyse(scenario(i, s)) })), [i]);
  const sens = useMemo(() => sensitivity(active), [active]);
  const flip = i.strategy === 'flip';
  const baseMetric = flip ? r.flipProfit : r.monthlyCashflow;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">MVP feature 02</div>
          <h2 style={{ marginTop: 6 }}>Investment underwriter</h2>
          <p className="muted" style={{ marginTop: 6 }}>Every figure below comes from deterministic, unit-tested calculators. Edit any assumption. {prop && <>Prefilled from <Link to={`/property/${prop.id}`}>{prop.title}</Link> with the engine’s refurb estimate.</>}</p>
        </div>
        <Seg value={i.strategy} onChange={setStrategy} options={STRATS} />
      </div>

      <div className="split">
        <div className="stack" style={{ gap: 14 }}>
          <Section title="Acquisition" kicker="Assumptions">
            <div className="grid g2" style={{ gap: 10 }}>
              <Money label="Purchase price" value={i.price} onChange={(v) => set('price', v)} />
              <label className="field">Nation (tax regime)<select className="input" value={i.nation} onChange={(e) => set('nation', e.target.value as Nation)}><option value="england">England (SDLT)</option><option value="northern-ireland">N. Ireland (SDLT)</option><option value="wales">Wales (LTT)</option><option value="scotland">Scotland (LBTT)</option></select></label>
              <label className="field">Buyer status<select className="input" value={i.buyer} onChange={(e) => set('buyer', e.target.value as BuyerType)}><option value="additional">Additional property</option><option value="home-mover">Replacing main home</option><option value="first-time">First-time buyer</option></select></label>
              <label className="field">Ownership<select className="input" value={i.companyPurchase ? 'ltd' : 'personal'} onChange={(e) => set('companyPurchase', e.target.value === 'ltd')}><option value="personal">Personal name</option><option value="ltd">Limited company (SPV)</option></select></label>
              <Money label="Legal fees" value={i.legalFees} onChange={(v) => set('legalFees', v)} step={100} />
              <Money label="Survey" value={i.surveyFees} onChange={(v) => set('surveyFees', v)} step={50} />
              <Money label="Refurbishment" value={i.refurbCost} onChange={(v) => set('refurbCost', v)} />
              <label className="field">Works (months)<input className="input num" type="number" value={i.refurbMonths} onChange={(e) => set('refurbMonths', Number(e.target.value) || 0)} /></label>
            </div>
            <Link to="/estimate" className="xs" style={{ display: 'block', marginTop: 8 }}>Build the refurb figure in the estimator →</Link>
          </Section>
          <Section title="Finance" kicker="Assumptions">
            <div className="grid g2" style={{ gap: 10 }}>
              <Pct label="Deposit %" value={i.depositPct} onChange={(v) => set('depositPct', v)} step={1} />
              <Pct label="Mortgage rate %" value={i.mortgageRate} onChange={(v) => set('mortgageRate', v)} step={0.05} />
              <Pct label="Lender fee %" value={i.lenderFeePct} onChange={(v) => set('lenderFeePct', v)} step={0.1} />
              {(i.strategy === 'brrr' || flip) && <Pct label="Bridging % / month" value={i.bridgingRateMonthly} onChange={(v) => set('bridgingRateMonthly', v)} step={0.05} />}
              {i.strategy === 'brrr' && <Pct label="Refinance LTV %" value={i.refinanceLtv} onChange={(v) => set('refinanceLtv', v)} step={1} />}
              {!flip && <label className="field">Repayment<select className="input" value={i.interestOnly ? 'io' : 'rep'} onChange={(e) => set('interestOnly', e.target.value === 'io')}><option value="io">Interest only</option><option value="rep">Capital repayment</option></select></label>}
            </div>
          </Section>
          <Section title={flip ? 'Exit' : 'Income & running costs'} kicker="Assumptions">
            <div className="grid g2" style={{ gap: 10 }}>
              {!flip && <Money label={i.strategy === 'hmo' ? 'Total room rent pcm' : 'Rent pcm'} value={i.monthlyRent} onChange={(v) => set('monthlyRent', v)} step={25} />}
              {!flip && <Pct label="Voids %" value={i.voidPct} onChange={(v) => set('voidPct', v)} step={0.5} />}
              {!flip && <Pct label="Management %" value={i.managementPct} onChange={(v) => set('managementPct', v)} step={0.5} />}
              {!flip && <Pct label="Maintenance %" value={i.maintenancePct} onChange={(v) => set('maintenancePct', v)} step={0.5} />}
              {!flip && <Money label="Insurance / yr" value={i.insuranceAnnual} onChange={(v) => set('insuranceAnnual', v)} step={10} />}
              {!flip && <Money label="Service charge / ground rent" value={i.serviceChargeAnnual} onChange={(v) => set('serviceChargeAnnual', v)} step={50} />}
              {i.strategy === 'hmo' && <Money label="Bills (landlord-paid) pcm" value={i.hmoBillsMonthly} onChange={(v) => set('hmoBillsMonthly', v)} step={10} />}
              {i.strategy === 'hmo' && <Money label="Licensing / yr" value={i.licensingAnnual} onChange={(v) => set('licensingAnnual', v)} step={10} />}
              {(i.strategy !== 'btl') && <Money label="Post-works value (GDV)" value={i.gdv} onChange={(v) => set('gdv', v)} />}
              {flip && <Pct label="Selling costs %" value={i.sellingCostsPct} onChange={(v) => set('sellingCostsPct', v)} step={0.1} />}
              {(i.strategy === 'brrr' || flip) && <Money label="Holding cost / month" value={i.holdingMonthly} onChange={(v) => set('holdingMonthly', v)} step={10} />}
            </div>
          </Section>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="row between">
            <Seg value={scen} onChange={setScen} options={[{ value: 'downside', label: 'Downside' }, { value: 'base', label: 'Base case' }, { value: 'optimistic', label: 'Optimistic' }]} />
            <div className="row"><Tag kind="est">Projection</Tag><Tag kind="neutral">Pre-tax</Tag></div>
          </div>

          <div className="grid g4 keep2">
            {flip ? <>
              <div className="card"><Stat label="Profit" value={gbpK(r.flipProfit)} tone={r.flipProfit >= 0 ? 'pos' : 'neg'} sub="After all costs, pre-tax" /></div>
              <div className="card"><Stat label="Profit on cost" value={`${(r.profitOnCost * 100).toFixed(1)}%`} sub="Lenders look for 15–20%" /></div>
              <div className="card"><Stat label="Annualised ROI on cash" value={`${(r.annualisedRoi * 100).toFixed(0)}%`} sub={`${i.refurbMonths + 3} month project`} /></div>
              <div className="card"><Stat label="Cash required" value={gbpK(r.cashInvested)} sub="Deposit + costs + works" /></div>
            </> : <>
              <div className="card"><Stat label="Monthly cash flow" value={gbp(r.monthlyCashflow)} tone={r.monthlyCashflow >= 0 ? 'pos' : 'neg'} sub="After finance, pre-tax" /></div>
              <div className="card"><Stat label="Cash-on-cash" value={Number.isFinite(r.cashOnCash) ? `${(r.cashOnCash * 100).toFixed(1)}%` : '∞ (all cash out)'} sub={`On ${gbpK(r.cashInvested)} left in`} /></div>
              <div className="card"><Stat label="Gross / net yield" value={`${(r.grossYield * 100).toFixed(1)}% / ${(r.netYield * 100).toFixed(1)}%`} sub="Net = NOI ÷ all-in cost" /></div>
              <div className="card"><Stat label="Lender stress test" value={<span className={r.icrPass ? 'pos' : 'neg'}>{r.icrPass ? 'Pass' : 'Fail'} · {(r.icr * 100).toFixed(0)}%</span>} sub={`ICR req. ${(r.icrRequired * 100).toFixed(0)}% @ ${(r.stressRate * 100).toFixed(1)}%`} /></div>
            </>}
          </div>

          {i.strategy === 'brrr' && (
            <div className="card">
              <div className="grid g4 keep2">
                <Stat label="Cash in before refinance" value={gbpK(r.acquisition.total - r.loan + i.refurbCost + r.breakdown.filter((b) => ['Lender fees', 'Bridging interest', 'Holding costs'].includes(b.label)).reduce((s, b) => s + b.value, 0))} />
                <Stat label="Refinance loan" value={gbpK(r.refinanceLoan)} sub={`${Math.round(i.refinanceLtv * 100)}% of ${gbpK(active.gdv)}`} />
                <Stat label="Money left in" value={gbpK(r.moneyLeftIn)} tone={r.moneyLeftIn <= 0 ? 'pos' : undefined} />
                <Stat label="Equity created" value={gbpK(active.gdv - r.refinanceLoan - Math.max(0, r.moneyLeftIn))} />
              </div>
            </div>
          )}

          <Section title="Where the cash goes" kicker="Capital stack">
            <Stacked parts={r.breakdown.map((b, k) => ({ label: b.label, value: b.value, color: ['var(--ink)', 'var(--accent)', 'var(--blue)', 'var(--gold)', 'var(--sage)', '#8a6fb0', '#9aa0a6'][k % 7] }))} />
            <div className="grid g3" style={{ marginTop: 14 }}>
              <Stat label={`${r.acquisition.taxName}`} value={gbp(r.acquisition.tax)} sub={i.companyPurchase ? 'Company purchase: higher rates' : i.buyer === 'additional' ? 'Higher rates for additional dwellings' : 'Main residence rates'} />
              <Stat label="Loan" value={gbpK(r.loan)} sub={`${Math.round((1 - i.depositPct) * 100)}% LTV on purchase`} />
              {!flip && <Stat label="Annual finance cost" value={gbpK(r.annualFinance)} sub={`Annual running costs ${gbpK(r.annualCosts)}`} />}
            </div>
          </Section>

          <Section title="Scenario comparison" kicker="Downside · base · optimistic">
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Metric</th>{all.map((a) => <th key={a.s} className="r">{a.s}</th>)}</tr></thead>
              <tbody>
                {flip ? <>
                  <tr><td>Profit</td>{all.map((a) => <td key={a.s} className={`r num ${a.r.flipProfit < 0 ? 'neg' : ''}`}>{gbpK(a.r.flipProfit)}</td>)}</tr>
                  <tr><td>Profit on cost</td>{all.map((a) => <td key={a.s} className="r num">{(a.r.profitOnCost * 100).toFixed(1)}%</td>)}</tr>
                </> : <>
                  <tr><td>Monthly cash flow</td>{all.map((a) => <td key={a.s} className={`r num ${a.r.monthlyCashflow < 0 ? 'neg' : ''}`}>{gbp(a.r.monthlyCashflow)}</td>)}</tr>
                  <tr><td>Net yield</td>{all.map((a) => <td key={a.s} className="r num">{(a.r.netYield * 100).toFixed(2)}%</td>)}</tr>
                  <tr><td>Cash left in</td>{all.map((a) => <td key={a.s} className="r num">{gbpK(a.r.cashInvested)}</td>)}</tr>
                  <tr><td>ICR</td>{all.map((a) => <td key={a.s} className={`r num ${a.r.icrPass ? '' : 'neg'}`}>{(a.r.icr * 100).toFixed(0)}%</td>)}</tr>
                </>}
              </tbody>
            </table></div>
            <p className="xs muted" style={{ marginTop: 8 }}>Downside: rent −8%, GDV −7%, refurb +15%, rate +1pt, voids +4pts. Optimistic: rent +5%, GDV +4%, refurb −5%, rate −0.5pt.</p>
          </Section>

          <Section title={`Sensitivity: ${flip ? 'profit' : 'monthly cash flow'}`} kicker={`${sens.rowLabel} × ${sens.colLabel}`}>
            <div className="table-wrap"><table className="t heat">
              <thead><tr><th>{sens.rowLabel} ↓ / {sens.colLabel} →</th>{sens.cols.map((c) => <th key={c} className="r">{c > 0 ? '+' : ''}{Math.round(c * 100)}%</th>)}</tr></thead>
              <tbody>{sens.rows.map((row) => (
                <tr key={row.shift}><td style={{ textAlign: 'left', fontFamily: 'var(--sans)' }}>{flip ? `${row.shift > 0 ? '+' : ''}${Math.round(row.shift * 100)}%` : `${((active.mortgageRate + row.shift) * 100).toFixed(2)}%`}</td>
                  {row.cells.map((c, k) => <td key={k} style={{ background: heatColour(c, baseMetric), outline: row.shift === 0 && sens.cols[k] === 0 ? '2px solid var(--ink)' : undefined }}>{flip ? gbpK(c) : gbp(c)}</td>)}</tr>
              ))}</tbody>
            </table></div>
          </Section>

          {r.warnings.length > 0 && <div className="callout"><b>Underwriting flags</b><ul className="ticks" style={{ marginTop: 6 }}>{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
          <p className="xs muted">Not financial or tax advice. Tax treatment depends on personal circumstances; Section 24, CGT, corporation tax and lender criteria vary. Consult an FCA-regulated mortgage adviser and a qualified tax adviser.</p>
        </div>
      </div>
    </div>
  );
}
