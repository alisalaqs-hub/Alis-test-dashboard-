import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Condition, Era } from '../engine/refurb';
import { gbp, gbpK, NumberField, Section, Seg, Stat, Tag } from '../components/ui';
import { AiButton, AiCard, AiDisclaimer, AiErrorNote, AiLabel, AiText, AiThinking, AiUnavailable } from '../components/ai/Ai';
import { aiPost, useAi, useAiAction } from '../lib/ai/core';
import { ACCOUNT_CHANGED_EVENT } from '../lib/server';
import { useStore } from '../store';
import {
  EPC_BANDS, ERAS, HOME_GOALS, HOME_LIMITS, homeFactsProblems, homeModel, planOptions, postcodeProblem, readNumber,
  type EpcBand, type HomeFacts, type HomeGoal, type HomeModel, type HomePlanResult, type HomeType, type PlanOption,
} from '../lib/ai/property';
import '../components/ai/property.css';

/** Engine figures for a step or option, as chips (text, never colour alone). */
function Figures({ cost, valueImpact, billsSaving, rentPcm, effort, withinBudget }: { cost: number | null; valueImpact: number | null; billsSaving: number | null; rentPcm?: number | null; effort: string; withinBudget: boolean | null }) {
  return (
    <div className="ph-figs ai-chips">
      {cost != null && <span className="ai-chip">Cost about <b>{gbpK(cost)}</b></span>}
      {valueImpact != null && <span className="ai-chip">Value <b>{valueImpact >= 0 ? `+${gbpK(valueImpact)}` : gbpK(valueImpact)}</b></span>}
      {billsSaving != null && <span className="ai-chip">Bills <b>{billsSaving >= 0 ? `−${gbp(billsSaving)}` : `+${gbp(-billsSaving)}`}</b> a year</span>}
      {rentPcm != null && <span className="ai-chip">Rent about <b>{gbp(rentPcm)}</b> pcm</span>}
      <span className="ai-chip">Effort <b>{effort}</b></span>
      {withinBudget === false && <span className="ai-chip"><b>Over your budget</b></span>}
    </div>
  );
}

/** A titled list in the AI plan; the title is a heading below the card's. */
function AiList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div><h5 className="ai-prop-h">{title}</h5><ul className="ai-prop-list">{items.map((t) => <li key={t}>{t}</li>)}</ul></div>;
}

function OptionsList({ options, evidence }: { options: PlanOption[]; evidence: string }) {
  if (!options.length) return <p className="small muted" style={{ marginTop: 12 }}>Streetkey has no costed options for these goals for this home (flats, for example, have no loft or extension options). Try another goal.</p>;
  return (
    <div style={{ marginTop: 14 }}>
      <div className="row between"><h4 className="ai-prop-h">Costed options for these goals</h4><Tag kind="est" /></div>
      <ul className="ph-opts">{options.slice(0, 6).map((o) => (
        <li key={o.id}>
          <div className="small" style={{ flex: '1 1 260px' }}><b>{o.title}</b><div className="xs muted">{o.detail}</div></div>
          <Figures cost={o.cost} valueImpact={o.valueImpact} billsSaving={o.billsSaving} rentPcm={o.rentPcm} effort={o.effort} withinBudget={o.withinBudget} />
        </li>
      ))}</ul>
      <p className="xs muted" style={{ marginTop: 8 }}>Streetkey’s rule-based options, best match first. Costs and values are indicative engine figures from {evidence}.</p>
    </div>
  );
}

