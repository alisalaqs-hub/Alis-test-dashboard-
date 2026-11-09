import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getProperty, type Property } from '../data/properties';
import { refurbInputFor } from '../engine/insights';
import { analyse, breakEven, DEFAULT_INVESTMENT, scenario, sensitivity, type InvestmentInput, type ScenarioName, type Strategy } from '../engine/investment';
import { estimateRefurb } from '../engine/refurb';
import type { BuyerType, Nation } from '../engine/tax';
import { gbp, gbpK, Money, NumberField, pct, Pct, Section, Seg, Stacked, Stat, Tag } from '../components/ui';
import { AiButton, AiCard, AiDisclaimer, AiErrorNote, AiThinking, AiUnavailable } from '../components/ai/Ai';
import { aiPost, useAi, useAiAction } from '../lib/ai/core';
import { ACCOUNT_CHANGED_EVENT } from '../lib/server';
import { INVEST_LIMITS, investInputProblem, investInputsProblems, ruleVerdict, VERDICT_LABEL, VERDICTS, type InvestVerdictResult, type Verdict } from '../lib/ai/property';
import '../components/ai/property.css';

const SCEN_LABEL: Record<ScenarioName, string> = { downside: 'Downside', base: 'Base', optimistic: 'Optimistic' };
const L = INVEST_LIMITS;
type LimitKey = keyof typeof INVEST_LIMITS;
/** Money and Pct bounds from the table the server checks against (Pct takes them in percent). */
const money = (k: LimitKey) => ({ min: L[k].min, max: L[k].max });
const percent = (k: LimitKey) => ({ min: +(L[k].min * 100).toFixed(4), max: +(L[k].max * 100).toFixed(4) });

/** Names for the assumptions people can get wrong, for "fix these first" messages. */
const ASSUMPTION_LABEL: Partial<Record<LimitKey, string>> = {
  price: 'Purchase price', legalFees: 'Legal fees', surveyFees: 'Survey', refurbCost: 'Refurbishment', refurbMonths: 'Works (months)', depositPct: 'Deposit',
  mortgageRate: 'Mortgage rate', lenderFeePct: 'Lender fee', bridgingRateMonthly: 'Bridging rate', refinanceLtv: 'Refinance LTV', monthlyRent: 'Rent',
  voidPct: 'Voids', managementPct: 'Management', maintenancePct: 'Maintenance', insuranceAnnual: 'Insurance', serviceChargeAnnual: 'Service charge / ground rent',
  hmoBillsMonthly: 'Bills', licensingAnnual: 'Licensing', gdv: 'Post-works value (GDV)', sellingCostsPct: 'Selling costs', holdingMonthly: 'Holding cost',
};

/** A titled list in the AI verdict; the title is a heading below the card's. */
function AiList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div><h5 className="ai-prop-h">{title}</h5><ul className="ai-prop-list">{items.map((t) => <li key={t}>{t}</li>)}</ul></div>;
}

/** Which fields hold something that can't be used yet (reported by Money, Pct and NumberField). */
function useFieldValidity() {
  const [bad, setBad] = useState<string[]>([]);
  const track = useCallback((name: string) => (valid: boolean) => setBad((b) => (valid ? b.filter((x) => x !== name) : b.includes(name) ? b : [...b, name])), []);
  return { bad, track };
}

