import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Condition, Era } from '../engine/refurb';
import { gbp, gbpK, Section, Seg, Stat, Tag } from '../components/ui';
import { AiButton, AiCard, AiDisclaimer, AiErrorNote, AiLabel, AiText, AiThinking, AiUnavailable } from '../components/ai/Ai';
import { aiPost, useAi, useAiAction } from '../lib/ai/core';
import { EPC_BANDS, HOME_GOALS, homeModel, planOptions, type EpcBand, type HomeFacts, type HomeGoal, type HomeModel, type HomePlanResult, type PlanOption } from '../lib/ai/property';
import '../components/ai/property.css';

/** Engine figures for a step or option, as chips (text, never colour alone). */
function Figures({ cost, valueImpact, billsSaving, rentPcm, effort, withinBudget }: { cost: number | null; valueImpact: number | null; billsSaving: number | null; rentPcm?: number | null; effort: string; withinBudget: boolean | null }) {
  return (
    <div className="ph-figs ai-chips">
      {cost != null && <span className="ai-chip">Cost about <b>{gbpK(cost)}</b></span>}
      {valueImpact != null && <span className="ai-chip">Value <b>+{gbpK(valueImpact)}</b></span>}
      {billsSaving != null && <span className="ai-chip">Bills <b>−{gbp(billsSaving)}</b> a year</span>}
      {rentPcm != null && <span className="ai-chip">Rent about <b>{gbp(rentPcm)}</b> pcm</span>}
      <span className="ai-chip">Effort <b>{effort}</b></span>
      {withinBudget === false && <span className="ai-chip"><b>Over your budget</b></span>}
    </div>
  );
}

function AiList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div><div className="ai-prop-h">{title}</div><ul className="ai-prop-list">{items.map((t) => <li key={t}>{t}</li>)}</ul></div>;
}

function OptionsList({ options }: { options: PlanOption[] }) {
  if (!options.length) return <p className="small muted" style={{ marginTop: 12 }}>Streetkey has no costed options for these goals for this home (flats, for example, have no loft or extension options). Try another goal.</p>;
  return (
    <div style={{ marginTop: 14 }}>
      <div className="row between"><div className="ai-prop-h">Costed options for these goals</div><Tag kind="est" /></div>
      <ul className="ph-opts">{options.slice(0, 6).map((o) => (
        <li key={o.id}>
          <div className="small" style={{ flex: '1 1 260px' }}><b>{o.title}</b><div className="xs muted">{o.detail}</div></div>
          <Figures cost={o.cost} valueImpact={o.valueImpact} billsSaving={o.billsSaving} rentPcm={o.rentPcm} effort={o.effort} withinBudget={o.withinBudget} />
        </li>
      ))}</ul>
      <p className="xs muted" style={{ marginTop: 8 }}>Streetkey’s rule-based options, best match first. Costs and values are indicative engine figures from demo evidence.</p>
    </div>
  );
}