function PlanView({ x, stale, onUpdate, updateBlocked }: { x: HomePlanResult; stale: boolean; onUpdate: () => void; updateBlocked: string | null }) {
  return (
    <div style={{ marginTop: 14 }}>
      <AiCard title="Plan for your goals" headingLevel={4} focusKey={x} footer={<AiDisclaimer>{x.disclaimer}</AiDisclaimer>}>
        {stale && <div className="callout small ai-prop-stale" role="status">
          Your home details, goals or budget have changed since this plan.{' '}
          {updateBlocked ? <span>{updateBlocked}</span> : <AiButton kind="ghost" size="sm" onClick={onUpdate}>Update my plan</AiButton>}
        </div>}
        <AiText text={x.summary} />
        <ol className="ph-steps" role="list">{x.steps.map((s) => (
          <li key={s.order}>
            <span className="ph-num" aria-hidden="true">{s.order}</span>
            <div>
              <div className="ph-step-t"><span className="sr-only">Step {s.order}: </span>{s.title}</div>
              {s.why && <p className="small" style={{ margin: '2px 0 0' }}>{s.why}</p>}
              <Figures cost={s.cost} valueImpact={s.valueImpact} billsSaving={s.billsSaving} effort={s.effort} withinBudget={s.withinBudget} />
              {/* The figures belong to the costed option, not to the AI's wording of the step. */}
              {s.optionId && s.optionTitle && <p className="xs muted" style={{ margin: '4px 0 0' }}>Costed as Streetkey’s option: <b>{s.optionTitle}</b></p>}
            </div>
          </li>
        ))}</ol>
        <div className="ai-prop-cols">
          <AiList title="Quick wins" items={x.quickWins} />
          <AiList title="Best avoided" items={x.avoid} />
        </div>
        <p className="ai-prop-note">Costs, values and bill savings on each step are Streetkey’s engine figures, not the AI’s.{x.removedClaims > 0 ? ` ${x.removedClaims} statement${x.removedClaims === 1 ? ' was' : 's were'} left out because ${x.removedClaims === 1 ? 'it quoted a figure' : 'they quoted figures'} Streetkey didn’t calculate.` : ''}</p>
      </AiCard>
    </div>
  );
}

const BUDGET_PROBLEM = 'Enter £500 or more, or leave it blank for any budget.';

/** "Your AI plan": goals and budget in, an ordered plan out. Without AI, the costed options still show. */
function HomePlan({ f, m, goals, setGoals, budgetText, setBudgetText, detailsProblem, evidence }: {
  f: HomeFacts; m: HomeModel; goals: HomeGoal[]; setGoals: (g: HomeGoal[]) => void; budgetText: string; setBudgetText: (s: string) => void; detailsProblem: string | null; evidence: string;
}) {
  const { available, reason } = useAi();
  const [asked, setAsked] = useState<string | null>(null);
  const budgetId = useId();
  const plan = useAiAction((body: { home: HomeFacts; goals: HomeGoal[]; budget: number | null }) => aiPost<{ plan: HomePlanResult }>('/api/ai/my-home/plan', body).then((r) => r.plan), { label: 'Plan', done: 'Your plan is ready.' });
  // Budgets under £500 aren't ignored silently: the box says so, and the plan waits for a usable figure.
  const b = readNumber(budgetText, HOME_LIMITS.budget, { allowEmpty: true });
  const budgetProblem = b.problem ? BUDGET_PROBLEM : null;
  const budget = b.problem ? null : b.value;
  const options = useMemo(() => planOptions(m, goals, budget), [m, goals, budget]);
  const key = JSON.stringify([f, goals, budget]);
  const { clearError } = plan;
  useEffect(() => { clearError(); }, [key, clearError]); // an error about earlier details no longer applies
  const blocked = !goals.length ? 'Choose at least one goal.' : detailsProblem ?? (budgetProblem ? 'Fix the budget first.' : null);
  const run = () => { if (blocked) return; setAsked(key); void plan.run({ home: f, goals, budget }); };
  const toggle = (g: HomeGoal) => setGoals(goals.includes(g) ? goals.filter((y) => y !== g) : [...goals, g]);
  const x = plan.data;
  const hintId = useId();
  return (
    <Section title="Your AI plan" kicker="Goals & budget" right={<AiLabel />}>
      <p className="small muted" style={{ marginTop: 0 }}>Pick what you want from your home. Streetkey’s engines cost the options; the AI puts them in order and explains why.</p>
      <div className="chips" role="group" aria-label="Your goals">
        {HOME_GOALS.map((g) => {
          const on = goals.includes(g.id);
          return <button key={g.id} type="button" className="chip ph-goal" aria-pressed={on} onClick={() => toggle(g.id)}><span className="ph-tick" aria-hidden="true">{on ? '✓' : '+'}</span>{g.label}</button>;
        })}
      </div>
      <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
        <div className="field" style={{ width: 220 }}>
          <label htmlFor={budgetId}>Budget (optional)</label>
          <div className="input-prefix"><span aria-hidden="true">£</span>
            <input id={budgetId} className="input num" type="number" min={HOME_LIMITS.budget.min} max={HOME_LIMITS.budget.max} step={1000} inputMode="numeric" value={budgetText} placeholder="Any"
              aria-invalid={budgetProblem ? true : undefined} aria-describedby={`${budgetId}-err`} onChange={(e) => setBudgetText(e.target.value)} />
          </div>
          <span id={`${budgetId}-err`} className="field-error xs" aria-live="polite" style={budgetProblem ? undefined : { position: 'absolute' }}>{budgetProblem ?? ''}</span>
        </div>
        {available && <AiButton busy={plan.busy} disabled={!!blocked} onClick={run} busyLabel="Planning…" aria-describedby={blocked ? hintId : undefined}>{x ? 'Update my plan' : 'Make my plan'}</AiButton>}
      </div>
      {blocked && <p id={hintId} className="small muted" role="status">{blocked}</p>}
      {!available && <AiUnavailable reason={reason} feature="Your AI plan" />}
      {plan.busy && <AiThinking label="Making your plan" />}
      <AiErrorNote error={plan.error} onRetry={blocked ? undefined : run} />
      {x && !plan.busy ? <PlanView x={x} stale={asked !== key} onUpdate={run} updateBlocked={blocked} /> : !plan.busy && goals.length > 0 && <OptionsList options={options} evidence={evidence} />}
    </Section>
  );
}