/** Streetkey's rule-based rating (always shown), plus an AI reading of the same recomputed numbers. */
function VerdictPanel({ i, scen, propertyId, rule, cannotRate, blocked }: {
  i: InvestmentInput; scen: ScenarioName; propertyId?: string; rule: { verdict: Verdict; reasons: string[] } | null; cannotRate: string | null; blocked: string | null;
}) {
  const { available, reason } = useAi();
  const [asked, setAsked] = useState<string | null>(null);
  const v = useAiAction((body: { propertyId?: string; strategy: Strategy; inputs: InvestmentInput; scenario: ScenarioName }) =>
    aiPost<{ verdict: InvestVerdictResult }>('/api/ai/invest/explain', body).then((r) => r.verdict), { label: 'AI verdict' });
  const key = JSON.stringify([i, scen, propertyId ?? null]);
  const { clearError } = v;
  useEffect(() => { clearError(); }, [key, clearError]); // an error about earlier assumptions no longer applies
  const stop = cannotRate ?? blocked;
  const run = () => { if (stop) return; setAsked(key); void v.run({ ...(propertyId ? { propertyId } : {}), strategy: i.strategy, inputs: i, scenario: scen }); };
  const x = v.data;
  const n = x?.numbers;
  const hintId = useId();
  const cautious = !!x && !x.verdictCapped && VERDICTS.indexOf(x.verdict) < VERDICTS.indexOf(x.ruleVerdict);
  return (
    <Section title="Verdict" kicker={`${SCEN_LABEL[scen]} case`} right={<Tag kind="neutral">Not financial advice</Tag>}>
      <div className="pv-rule">
        {rule ? <>
          <div className="row"><span className={`pv-verdict ${rule.verdict}`}>{VERDICT_LABEL[rule.verdict]}</span><span className="small muted">Streetkey’s rule-based rating of the figures above</span></div>
          <ul className="ticks small">{rule.reasons.map((t) => <li key={t}>{t}</li>)}</ul>
        </> : <p className="small" style={{ margin: 0 }}><b>No rating yet.</b> {cannotRate}</p>}
      </div>
      <div style={{ marginTop: 12 }}>
        {!available ? <AiUnavailable reason={reason} feature="The AI verdict" /> : (
          <AiCard title="AI verdict" headingLevel={4} focusKey={x} footer={x && !v.busy ? <AiDisclaimer>{x.disclaimer}</AiDisclaimer> : undefined}>
            {!x && <>
              <p className="small muted" style={{ margin: 0 }}>An AI reading of this scenario: strengths, risks, what has to be true and what to ask. It works from Streetkey’s own calculations and never adds figures of its own.</p>
              <div className="row">
                <AiButton busy={v.busy} disabled={!!stop} onClick={run} busyLabel="Reviewing…" aria-describedby={stop ? hintId : undefined}>Get an AI verdict</AiButton>
                {stop && <span id={hintId} className="xs muted">{stop}</span>}
              </div>
            </>}
            {v.busy && <AiThinking label="Reviewing the numbers" />}
            <AiErrorNote error={v.error} onRetry={stop ? undefined : run} />
            {x && n && !v.busy && <>
              {asked !== key && <div className="callout small ai-prop-stale" role="status">
                You’ve changed the assumptions since this verdict.{' '}
                <AiButton kind="ghost" size="sm" disabled={!!stop} onClick={run}>Update verdict</AiButton>
              </div>}
              <div className="row" style={{ alignItems: 'baseline' }}><span className="sr-only">Streetkey AI’s verdict: </span><span className={`pv-verdict ${x.verdict}`}>{VERDICT_LABEL[x.verdict]}</span><b>{x.headline}</b></div>
              {x.verdictCapped && <p className="ai-prop-note">The AI rated this more highly than the numbers support, so Streetkey kept its rule-based rating and left out the AI’s strengths. The headline, what must be true and the stress-test reading are Streetkey’s own.</p>}
              {cautious && <p className="ai-prop-note">
                Streetkey AI is more cautious than Streetkey’s rule-based rating ({VERDICT_LABEL[x.ruleVerdict]}){x.cautionReason ? <>: {x.cautionReason}</> : '. The risks below say why.'}
              </p>}
              <div className="ai-prop-cols">
                <AiList title="Strengths" items={x.strengths} />
                <AiList title="Risks" items={x.risks} />
                <AiList title="What must be true" items={x.whatMustBeTrue} />
                <AiList title="Questions to ask" items={x.questionsToAsk} />
              </div>
              <div><h5 className="ai-prop-h">Stress test</h5><p className="small" style={{ margin: 0 }}>{x.stressTestReading}</p></div>
              <div>
                <h5 className="ai-prop-h">Recomputed by Streetkey for this verdict ({SCEN_LABEL[x.scenario].toLowerCase()} case)</h5>
                <div className="ai-chips pv-numbers">
                  {x.strategy === 'flip' ? <>
                    <span className="ai-chip">Profit <b>{gbp(n.flipProfit)}</b></span>
                    <span className="ai-chip">On cost <b>{pct(n.profitOnCost)}</b></span>
                    <span className="ai-chip">Downside profit <b>{gbp(n.downsideFlipProfit)}</b></span>
                    {n.breakEvenSalePrice != null && <span className="ai-chip">Break-even sale <b>{gbpK(n.breakEvenSalePrice)}</b></span>}
                  </> : <>
                    <span className="ai-chip">Cash flow <b>{gbp(n.monthlyCashflow)}</b> a month</span>
                    <span className="ai-chip">Downside <b>{gbp(n.downsideMonthlyCashflow)}</b> a month</span>
                    <span className="ai-chip">Net yield <b>{pct(n.netYield)}</b></span>
                    <span className="ai-chip">Stress test <b>{n.icrPass ? 'pass' : 'fail'}</b>{n.icr != null ? ` (${pct(n.icr, 0)})` : ''}</span>
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

const STRATS: { value: Strategy; label: string; ariaLabel?: string }[] = [
  { value: 'btl', label: 'Buy-to-let' }, { value: 'brrr', label: 'BRRR', ariaLabel: 'BRRR: buy, refurbish, refinance, rent' }, { value: 'flip', label: 'Flip' },
  { value: 'hmo', label: 'HMO', ariaLabel: 'HMO: house in multiple occupation' }, { value: 'commercial', label: 'Commercial' },
];

function heatColour(v: number, base: number) {
  if (v < 0) return 'color-mix(in srgb, var(--danger) 26%, transparent)';
  const r = base ? v / Math.abs(base) : 1;
  return r >= 1.1 ? 'color-mix(in srgb, var(--sage) 28%, transparent)' : r >= 0.9 ? 'color-mix(in srgb, var(--sage) 12%, transparent)' : 'color-mix(in srgb, var(--gold) 22%, transparent)';
}

/** A refurbishment cost brought in from the estimator or the design studio (?refurb=&from=&label=). */
interface Imported { amount: number; from: 'estimate' | 'studio'; label: string }
function importedRefurb(params: URLSearchParams): Imported | null {
  const raw = params.get('refurb');
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0 || n > L.refurbCost.max) return null;
  const label = (params.get('label') ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const from = params.get('from') === 'estimate' || (!params.get('from') && /whole-house estimate/i.test(label)) ? 'estimate' : 'studio';
  return { amount: Math.round(n), from, label };
}

/** The starting assumptions: from the listing (if any), with an imported refurbishment cost used exactly as quoted. */
function startingInputs(prop: Property | null, imported: number | null): InvestmentInput {
  if (!prop || prop.listing === 'rent') return imported ? { ...DEFAULT_INVESTMENT, refurbCost: imported } : DEFAULT_INVESTMENT;
  // Only the engine's own estimate is rounded (to £500); an imported figure matches the banner to the pound.
  const refurb = imported ?? Math.round(estimateRefurb(refurbInputFor(prop)).total / 500) * 500;
  if (prop.type === 'commercial') return { ...DEFAULT_INVESTMENT, strategy: 'commercial', buyer: 'additional', price: prop.price, nation: prop.nation, refurbCost: refurb, monthlyRent: Math.round((prop.floorArea * 10.764 * 19) / 12), voidPct: 0.1, managementPct: 0.03, maintenancePct: 0.02, gdv: prop.price, depositPct: 0.35, mortgageRate: 0.065 };
  return { ...DEFAULT_INVESTMENT, price: prop.price, nation: prop.nation, refurbCost: refurb, monthlyRent: prop.estRentPcm, gdv: prop.estGdv };
}

/* ───────────────────────── keeping what people typed ───────────────────────── */
/** The assumptions are kept for this visit (sessionStorage), per property and imported figure, so signing in or a reload never loses them. */
interface Draft { inputs: InvestmentInput; scen: ScenarioName }
const DRAFT_PREFIX = 'streetkey-draft:invest:';
function readDraft(key: string, base: InvestmentInput): Draft | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Draft> | null;
    const i = v?.inputs;
    if (!i || typeof i !== 'object' || typeof i.price !== 'number' || typeof i.strategy !== 'string' || !STRATS.some((s) => s.value === i.strategy)) return null;
    const scen: ScenarioName = v?.scen === 'downside' || v?.scen === 'optimistic' ? v.scen : 'base';
    return { inputs: { ...base, ...i }, scen };
  } catch { return null; }
}
const writeDraft = (key: string, d: Draft) => { try { sessionStorage.setItem(key, JSON.stringify(d)); } catch { /* storage unavailable: nothing kept */ } };
const dropDraft = (key: string) => { try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ } };
/** Forgets every property's kept assumptions in this tab. */
function dropAllDrafts() {
  try {
    const keys: string[] = [];
    for (let n = 0; n < sessionStorage.length; n++) { const k = sessionStorage.key(n); if (k?.startsWith(DRAFT_PREFIX)) keys.push(k); }
    for (const k of keys) sessionStorage.removeItem(k);
  } catch { /* storage unavailable: nothing was kept */ }
}
// The assumptions belong to whoever typed them: when this tab signs out or changes account they are forgotten, so the
// next person never sees them. Registered once, when the page is first opened, so it also covers a sign-out made elsewhere.
if (typeof window !== 'undefined') window.addEventListener(ACCOUNT_CHANGED_EVENT, dropAllDrafts);

/** "12.5% below GDV" / "3.1% above GDV: no cushion": worded from the sign, and "—" when there's nothing to compare with. */
function cushionText(assumed: number, breakEvenAt: number, below: string, above: string) {
  if (!(assumed > 0) || !Number.isFinite(breakEvenAt)) return '—';
  const c = (assumed - breakEvenAt) / assumed;
  return c >= 0 ? `${pct(c)} ${below}` : `${pct(-c)} ${above}`;
}

/** Starts the page afresh (no kept assumptions, no AI verdict) when the person using this tab signs out or the account changes. */
export default function Investment() {
  const [person, setPerson] = useState(0);
  useEffect(() => {
    const next = () => setPerson((n) => n + 1);
    window.addEventListener(ACCOUNT_CHANGED_EVENT, next);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, next);
  }, []);
  return <InvestmentPage key={person} restarted={person > 0} />;
}

function InvestmentPage({ restarted }: { restarted: boolean }) {
  const [params] = useSearchParams();
  // App.tsx starts this page afresh whenever ?property=, ?refurb=, ?from= or ?label= changes, so they are read once.
  const [prop] = useState(() => getProperty(params.get('property') ?? '') ?? null);
  const [imported] = useState(() => importedRefurb(params));
  const draftKey = `${DRAFT_PREFIX}${prop?.id ?? 'example'}:${imported ? `${imported.from}-${imported.amount}` : 'none'}`;
  const start = useMemo(() => startingInputs(prop, imported?.amount ?? null), [prop, imported]);
  const [initial] = useState(() => { const d = readDraft(draftKey, start); return { inputs: d?.inputs ?? start, scen: d?.scen ?? 'base', restored: !!d }; });
  const [i, setI] = useState<InvestmentInput>(initial.inputs);
  const [scen, setScen] = useState<ScenarioName>(initial.scen);
  const [restored, setRestored] = useState(initial.restored);
  const { bad, track } = useFieldValidity();
  const headRef = useRef<HTMLHeadingElement>(null);
  const set = <K extends keyof InvestmentInput>(k: K, v: InvestmentInput[K]) => setI((s) => ({ ...s, [k]: v }));
  const setStrategy = (s: Strategy) => setI((x) => ({
    ...x, strategy: s,
    ...(s === 'hmo' ? { monthlyRent: Math.max(x.monthlyRent, 5 * 725), hmoBillsMonthly: 640, licensingAnnual: 260, managementPct: 0.14, voidPct: 0.06 } : { hmoBillsMonthly: 0, licensingAnnual: 0, managementPct: 0.1 }),
  }));

  // Kept once the assumptions differ from the starting ones (nothing to keep otherwise).
  useEffect(() => {
    const d: Draft = { inputs: i, scen };
    if (JSON.stringify(d) === JSON.stringify({ inputs: start, scen: 'base' })) dropDraft(draftKey); else writeDraft(draftKey, d);
  }, [draftKey, i, scen, start]);
  const startAgain = () => {
    dropDraft(draftKey);
    setI(start); setScen('base'); setRestored(false);
    requestAnimationFrame(() => headRef.current?.focus());
  };
  // Restarted after a sign-out or account change: if focus was in the page, it goes to the heading, not <body>.
  useEffect(() => {
    if (restarted && (!document.activeElement || document.activeElement === document.body)) headRef.current?.focus({ preventScroll: true });
  }, [restarted]);

  const active = useMemo(() => scenario(i, scen), [i, scen]);
  const r = useMemo(() => analyse(active), [active]);
  const all = useMemo(() => (['downside', 'base', 'optimistic'] as ScenarioName[]).map((s) => ({ s, r: analyse(scenario(i, s)) })), [i]);
  const sens = useMemo(() => sensitivity(active), [active]);
  const flip = i.strategy === 'flip';
  const be = useMemo(() => breakEven(active), [active]);
  const baseMetric = flip ? r.flipProfit : r.monthlyCashflow;
  // Without a price, or rent (a sale value for a flip), the ratios divide by zero: say what's missing instead of rating noise.
  const cannotRate = investInputProblem(i);
  const rule = useMemo(() => (cannotRate ? null : ruleVerdict(i.strategy, r, all[0].r)), [cannotRate, i.strategy, r, all]);
  // A box hidden by a strategy change keeps its last good value, so its "can't use this" report no longer applies.
  const shown = useMemo(() => {
    const st = i.strategy, letting = st !== 'flip', bridged = st === 'brrr' || st === 'flip';
    const keys: LimitKey[] = ['price', 'legalFees', 'surveyFees', 'refurbCost', 'refurbMonths', 'depositPct', 'mortgageRate', 'lenderFeePct'];
    if (bridged) keys.push('bridgingRateMonthly', 'holdingMonthly');
    if (st === 'brrr') keys.push('refinanceLtv');
    if (letting) keys.push('monthlyRent', 'voidPct', 'managementPct', 'maintenancePct', 'insuranceAnnual', 'serviceChargeAnnual');
    if (st === 'hmo') keys.push('hmoBillsMonthly', 'licensingAnnual');
    if (st !== 'btl') keys.push('gdv');
    if (st === 'flip') keys.push('sellingCostsPct');
    return new Set<string>(keys);
  }, [i.strategy]);
  const outOfRange = useMemo(() => Object.keys(investInputsProblems(i)), [i]);
  const fix = [...new Set([...outOfRange, ...bad.filter((k) => shown.has(k))])].map((k) => ASSUMPTION_LABEL[k as LimitKey] ?? k);
  const blocked = fix.length ? `To use Streetkey AI, first fix ${fix.length === 1 ? 'this assumption' : 'these assumptions'}: ${fix.join(', ')}.` : null;
  const demoEstimates = !!prop && !!prop.source && prop.source.kind !== 'demo' && prop.listing !== 'rent';
  const backTo = imported?.from === 'estimate'
    ? { to: `/estimate${prop ? `?property=${encodeURIComponent(prop.id)}` : ''}`, text: 'Back to the estimator' }
    : { to: `/studio${prop ? `?property=${encodeURIComponent(prop.id)}` : ''}`, text: 'Back to the studio' };
  const icrText = (icr: number) => (Number.isFinite(icr) ? pct(icr, 0) : 'no loan');

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">AI investment analyser</div>
          <h2 ref={headRef} tabIndex={-1} style={{ marginTop: 6 }}>Investment underwriter</h2>
          {imported && <div className="callout ok small" style={{ marginTop: 8 }}>
            Refurbishment of {gbp(imported.amount)} imported from {imported.from === 'estimate' ? <>your whole-house estimate</> : <>your <b>{imported.label || 'design'}</b> design concept</>}. <Link to={backTo.to}>{backTo.text}</Link>
          </div>}
          <p className="muted" style={{ marginTop: 6 }}>Every figure below comes from deterministic, unit-tested calculators. Edit any assumption. {prop && <>Prefilled from <Link to={`/property/${prop.id}`}>{prop.title}</Link>{imported ? '' : ' with the engine’s refurb estimate'}.</>}</p>
          {demoEstimates && <p className="xs muted" style={{ marginTop: 4 }}>The rent and post-works value are Streetkey estimates from demonstration evidence, not from this listing: check them against local lettings and sold prices.</p>}
          {restored && <p className="callout info small" style={{ marginTop: 8 }}>We’ve kept the assumptions you entered earlier in this visit. <button type="button" className="linkish" onClick={startAgain}>Start again{prop ? ' from the listing' : ''}</button></p>}
        </div>
        <Seg aria-label="Strategy" value={i.strategy} onChange={setStrategy} options={STRATS} />
      </div>

      <div className="split">
        <div className="stack" style={{ gap: 14 }}>
          <Section title="Acquisition" kicker="Assumptions">
            <div className="grid g2" style={{ gap: 10 }}>
              <Money label="Purchase price" value={i.price} onChange={(v) => set('price', v)} {...money('price')} onValidityChange={track('price')} />
              <label className="field">Nation (tax regime)<select className="input" value={i.nation} onChange={(e) => set('nation', e.target.value as Nation)}><option value="england">England (SDLT)</option><option value="northern-ireland">N. Ireland (SDLT)</option><option value="wales">Wales (LTT)</option><option value="scotland">Scotland (LBTT)</option></select></label>
              <label className="field">Buyer status<select className="input" value={i.buyer} onChange={(e) => set('buyer', e.target.value as BuyerType)}><option value="additional">Additional property</option><option value="home-mover">Replacing main home</option><option value="first-time">First-time buyer</option></select></label>
              <label className="field">Ownership<select className="input" value={i.companyPurchase ? 'ltd' : 'personal'} onChange={(e) => set('companyPurchase', e.target.value === 'ltd')}><option value="personal">Personal name</option><option value="ltd">Limited company (SPV)</option></select></label>
              <Money label="Legal fees" value={i.legalFees} onChange={(v) => set('legalFees', v)} step={100} {...money('legalFees')} onValidityChange={track('legalFees')} />
              <Money label="Survey" value={i.surveyFees} onChange={(v) => set('surveyFees', v)} step={50} {...money('surveyFees')} onValidityChange={track('surveyFees')} />
              <Money label="Refurbishment" value={i.refurbCost} onChange={(v) => set('refurbCost', v)} {...money('refurbCost')} onValidityChange={track('refurbCost')} />
              <NumberField label="Works (months)" value={i.refurbMonths} onChange={(v) => set('refurbMonths', v)} min={L.refurbMonths.min} max={L.refurbMonths.max} unit="months" onValidityChange={track('refurbMonths')} />
            </div>
            <Link to={prop ? `/estimate?property=${encodeURIComponent(prop.id)}` : '/estimate'} className="xs" style={{ display: 'block', marginTop: 8 }}>Build the refurb figure in the estimator →</Link>
          </Section>
          <Section title="Finance" kicker="Assumptions">
            <div className="grid g2" style={{ gap: 10 }}>
              <Pct label="Deposit %" value={i.depositPct} onChange={(v) => set('depositPct', v)} step={1} {...percent('depositPct')} onValidityChange={track('depositPct')} />
              <Pct label="Mortgage rate %" value={i.mortgageRate} onChange={(v) => set('mortgageRate', v)} step={0.05} {...percent('mortgageRate')} onValidityChange={track('mortgageRate')} />
              <Pct label="Lender fee %" value={i.lenderFeePct} onChange={(v) => set('lenderFeePct', v)} step={0.1} {...percent('lenderFeePct')} onValidityChange={track('lenderFeePct')} />
              {(i.strategy === 'brrr' || flip) && <Pct label="Bridging % / month" value={i.bridgingRateMonthly} onChange={(v) => set('bridgingRateMonthly', v)} step={0.05} {...percent('bridgingRateMonthly')} onValidityChange={track('bridgingRateMonthly')} />}
              {i.strategy === 'brrr' && <Pct label="Refinance LTV %" value={i.refinanceLtv} onChange={(v) => set('refinanceLtv', v)} step={1} {...percent('refinanceLtv')} onValidityChange={track('refinanceLtv')} />}
              {!flip && <label className="field">Repayment<select className="input" value={i.interestOnly ? 'io' : 'rep'} onChange={(e) => set('interestOnly', e.target.value === 'io')}><option value="io">Interest only</option><option value="rep">Capital repayment</option></select></label>}
            </div>
          </Section>
          <Section title={flip ? 'Exit' : 'Income & running costs'} kicker="Assumptions">
            <div className="grid g2" style={{ gap: 10 }}>
              {!flip && <Money label={i.strategy === 'hmo' ? 'Total room rent pcm' : 'Rent pcm'} value={i.monthlyRent} onChange={(v) => set('monthlyRent', v)} step={25} {...money('monthlyRent')} onValidityChange={track('monthlyRent')} />}
              {!flip && <Pct label="Voids %" value={i.voidPct} onChange={(v) => set('voidPct', v)} step={0.5} {...percent('voidPct')} onValidityChange={track('voidPct')} />}
              {!flip && <Pct label="Management %" value={i.managementPct} onChange={(v) => set('managementPct', v)} step={0.5} {...percent('managementPct')} onValidityChange={track('managementPct')} />}
              {!flip && <Pct label="Maintenance %" value={i.maintenancePct} onChange={(v) => set('maintenancePct', v)} step={0.5} {...percent('maintenancePct')} onValidityChange={track('maintenancePct')} />}
              {!flip && <Money label="Insurance / yr" value={i.insuranceAnnual} onChange={(v) => set('insuranceAnnual', v)} step={10} {...money('insuranceAnnual')} onValidityChange={track('insuranceAnnual')} />}
              {!flip && <Money label="Service charge / ground rent" value={i.serviceChargeAnnual} onChange={(v) => set('serviceChargeAnnual', v)} step={50} {...money('serviceChargeAnnual')} onValidityChange={track('serviceChargeAnnual')} />}
              {i.strategy === 'hmo' && <Money label="Bills (landlord-paid) pcm" value={i.hmoBillsMonthly} onChange={(v) => set('hmoBillsMonthly', v)} step={10} {...money('hmoBillsMonthly')} onValidityChange={track('hmoBillsMonthly')} />}
              {i.strategy === 'hmo' && <Money label="Licensing / yr" value={i.licensingAnnual} onChange={(v) => set('licensingAnnual', v)} step={10} {...money('licensingAnnual')} onValidityChange={track('licensingAnnual')} />}
              {(i.strategy !== 'btl') && <Money label="Post-works value (GDV)" value={i.gdv} onChange={(v) => set('gdv', v)} {...money('gdv')} onValidityChange={track('gdv')} />}
              {flip && <Pct label="Selling costs %" value={i.sellingCostsPct} onChange={(v) => set('sellingCostsPct', v)} step={0.1} {...percent('sellingCostsPct')} onValidityChange={track('sellingCostsPct')} />}
              {(i.strategy === 'brrr' || flip) && <Money label="Holding cost / month" value={i.holdingMonthly} onChange={(v) => set('holdingMonthly', v)} step={10} {...money('holdingMonthly')} onValidityChange={track('holdingMonthly')} />}
            </div>
          </Section>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="row between">
            <Seg aria-label="Scenario" value={scen} onChange={setScen} options={[{ value: 'downside', label: 'Downside' }, { value: 'base', label: 'Base case' }, { value: 'optimistic', label: 'Optimistic' }]} />
            <div className="row"><Tag kind="est">Projection</Tag><Tag kind="neutral">Pre-tax</Tag></div>
          </div>
          {cannotRate && <p className="callout small" role="status" style={{ margin: 0 }}>{cannotRate} Until then, the ratios below can’t be worked out.</p>}

          <div className="grid g4 keep2">
            {flip ? <>
              <div className="card"><Stat label="Profit" value={gbpK(r.flipProfit)} tone={r.flipProfit >= 0 ? 'pos' : 'neg'} sub="After all costs, pre-tax" /></div>
              <div className="card"><Stat label="Profit on cost" value={pct(r.profitOnCost)} sub="Lenders look for 15–20%" /></div>
              <div className="card"><Stat label="Annualised ROI on cash" value={pct(r.annualisedRoi, 0)} sub={`${i.refurbMonths + 3} month project`} /></div>
              <div className="card"><Stat label="Cash required" value={gbpK(r.cashInvested)} sub="Deposit + costs + works" /></div>
            </> : <>
              <div className="card"><Stat label="Monthly cash flow" value={gbp(r.monthlyCashflow)} tone={r.monthlyCashflow >= 0 ? 'pos' : 'neg'} sub="After finance, pre-tax" /></div>
              <div className="card"><Stat label="Cash-on-cash" value={Number.isFinite(r.cashOnCash) ? pct(r.cashOnCash) : r.cashInvested <= 0 ? '∞ (all cash out)' : '—'} sub={`On ${gbpK(r.cashInvested)} left in`} /></div>
              <div className="card"><Stat label="Gross / net yield" value={`${pct(r.grossYield)} / ${pct(r.netYield)}`} sub="Net = NOI ÷ all-in cost" /></div>
              <div className="card"><Stat label="Lender stress test" value={<span className={r.icrPass ? 'pos' : 'neg'}>{r.icrPass ? 'Pass' : 'Fail'} · {icrText(r.icr)}</span>} sub={`ICR req. ${pct(r.icrRequired, 0)} @ ${pct(r.stressRate)}`} /></div>
            </>}
          </div>

          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 8 }}>Break-even points</div>
            <div className="grid g4 keep2">
              {flip ? <Stat label="Break-even sale price" value={gbpK(be.salePrice)} sub={cushionText(active.gdv, be.salePrice, 'below GDV', 'above GDV: no cushion')} /> : <>
                <Stat label="Break-even rent" value={`${gbp(be.rent)} pcm`} sub={cushionText(active.monthlyRent, be.rent, 'cushion vs assumed rent', 'short of break-even')} />
                <Stat label="Break-even occupancy" value={!Number.isFinite(be.occupancy) ? '—' : be.occupancy > 1 ? 'Over 100%' : pct(be.occupancy, 0)} sub={Number.isFinite(be.occupancy) && be.occupancy > 1 ? 'The rent can’t cover the costs, even let all year' : 'Of months let per year'} />
                <Stat label="Break-even interest rate" value={!Number.isFinite(be.rate) ? '—' : be.rate < 0 ? 'None' : pct(be.rate, 2)} sub={Number.isFinite(be.rate) && be.rate < 0 ? 'Loses money even at 0% interest' : 'Interest-only equivalent'} />
                <Stat label="ROI on cash (yr 1, pre-tax)" value={Number.isFinite(r.cashOnCash) ? pct(r.cashOnCash) : r.cashInvested <= 0 ? '∞' : '—'} sub="Cash flow ÷ cash left in" />
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

          <VerdictPanel i={i} scen={scen} propertyId={prop?.id} rule={rule} cannotRate={cannotRate} blocked={blocked} />

          <Section title="Where the cash goes" kicker="Capital stack">
            <Stacked parts={r.breakdown.map((b, k) => ({ label: b.label, value: b.value, color: ['var(--ink)', 'var(--accent)', 'var(--blue)', 'var(--gold)', 'var(--sage)', '#8a6fb0', '#9aa0a6'][k % 7] }))} />
            <div className="grid g3" style={{ marginTop: 14 }}>
              <Stat label={`${r.acquisition.taxName}`} value={gbp(r.acquisition.tax)} sub={i.companyPurchase ? 'Company purchase: higher rates' : i.buyer === 'additional' ? 'Higher rates for additional dwellings' : 'Main residence rates'} />
              <Stat label="Loan" value={gbpK(r.loan)} sub={`${Math.round((1 - i.depositPct) * 100)}% LTV on purchase`} />
              {!flip && <Stat label="Annual finance cost" value={gbpK(r.annualFinance)} sub={`Annual running costs ${gbpK(r.annualCosts)}`} />}
            </div>
          </Section>

          <Section title="Scenario comparison" kicker="Downside · base · optimistic">
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Scenario comparison"><table className="t">
              <thead><tr><th scope="col">Metric</th>{all.map((a) => <th key={a.s} scope="col" className="r">{SCEN_LABEL[a.s]}</th>)}</tr></thead>
              <tbody>
                {flip ? <>
                  <tr><th scope="row">Profit</th>{all.map((a) => <td key={a.s} className={`r num ${a.r.flipProfit < 0 ? 'neg' : ''}`}>{gbpK(a.r.flipProfit)}</td>)}</tr>
                  <tr><th scope="row">Profit on cost</th>{all.map((a) => <td key={a.s} className="r num">{pct(a.r.profitOnCost)}</td>)}</tr>
                </> : <>
                  <tr><th scope="row">Monthly cash flow</th>{all.map((a) => <td key={a.s} className={`r num ${a.r.monthlyCashflow < 0 ? 'neg' : ''}`}>{gbp(a.r.monthlyCashflow)}</td>)}</tr>
                  <tr><th scope="row">Net yield</th>{all.map((a) => <td key={a.s} className="r num">{pct(a.r.netYield, 2)}</td>)}</tr>
                  <tr><th scope="row">Cash left in</th>{all.map((a) => <td key={a.s} className="r num">{gbpK(a.r.cashInvested)}</td>)}</tr>
                  <tr><th scope="row">ICR</th>{all.map((a) => <td key={a.s} className={`r num ${a.r.icrPass ? '' : 'neg'}`}>{icrText(a.r.icr)}</td>)}</tr>
                </>}
              </tbody>
            </table></div>
            <p className="xs muted" style={{ marginTop: 8 }}>Downside: rent −8%, GDV −7%, refurb +15%, rate +1pt, voids +4pts. Optimistic: rent +5%, GDV +4%, refurb −5%, rate −0.5pt.</p>
          </Section>

          <Section title={`Sensitivity: ${flip ? 'profit' : 'monthly cash flow'}`} kicker={`${sens.rowLabel} × ${sens.colLabel}`}>
            <div className="table-wrap" tabIndex={0} role="region" aria-label={`Sensitivity of ${flip ? 'profit' : 'monthly cash flow'}`}><table className="t heat">
              <thead><tr><th scope="col">{sens.rowLabel} ↓ / {sens.colLabel} →</th>{sens.cols.map((c) => <th key={c} scope="col" className="r">{c > 0 ? '+' : ''}{Math.round(c * 100)}%</th>)}</tr></thead>
              <tbody>{sens.rows.map((row) => (
                <tr key={row.shift}><th scope="row" style={{ textAlign: 'left', fontFamily: 'var(--sans)' }}>{flip ? `${row.shift > 0 ? '+' : ''}${Math.round(row.shift * 100)}%` : pct(active.mortgageRate + row.shift, 2)}</th>
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
