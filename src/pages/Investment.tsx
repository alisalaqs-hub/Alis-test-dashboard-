import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getProperty } from '../data/properties';
import { refurbInputFor } from '../engine/insights';
import { analyse, breakEven, DEFAULT_INVESTMENT, scenario, sensitivity, type InvestmentInput, type ScenarioName, type Strategy } from '../engine/investment';
import { estimateRefurb } from '../engine/refurb';
import type { BuyerType, Nation } from '../engine/tax';
import { gbp, gbpK, Money, Pct, Section, Seg, Stacked, Stat, Tag } from '../components/ui';
import { AiButton, AiCard, AiDisclaimer, AiErrorNote, AiThinking, AiUnavailable } from '../components/ai/Ai';
import { aiPost, useAi, useAiAction } from '../lib/ai/core';
import { ruleVerdict, VERDICT_LABEL, type InvestVerdictResult, type Verdict } from '../lib/ai/property';
import '../components/ai/property.css';

const SCEN_LABEL: Record<ScenarioName, string> = { downside: 'Downside', base: 'Base', optimistic: 'Optimistic' };

function AiList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div><div className="ai-prop-h">{title}</div><ul className="ai-prop-list">{items.map((t) => <li key={t}>{t}</li>)}</ul></div>;
}

/** Streetkey's rule-based rating (always shown), plus an AI reading of the same recomputed numbers. */
function VerdictPanel({ i, scen, propertyId, rule }: { i: InvestmentInput; scen: ScenarioName; propertyId?: string; rule: { verdict: Verdict; reasons: string[] } }) {
  const { available, reason } = useAi();
  const [asked, setAsked] = useState<string | null>(null);
  const v = useAiAction((body: { propertyId?: string; strategy: Strategy; inputs: InvestmentInput; scenario: ScenarioName }) =>
    aiPost<{ verdict: InvestVerdictResult }>('/api/ai/invest/explain', body).then((r) => r.verdict));
  const key = JSON.stringify([i, scen, propertyId ?? null]);
  const run = () => { setAsked(key); void v.run({ ...(propertyId ? { propertyId } : {}), strategy: i.strategy, inputs: i, scenario: scen }); };
  const x = v.data;
  const n = x?.numbers;
  return (
    <Section title="Verdict" kicker={`${SCEN_LABEL[scen]} case`} right={<Tag kind="neutral">Not financial advice</Tag>}>
      <div className="pv-rule">
        <div className="row"><span className={`pv-verdict ${rule.verdict}`}>{VERDICT_LABEL[rule.verdict]}</span><span className="small muted">Streetkey’s rule-based rating of the figures above</span></div>
        <ul className="ticks small">{rule.reasons.map((t) => <li key={t}>{t}</li>)}</ul>
      </div>
      <div style={{ marginTop: 12 }}>
        {!available ? <AiUnavailable reason={reason} feature="The AI verdict" /> : (
          <AiCard title="AI verdict" footer={x && !v.busy ? <AiDisclaimer>{x.disclaimer}</AiDisclaimer> : undefined}>
            {!x && !v.busy && <>
              <p className="small muted" style={{ margin: 0 }}>An AI reading of this scenario: strengths, risks, what has to be true and what to ask. It works from Streetkey’s own calculations and never adds figures of its own.</p>
              <div><AiButton onClick={run}>Get an AI verdict</AiButton></div>
            </>}
            {v.busy && <AiThinking label="Reviewing the numbers" />}
            <AiErrorNote error={v.error} onRetry={run} />
            {x && n && !v.busy && <>
              {asked !== key && <div className="callout small ai-prop-stale" role="status">You’ve changed the assumptions since this verdict. <button type="button" className="btn ghost sm" onClick={run}>Update verdict</button></div>}
              <div className="row" style={{ alignItems: 'baseline' }}><span className={`pv-verdict ${x.verdict}`}>{VERDICT_LABEL[x.verdict]}</span><b>{x.headline}</b></div>
              {x.verdictCapped && <p className="ai-prop-note">The AI rated this more highly than the numbers support, so Streetkey kept its rule-based rating and left out the AI’s strengths. The headline, what must be true and the stress-test reading are Streetkey’s own.</p>}
              <div className="ai-prop-cols">
                <AiList title="Strengths" items={x.strengths} />
                <AiList title="Risks" items={x.risks} />
                <AiList title="What must be true" items={x.whatMustBeTrue} />
                <AiList title="Questions to ask" items={x.questionsToAsk} />
              </div>
              <div><div className="ai-prop-h">Stress test</div><p className="small" style={{ margin: 0 }}>{x.stressTestReading}</p></div>
              <div>
                <div className="ai-prop-h">Recomputed by Streetkey for this verdict ({SCEN_LABEL[x.scenario].toLowerCase()} case)</div>
                <div className="ai-chips pv-numbers">
                  {x.strategy === 'flip' ? <>
                    <span className="ai-chip">Profit <b>{gbp(n.flipProfit)}</b></span>
                    <span className="ai-chip">On cost <b>{(n.profitOnCost * 100).toFixed(1)}%</b></span>
                    <span className="ai-chip">Downside profit <b>{gbp(n.downsideFlipProfit)}</b></span>
                    {n.breakEvenSalePrice != null && <span className="ai-chip">Break-even sale <b>{gbpK(n.breakEvenSalePrice)}</b></span>}
                  </> : <>
                    <span className="ai-chip">Cash flow <b>{gbp(n.monthlyCashflow)}</b> a month</span>
                    <span className="ai-chip">Downside <b>{gbp(n.downsideMonthlyCashflow)}</b> a month</span>
                    <span className="ai-chip">Net yield <b>{(n.netYield * 100).toFixed(1)}%</b></span>
                    <span className="ai-chip">Stress test <b>{n.icrPass ? 'pass' : 'fail'}</b>{n.icr != null ? ` (${(n.icr * 100).toFixed(0)}%)` : ''}</span>
                  </>}
                  <span className="ai-chip">{n.taxName} <b>{gbp(n.transactionTax)}</b></span>
                </div>
              </div>
              {x.removedClaims > 0 && <p className="ai-prop-note">{x.removedClaims} statement{x.removedClaims === 1 ? ' was' : 's were'} left out because {x.removedClaims === 1 ? 'it quoted a figure' : 'they quoted figures'} Streetkey didn’t calculate.</p>}
            </>}
          </AiCard>
        )}
      </div>
    </Section>
  );
}