/* ───────────────────────── keeping what people typed ───────────────────────── */
/** Kept for this visit (sessionStorage), so signing in, following a link or reloading never loses it. */
const DRAFT_KEY = 'streetkey-draft:my-home';
const START: HomeFacts = { postcode: 'E17 4QH', type: 'terraced', beds: 3, area: 92, era: 'pre-1919', condition: 'fair', epc: 'D' };
const TYPES: { value: HomeType; label: string }[] = [{ value: 'terraced', label: 'Terraced' }, { value: 'semi-detached', label: 'Semi', }, { value: 'detached', label: 'Detached' }, { value: 'flat', label: 'Flat' }, { value: 'bungalow', label: 'Bungalow' }];
const CONDITION_OPTIONS: { value: Condition; label: string }[] = [{ value: 'good', label: 'Good' }, { value: 'fair', label: 'Fair' }, { value: 'poor', label: 'Needs work' }, { value: 'derelict', label: 'Major works' }];
interface Draft { f: HomeFacts; goals: HomeGoal[]; budgetText: string }
function readDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Draft> | null;
    const f = v?.f;
    if (!f || typeof f.postcode !== 'string' || typeof f.area !== 'number' || typeof f.beds !== 'number') return null;
    const facts: HomeFacts = {
      ...START, ...f,
      type: TYPES.some((t) => t.value === f.type) ? f.type : START.type, condition: CONDITION_OPTIONS.some((c) => c.value === f.condition) ? f.condition : START.condition,
      era: (ERAS as readonly string[]).includes(f.era as string) ? f.era as Era : START.era, epc: (EPC_BANDS as readonly string[]).includes(f.epc as string) ? f.epc as EpcBand : START.epc,
    };
    const goals = Array.isArray(v?.goals) ? v.goals.filter((g): g is HomeGoal => HOME_GOALS.some((x) => x.id === g)) : ['add-value' as HomeGoal];
    return { f: facts, goals, budgetText: typeof v?.budgetText === 'string' ? v.budgetText.slice(0, 12) : '' };
  } catch { return null; }
}
const writeDraft = (d: Draft) => { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* storage unavailable: nothing kept */ } };
const dropDraft = () => { try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ } };
const START_DRAFT: Draft = { f: START, goals: ['add-value'], budgetText: '' };
// The details belong to whoever typed them: when this tab signs out or changes account they are forgotten, so the
// next person never sees them. Registered once, when the page is first opened, so it also covers a sign-out made elsewhere.
if (typeof window !== 'undefined') window.addEventListener(ACCOUNT_CHANGED_EVENT, dropDraft);

/** Starts the page afresh (no kept details, no AI plan) when the person using this tab signs out or the account changes. */
export default function MyHome() {
  const [person, setPerson] = useState(0);
  useEffect(() => {
    const next = () => setPerson((n) => n + 1);
    window.addEventListener(ACCOUNT_CHANGED_EVENT, next);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, next);
  }, []);
  return <MyHomePage key={person} restarted={person > 0} />;
}