function PlanView({ x, stale, onUpdate }: { x: HomePlanResult; stale: boolean; onUpdate: () => void }) {
  return (
    <div style={{ marginTop: 14 }}>
      <AiCard title="Plan for your goals" footer={<AiDisclaimer>{x.disclaimer}</AiDisclaimer>}>
        {stale && <div className="callout small ai-prop-stale" role="status">Your home details, goals or budget have changed since this plan. <button type="button" className="btn ghost sm" onClick={onUpdate}>Update my plan</button></div>}
        <AiText text={x.summary} />
        <ol className="ph-steps" role="list">{x.steps.map((s) => (
          <li key={s.order}>
            <span className="ph-num" aria-hidden="true">{s.order}</span>
            <div>
              <div className="ph-step-t"><span className="sr-only">Step {s.order}: </span>{s.title}</div>
              {s.why && <p className="small" style={{ margin: '2px 0 0' }}>{s.why}</p>}
              <Figures cost={s.cost} valueImpact={s.valueImpact} billsSaving={s.billsSaving} effort={s.effort} withinBudget={s.withinBudget} />
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

/** "Your AI plan": goals and budget in, an ordered plan out. Without AI, the costed options still show. */
function HomePlan({ f, m }: { f: HomeFacts; m: HomeModel }) {
  const { available, reason } = useAi();
  const [goals, setGoals] = useState<HomeGoal[]>(['add-value']);
  const [budget, setBudget] = useState<number | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const plan = useAiAction((body: { home: HomeFacts; goals: HomeGoal[]; budget: number | null }) => aiPost<{ plan: HomePlanResult }>('/api/ai/my-home/plan', body).then((r) => r.plan));
  const sendBudget = budget != null && budget >= 500 ? budget : null;
  const options = useMemo(() => planOptions(m, goals, sendBudget), [m, goals, sendBudget]);
  const key = JSON.stringify([f, goals, sendBudget]);
  const run = () => { setAsked(key); void plan.run({ home: f, goals, budget: sendBudget }); };
  const toggle = (g: HomeGoal) => setGoals((x) => (x.includes(g) ? x.filter((y) => y !== g) : [...x, g]));
  const x = plan.data;
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
        <label className="field" style={{ width: 200 }}>Budget (optional)
          <div className="input-prefix"><span>£</span>
            <input className="input num" type="number" min={0} step={1000} inputMode="numeric" value={budget ?? ''} placeholder="Any"
              onChange={(e) => setBudget(e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0))} />
          </div>
        </label>
        {available && <AiButton busy={plan.busy} disabled={!goals.length} onClick={run}>{x ? 'Update my plan' : 'Make my plan'}</AiButton>}
      </div>
      {!goals.length && <p className="small muted" role="status">Choose at least one goal.</p>}
      {!available && <AiUnavailable reason={reason} feature="Your AI plan" />}
      {plan.busy && <AiThinking label="Making your plan" />}
      <AiErrorNote error={plan.error} onRetry={goals.length ? run : undefined} />
      {x && !plan.busy ? <PlanView x={x} stale={asked !== key} onUpdate={run} /> : !plan.busy && goals.length > 0 && <OptionsList options={options} />}
    </Section>
  );
}

export default function MyHome() {
  const [f, setF] = useState<HomeFacts>({ postcode: 'E17 4QH', type: 'terraced', beds: 3, area: 92, era: 'pre-1919', condition: 'fair', epc: 'D' });
  const set = <K extends keyof HomeFacts>(k: K, v: HomeFacts[K]) => setF((x) => ({ ...x, [k]: v }));
  const m = useMemo(() => homeModel(f), [f]);
  const { ev, value, light, full, dev, epc } = m;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">My Home</div><h2 style={{ marginTop: 6 }}>Your home — what it’s worth and what it could become</h2>
          <p className="muted" style={{ marginTop: 6 }}>Tell us a few things. No sign-up needed to see the result.</p></div>
        <Tag kind="demo">Indicative · demo evidence</Tag>
      </div>
      <div className="split">
        <Section title="About your home" kicker="Step 1 of 1">
          <div className="grid g2" style={{ gap: 10 }}>
            <label className="field">Postcode<input className="input mono" value={f.postcode} onChange={(e) => set('postcode', e.target.value)} /></label>
            <label className="field">Bedrooms<input className="input num" type="number" min={0} max={8} value={f.beds} onChange={(e) => set('beds', Math.min(12, Math.max(0, Number(e.target.value) || 0)))} /></label>
            <label className="field">Floor area (m²)<input className="input num" type="number" min={20} value={f.area} onChange={(e) => set('area', Math.min(2000, Math.max(20, Number(e.target.value) || 20)))} /></label>
            <label className="field">Built<select className="input" value={f.era} onChange={(e) => set('era', e.target.value as Era)}>{['pre-1919', '1919-1944', '1945-1979', '1980-1999', '2000+'].map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="field">Current EPC<select className="input" value={f.epc} onChange={(e) => set('epc', e.target.value as EpcBand)}>{EPC_BANDS.map((x) => <option key={x}>{x}</option>)}</select></label>
          </div>
          <div className="stack" style={{ marginTop: 12 }}>
            <label className="field">Type<Seg value={f.type} onChange={(v) => set('type', v)} options={[{ value: 'terraced', label: 'Terraced' }, { value: 'semi-detached', label: 'Semi' }, { value: 'detached', label: 'Detached' }, { value: 'flat', label: 'Flat' }, { value: 'bungalow', label: 'Bungalow' }]} /></label>
            <label className="field">Condition<Seg value={f.condition} onChange={(v) => set('condition', v as Condition)} options={[{ value: 'good', label: 'Good' }, { value: 'fair', label: 'Fair' }, { value: 'poor', label: 'Needs work' }, { value: 'derelict', label: 'Major works' }]} /></label>
          </div>
          <p className="xs muted" style={{ marginTop: 10 }}>Production looks up your address (UPRN) and pre-fills floor area, EPC and construction age from the EPC register, plus flood, conservation and planning constraints.</p>
        </Section>

        <div className="stack" style={{ gap: 16 }}>
          <section className="card ink">
            <div className="eyebrow" style={{ color: 'inherit', opacity: 0.6 }}>Indicative value today</div>
            {ev && value ? <>
              <div className="num" style={{ fontSize: 'clamp(2rem, 7vw, 3rem)', marginTop: 6 }}>{gbpK(value.low)} – {gbpK(value.high)}</div>
              <div className="muted small">From {ev.n} demo listing{ev.n === 1 ? '' : 's'} in {ev.scope}, adjusted for condition. Not a valuation.</div>
            </> : <div className="small" style={{ marginTop: 6 }}>No evidence for this postcode in the demo dataset. Live version uses HM Land Registry sold prices.</div>}
            <div className="row" style={{ marginTop: 14 }}><Link to="/prices" className="btn ghost sm" style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.3)' }}>See sold prices nearby</Link><Link to="/owner" className="btn accent sm">Thinking of selling?</Link></div>
          </section>
          <div className="grid g2">
            <div className="card"><Stat label={<>Refresh (decorate, floors, insulation) <Tag kind="est" /></>} value={gbpK(light.total)} sub={`${light.programmeWeeks} weeks · ${light.confidence} confidence`} /><Link to="/estimate" className="xs">Adjust scope →</Link></div>
            <div className="card"><Stat label={<>Full renovation <Tag kind="est" /></>} value={gbpK(full.total)} sub={`${gbpK(full.low)}–${gbpK(full.high)} · ${full.programmeWeeks} weeks`} /><Link to="/studio" className="xs">Design rooms first →</Link></div>
          </div>
          <HomePlan f={f} m={m} />
          <Section title="Ways to add space & value" kicker="Screening — not a planning opinion" right={<Tag kind="warn">Verify with a professional</Tag>}>
            {dev.length === 0 ? <p className="small muted">Flats have no permitted-development rights for extensions or lofts.</p> :
              <ul className="clean">{dev.map((o) => <li key={o.id} className="row between" style={{ flexWrap: 'nowrap', gap: 10 }}><div className="small"><b>{o.name}</b><div className="xs muted">{o.status}{o.cost ? ` · cost ≈ ${gbpK(o.cost)}` : ''}</div></div>{o.valueUplift && o.valueUplift > 0 && o.status !== 'constrained' ? <span className="num small">{gbpK(o.valueUplift)} added</span> : null}</li>)}</ul>}
            <p className="xs muted" style={{ marginTop: 8 }}>Value added is Streetkey’s screening estimate from the local refurbished value (demo evidence). Constraints (conservation area, Article 4, listing) are not checked without your address.</p>
          </Section>
          <Section title="Energy upgrade plan" kicker={`EPC ${f.epc} today`}>
            <ul className="clean small">{epc.steps.slice(0, 4).map((s) => <li key={s.measure} className="row between"><span>{s.measure}</span><span className="num">{gbpK(s.cost)} → {s.band}</span></li>)}</ul>
          </Section>
          <p className="xs muted">Streetkey is not a RICS valuer. For lending, probate or tax purposes you need a formal valuation.</p>
          <div className="small"><Link to={`/estimate`}>Cost works</Link> · <Link to="/studio">Redesign a room</Link> · <Link to="/invest">Investment view</Link> · <span className="muted">Values update as you edit — {gbp(Math.round(ev?.refurbishedPerM2 ?? 0))}/m² refurbished benchmark</span></div>
        </div>
      </div>
    </div>
  );
}