const STRATS: { value: Strategy; label: string }[] = [
  { value: 'btl', label: 'Buy-to-let' }, { value: 'brrr', label: 'BRRR' }, { value: 'flip', label: 'Flip' }, { value: 'hmo', label: 'HMO' }, { value: 'commercial', label: 'Commercial' },
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
    const fromDesign = Number(params.get('refurb')) || 0;
    if (!prop || prop.listing === 'rent') return fromDesign ? { ...DEFAULT_INVESTMENT, refurbCost: fromDesign } : DEFAULT_INVESTMENT;
    const refurb = fromDesign || estimateRefurb(refurbInputFor(prop)).total;
    if (prop.type === 'commercial') return { ...DEFAULT_INVESTMENT, strategy: 'commercial', buyer: 'additional', price: prop.price, nation: prop.nation, refurbCost: Math.round(refurb / 500) * 500, monthlyRent: Math.round((prop.floorArea * 10.764 * 19) / 12), voidPct: 0.1, managementPct: 0.03, maintenancePct: 0.02, gdv: prop.price, depositPct: 0.35, mortgageRate: 0.065 };
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
  const be = useMemo(() => breakEven(active), [active]);
  const designLabel = params.get('label');
  const baseMetric = flip ? r.flipProfit : r.monthlyCashflow;
  const rule = useMemo(() => ruleVerdict(i.strategy, r, all[0].r), [i.strategy, r, all]);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">AI investment analyser</div>
          <h2 style={{ marginTop: 6 }}>Investment underwriter</h2>
          {designLabel && <div className="callout ok small" style={{ marginTop: 8 }}>Refurbishment of {gbp(Number(params.get('refurb')))} imported from your <b>{designLabel}</b> design concept. <Link to={`/studio?property=${prop?.id ?? ''}`}>Back to studio</Link></div>}
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

          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 8 }}>Break-even points</div>
            <div className="grid g4 keep2">
              {flip ? <Stat label="Break-even sale price" value={gbpK(be.salePrice)} sub={`${(((active.gdv - be.salePrice) / active.gdv) * 100).toFixed(1)}% below GDV`} /> : <>
                <Stat label="Break-even rent" value={`${gbp(be.rent)} pcm`} sub={`${(((active.monthlyRent - be.rent) / active.monthlyRent) * 100).toFixed(0)}% cushion vs assumed rent`} />
                <Stat label="Break-even occupancy" value={`${Math.min(999, be.occupancy * 100).toFixed(0)}%`} sub="Of months let per year" />
                <Stat label="Break-even interest rate" value={Number.isFinite(be.rate) ? `${(be.rate * 100).toFixed(2)}%` : '—'} sub="Interest-only equivalent" />
                <Stat label="ROI on cash (yr 1, pre-tax)" value={Number.isFinite(r.cashOnCash) ? `${(r.cashOnCash * 100).toFixed(1)}%` : '∞'} sub="Cash flow ÷ cash left in" />
              </>}
            </div>
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

          <VerdictPanel i={i} scen={scen} propertyId={prop?.id} rule={rule} />

          <Section title="Where the cash goes" kicker="Capital stack">
            <Stacked parts={r.breakdown.map((b, k) => ({ label: b.label, value: b.value, color: ['var(--ink)', 'var(--accent)', 'var(--blue)', 'var(--gold)', 'var(--sage)', '#8a6fb0', '#9aa0a6'][k % 7] }))} />
            <div className="grid g3" style={{ marginTop: 14 }}>
              <Stat label={`${r.acquisition.taxName}`} value={gbp(r.acquisition.tax)} sub={i.companyPurchase ? 'Company purchase: higher rates' : i.buyer === 'additional' ? 'Higher rates for additional dwellings' : 'Main residence rates'} />
              <Stat label="Loan" value={gbpK(r.loan)} sub={`${Math.round((1 - i.depositPct) * 100)}% LTV on purchase`} />
              {!flip && <Stat label="Annual finance cost" value={gbpK(r.annualFinance)} sub={`Annual running costs ${gbpK(r.annualCosts)}`} />}
            </div>
          </Section>

          <Section title="Scenario comparison" kicker="Downside · base · optimistic">
            <div className="table-wrap" tabIndex={0}><table className="t">
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
            <div className="table-wrap" tabIndex={0}><table className="t heat">
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