function MyHomePage({ restarted }: { restarted: boolean }) {
  const [initial] = useState(() => { const d = readDraft(); return { d: d ?? START_DRAFT, restored: !!d }; });
  const [f, setF] = useState<HomeFacts>(initial.d.f);
  const [goals, setGoals] = useState<HomeGoal[]>(initial.d.goals);
  const [budgetText, setBudgetText] = useState(initial.d.budgetText);
  const [restored, setRestored] = useState(initial.restored);
  const [bad, setBad] = useState<string[]>([]);
  const track = useCallback((name: string) => (valid: boolean) => setBad((b) => (valid ? b.filter((x) => x !== name) : b.includes(name) ? b : [...b, name])), []);
  const headRef = useRef<HTMLHeadingElement>(null);
  const typeId = useId(), conditionId = useId(), postcodeId = useId();
  const set = <K extends keyof HomeFacts>(k: K, v: HomeFacts[K]) => setF((x) => ({ ...x, [k]: v }));
  // The evidence comes from the shared listings registry, which fills with live listings after the first render:
  // recompute when it changes, so this page and the AI plan work from the same listings.
  const { serverListings, myListings, feedListings, tracked } = useStore();
  const m = useMemo(() => homeModel(f), [f, serverListings, myListings, feedListings, tracked]); // eslint-disable-line react-hooks/exhaustive-deps
  const { ev, value, light, full, dev, epc } = m;
  const evidence = !ev ? 'Streetkey’s demo data' : ev.allDemo ? 'demo listings' : 'listings on Streetkey';

  // Kept once it differs from the starting details (nothing to keep otherwise).
  useEffect(() => {
    const d = { f, goals, budgetText };
    if (JSON.stringify(d) === JSON.stringify(START_DRAFT)) dropDraft(); else writeDraft(d);
  }, [f, goals, budgetText]);
  const startAgain = () => {
    dropDraft();
    setF(START); setGoals(['add-value']); setBudgetText(''); setRestored(false);
    requestAnimationFrame(() => headRef.current?.focus());
  };
  // Restarted after a sign-out or account change: if focus was in the page, it goes to the heading, not <body>.
  useEffect(() => {
    if (restarted && (!document.activeElement || document.activeElement === document.body)) headRef.current?.focus({ preventScroll: true });
  }, [restarted]);

  const postcodeError = postcodeProblem(f.postcode);
  // What the server would refuse, plus number boxes holding something that can't be used yet.
  const problems = [...new Set([...Object.keys(homeFactsProblems(f)), ...bad])];
  const NAMES: Record<string, string> = { postcode: 'Postcode', beds: 'Bedrooms', area: 'Floor area' };
  const detailsProblem = problems.length ? `To use Streetkey AI, first fix ${problems.length === 1 ? 'this detail' : 'these details'} above: ${problems.map((p) => NAMES[p] ?? p).join(', ')}.` : null;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">My Home</div><h2 ref={headRef} tabIndex={-1} style={{ marginTop: 6 }}>Your home — what it’s worth and what it could become</h2>
          <p className="muted" style={{ marginTop: 6 }}>Tell us a few things. No sign-up needed to see the result.</p>
          {restored && <p className="callout info small" style={{ marginTop: 8 }}>We’ve kept the details you entered earlier in this visit. <button type="button" className="linkish" onClick={startAgain}>Start again</button></p>}
        </div>
        <Tag kind="demo">{ev && !ev.allDemo ? 'Indicative · listing evidence' : 'Indicative · example evidence'}</Tag>
      </div>
      <div className="split">
        <Section title="About your home" kicker="Step 1 of 1">
          <div className="grid g2" style={{ gap: 10 }}>
            <div className="field">
              <label htmlFor={postcodeId}>Postcode</label>
              <input id={postcodeId} className="input mono" value={f.postcode} autoComplete="postal-code" spellCheck={false} aria-invalid={postcodeError ? true : undefined} aria-describedby={`${postcodeId}-err`} onChange={(e) => set('postcode', e.target.value)} />
              <span id={`${postcodeId}-err`} className="field-error xs" aria-live="polite" style={postcodeError ? undefined : { position: 'absolute' }}>{postcodeError ?? ''}</span>
            </div>
            <NumberField label="Bedrooms" value={f.beds} onChange={(v) => set('beds', v)} min={HOME_LIMITS.beds.min} max={HOME_LIMITS.beds.max} integer onValidityChange={track('beds')} />
            <NumberField label="Floor area (m²)" value={f.area} onChange={(v) => set('area', v)} min={HOME_LIMITS.area.min} max={HOME_LIMITS.area.max} unit="m²" onValidityChange={track('area')} />
            <label className="field">Built<select className="input" value={f.era} onChange={(e) => set('era', e.target.value as Era)}>{ERAS.map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="field">Current EPC<select className="input" value={f.epc} onChange={(e) => set('epc', e.target.value as EpcBand)}>{EPC_BANDS.map((x) => <option key={x}>{x}</option>)}</select></label>
          </div>
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="field"><span id={typeId}>Type</span><Seg aria-labelledby={typeId} value={f.type} onChange={(v) => set('type', v)} options={TYPES.map((t) => (t.value === 'semi-detached' ? { ...t, ariaLabel: 'Semi-detached' } : t))} /></div>
            <div className="field"><span id={conditionId}>Condition</span><Seg aria-labelledby={conditionId} value={f.condition} onChange={(v) => set('condition', v)} options={CONDITION_OPTIONS} /></div>
          </div>
          <p className="xs muted" style={{ marginTop: 10 }}>Production looks up your address (UPRN) and pre-fills floor area, EPC and construction age from the EPC register, plus flood, conservation and planning constraints.</p>
        </Section>

        <div className="stack" style={{ gap: 16 }}>
          <section className="card ink" aria-labelledby="mh-value">
            <div className="eyebrow" id="mh-value" style={{ color: 'inherit', opacity: 0.6 }}>Indicative value today</div>
            {ev && value ? <>
              <div className="num" style={{ fontSize: 'clamp(2rem, 7vw, 3rem)', marginTop: 6 }}>{gbpK(value.low)} – {gbpK(value.high)}</div>
              <div className="muted small">From {ev.n} {ev.allDemo ? 'demo ' : ''}listing{ev.n === 1 ? '' : 's'} in {ev.scope}, adjusted for condition. Not a valuation.</div>
            </> : <div className="small" style={{ marginTop: 6 }}>{postcodeError ? 'Enter a valid postcode to see an indicative value.' : 'Streetkey has no listings near this postcode yet, so there’s no value range. The live version will use HM Land Registry sold prices.'}</div>}
            <div className="row" style={{ marginTop: 14 }}><Link to="/prices" className="btn ghost sm" style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.3)' }}>See sold prices nearby</Link><Link to="/owner" className="btn accent sm">Thinking of selling?</Link></div>
          </section>
          <div className="grid g2">
            <div className="card"><Stat label={<>Refresh (decorate, floors, insulation) <Tag kind="est" /></>} value={gbpK(light.total)} sub={`${light.programmeWeeks} weeks · ${light.confidence} confidence`} /><Link to="/estimate" className="xs">Adjust scope →</Link></div>
            <div className="card"><Stat label={<>Full renovation <Tag kind="est" /></>} value={gbpK(full.total)} sub={`${gbpK(full.low)}–${gbpK(full.high)} · ${full.programmeWeeks} weeks`} /><Link to="/studio" className="xs">Design rooms first →</Link></div>
          </div>
          <HomePlan f={f} m={m} goals={goals} setGoals={setGoals} budgetText={budgetText} setBudgetText={setBudgetText} detailsProblem={detailsProblem} evidence={evidence} />
          <Section title="Ways to add space & value" kicker="Screening — not a planning opinion" right={<Tag kind="warn">Verify with a professional</Tag>}>
            {dev.length === 0 ? <p className="small muted">Flats have no permitted-development rights for extensions or lofts.</p> :
              <ul className="clean">{dev.map((o) => <li key={o.id} className="row between" style={{ flexWrap: 'nowrap', gap: 10 }}><div className="small"><b>{o.name}</b><div className="xs muted">{o.status}{o.cost ? ` · cost ≈ ${gbpK(o.cost)}` : ''}</div></div>{o.valueUplift && o.valueUplift > 0 && o.status !== 'constrained' ? <span className="num small">{gbpK(o.valueUplift)} added</span> : null}</li>)}</ul>}
            <p className="xs muted" style={{ marginTop: 8 }}>Value added is Streetkey’s screening estimate from the local refurbished value ({evidence}). Constraints (conservation area, Article 4, listing) are not checked without your address.</p>
          </Section>
          <Section title="Energy upgrade plan" kicker={`EPC ${f.epc} today`}>
            <ul className="clean small">{epc.steps.slice(0, 4).map((s) => <li key={s.measure} className="row between"><span>{s.measure}</span><span className="num">{gbpK(s.cost)} → {s.band}</span></li>)}</ul>
          </Section>
          <p className="xs muted">Streetkey is not a RICS valuer. For lending, probate or tax purposes you need a formal valuation.</p>
          <div className="small"><Link to="/estimate">Cost works</Link> · <Link to="/studio">Redesign a room</Link> · <Link to="/invest">Investment view</Link>{ev ? <> · <span className="muted">Values update as you edit — {gbp(Math.round(ev.refurbishedPerM2))}/m² refurbished benchmark</span></> : null}</div>
        </div>
      </div>
    </div>
  );
}
