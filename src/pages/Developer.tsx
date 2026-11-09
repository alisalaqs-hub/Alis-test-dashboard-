import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PROPERTIES } from '../data/properties';
import { developmentOptions, NDSS, residualAppraisal, suggestMix, type DemandSignal, type UnitType } from '../engine/development';
import { engagementFor } from '../engine/engagement';
import { gbp, gbpK, Meter, Section, Stat, Tag } from '../components/ui';
import { AiBriefing, BriefingFallback } from '../components/ai/AiBriefing';
import type { BriefingSnapshot } from '../lib/ai/briefing';

const SENS_BUILD = [-0.05, 0, 0.1];
const SENS_GDV = [-0.05, 0, 0.05];
const ndssKey = (k: UnitType['key']) => (k === '1b' ? '1b2p' : k === '2b' ? '2b4p' : k === '3b' ? '3b5p' : 'studio');
const pctLabel = (x: number) => `${x > 0 ? '+' : ''}${Math.round(x * 100)}%`;

/**
 * DEMONSTRATION market inputs. These are illustrative assumptions for the
 * prototype — not market statistics. Production derives them from Land
 * Registry, EPC, ONS rental data, licensed rental listings, Streetkey search
 * demand and planning pipeline data, with sources and dates shown.
 */
const MARKETS: Record<string, { label: string; types: UnitType[]; demand: DemandSignal[]; pipeline: number; buildCost: number; cil: number; searchShare: Record<string, number> }> = {
  watford: { label: 'Watford town centre (WD17)', pipeline: 640, buildCost: 2_650, cil: 180_000,
    types: [{ key: 'studio', label: 'Studio', size: 39, price: 215_000, rent: 1_250 }, { key: '1b', label: '1-bed 2-person', size: 51, price: 265_000, rent: 1_475 }, { key: '2b', label: '2-bed 4-person', size: 71, price: 345_000, rent: 1_775 }, { key: '3b', label: '3-bed 5-person', size: 87, price: 420_000, rent: 2_150 }],
    demand: [{ key: 'studio', demandIndex: 48, monthlyAbsorption: [0.4, 0.9] }, { key: '1b', demandIndex: 82, monthlyAbsorption: [1.2, 2.2] }, { key: '2b', demandIndex: 88, monthlyAbsorption: [1.4, 2.6] }, { key: '3b', demandIndex: 57, monthlyAbsorption: [0.3, 0.7] }],
    searchShare: { studio: 0.08, '1b': 0.34, '2b': 0.43, '3b': 0.15 } },
  croydon: { label: 'East Croydon (CR0)', pipeline: 2_100, buildCost: 2_850, cil: 240_000,
    types: [{ key: 'studio', label: 'Studio', size: 38, price: 225_000, rent: 1_300 }, { key: '1b', label: '1-bed 2-person', size: 50, price: 280_000, rent: 1_550 }, { key: '2b', label: '2-bed 4-person', size: 70, price: 360_000, rent: 1_900 }, { key: '3b', label: '3-bed 5-person', size: 86, price: 440_000, rent: 2_300 }],
    demand: [{ key: 'studio', demandIndex: 55, monthlyAbsorption: [0.5, 1.1] }, { key: '1b', demandIndex: 79, monthlyAbsorption: [1.0, 2.0] }, { key: '2b', demandIndex: 84, monthlyAbsorption: [1.1, 2.1] }, { key: '3b', demandIndex: 66, monthlyAbsorption: [0.4, 0.8] }],
    searchShare: { studio: 0.11, '1b': 0.31, '2b': 0.39, '3b': 0.19 } },
  manchester: { label: 'South Manchester (M14)', pipeline: 3_400, buildCost: 2_300, cil: 0,
    types: [{ key: 'studio', label: 'Studio', size: 37, price: 155_000, rent: 950 }, { key: '1b', label: '1-bed 2-person', size: 50, price: 190_000, rent: 1_150 }, { key: '2b', label: '2-bed 4-person', size: 70, price: 245_000, rent: 1_425 }, { key: '3b', label: '3-bed 5-person', size: 86, price: 300_000, rent: 1_700 }],
    demand: [{ key: 'studio', demandIndex: 71, monthlyAbsorption: [0.8, 1.6] }, { key: '1b', demandIndex: 86, monthlyAbsorption: [1.3, 2.5] }, { key: '2b', demandIndex: 77, monthlyAbsorption: [1.0, 1.9] }, { key: '3b', demandIndex: 49, monthlyAbsorption: [0.2, 0.5] }],
    searchShare: { studio: 0.17, '1b': 0.38, '2b': 0.33, '3b': 0.12 } },
};

export default function Developer() {
  const [mk, setMk] = useState<keyof typeof MARKETS>('watford');
  const m = MARKETS[mk];
  const [total, setTotal] = useState(25);
  const [mix, setMix] = useState<Record<string, number>>({ studio: 3, '1b': 9, '2b': 10, '3b': 3 });
  const [build, setBuild] = useState(1_750);
  const [profit, setProfit] = useState(0.2);
  const [land, setLand] = useState(1_450_000);
  const [months, setMonths] = useState(20);
  const [scheme, setScheme] = useState<'newbuild' | 'conversion'>('conversion');
  const count = Object.values(mix).reduce((a, b) => a + b, 0);
  const appraise = (gdvChange: number, buildChange: number) => residualAppraisal({ units: m.types.map((t) => ({ key: t.key, count: mix[t.key] ?? 0, size: t.size, price: t.price * (1 + gdvChange) })), buildCostPerM2: build * (1 + buildChange), netToGross: scheme === 'conversion' ? 0.78 : 0.8, feesPct: 0.12, contingencyPct: scheme === 'conversion' ? 0.08 : 0.05, financeRate: 0.085, months, profitOnGdv: profit, salesPct: 0.025, cil: scheme === 'conversion' ? 0 : m.cil });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const appraisal = useMemo(() => appraise(0, 0), [m, mix, build, profit, months, scheme]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sensitivity = useMemo(() => SENS_BUILD.map((b) => SENS_GDV.map((g) => ({ b, g, residual: appraise(g, b).residual }))), [m, mix, build, profit, months, scheme]);
  const absorption = useMemo(() => m.types.map((t) => { const d = m.demand.find((x) => x.key === t.key)!; const n = mix[t.key] ?? 0; return { t, d, n, monthsLow: n / d.monthlyAbsorption[1], monthsHigh: n / d.monthlyAbsorption[0] }; }), [m, mix]);
  const sellOut = useMemo(() => [Math.max(...absorption.map((a) => a.monthsLow)), Math.max(...absorption.map((a) => a.monthsHigh))], [absorption]);
  const opps = useMemo(() => PROPERTIES.flatMap((p) => developmentOptions(p).filter((o) => (o.id === 'subdivide' || o.id === 'classma') && o.units && o.units >= 2).map((o) => ({ p, o }))), []);
  const styles = useMemo(() => { const s = new Map<string, number>(); PROPERTIES.forEach((p) => engagementFor(p).designStyles.forEach((d) => s.set(d.style, (s.get(d.style) ?? 0) + d.count))); return [...s].sort((a, b) => b[1] - a[1]).slice(0, 5); }, []);
  const suggest = () => setMix(suggestMix(total, m.types, m.demand));
  const switchMarket = (k: keyof typeof MARKETS) => { setMk(k); setBuild(scheme === 'conversion' ? Math.round(MARKETS[k].buildCost * 0.66 / 50) * 50 : MARKETS[k].buildCost); };
  const switchScheme = (s: 'newbuild' | 'conversion') => { setScheme(s); setBuild(s === 'conversion' ? Math.round(m.buildCost * 0.66 / 50) * 50 : m.buildCost); };
  const contingencyPct = scheme === 'conversion' ? 8 : 5;
  const profitPct = Math.round(profit * 100);
  const headroom = appraisal.residual - land;
  const oversupplied = absorption.filter((a) => a.n > 0 && a.monthsHigh > 18);

  /** The appraisal as shown on this page, for the AI briefing. */
  const briefing = useMemo<BriefingSnapshot>(() => ({
    title: `Scheme appraisal · ${m.label}`,
    scope: `${scheme === 'conversion' ? 'Office to residential conversion' : 'New build'} with ${count} units in the mix. Demonstration market inputs, not market statistics.`,
    metrics: [
      { label: 'Units in mix', value: count },
      { label: 'Target total units', value: total },
      { label: 'Gross development value', value: Math.round(appraisal.gdv), unit: '£' },
      { label: 'Net internal area', value: Math.round(appraisal.nia), unit: 'm²' },
      { label: 'Gross internal area', value: Math.round(appraisal.gia), unit: 'm²' },
      { label: 'Build cost per m² GIA', value: build, unit: '£ per m²' },
      { label: 'Build cost', value: Math.round(appraisal.build), unit: '£' },
      { label: 'Professional fees (12%)', value: Math.round(appraisal.fees), unit: '£' },
      { label: `Contingency (${contingencyPct}%)`, value: Math.round(appraisal.contingency), unit: '£' },
      { label: 'Finance (8.5%, S-curve)', value: Math.round(appraisal.finance), unit: '£' },
      { label: 'Sales and marketing (2.5%)', value: Math.round(appraisal.sales), unit: '£' },
      { label: 'CIL / S106 allowance', value: Math.round(appraisal.cil), unit: '£' },
      { label: `Developer’s profit (${profitPct}% of GDV)`, value: Math.round(appraisal.profit), unit: '£' },
      { label: 'Residual land value', value: Math.round(appraisal.residual), unit: '£' },
      { label: 'Residual land value per unit', value: Math.round(appraisal.rlvPerUnit), unit: '£' },
      { label: 'Land asking price', value: land, unit: '£' },
      { label: 'Headroom against asking price', value: Math.round(headroom), unit: '£' },
      { label: 'Programme', value: months, unit: 'months' },
      { label: 'Sell-out period', value: `${sellOut[0].toFixed(0)}–${sellOut[1].toFixed(0)} months` },
      { label: 'Pipeline within 1.5km', value: m.pipeline, unit: 'units' },
    ],
    items: [
      ...absorption.map(({ t, d, n, monthsLow, monthsHigh }) => ({
        id: `type-${t.key}`, label: t.label, group: 'unit type',
        fields: {
          unitsInMix: n, sizeM2: t.size, ndssMinimumM2: NDSS[ndssKey(t.key)], salePrice: t.price, rentPcm: t.rent, demandIndex: d.demandIndex,
          searchSharePct: Math.round(m.searchShare[t.key] * 100), absorptionPerMonthLow: d.monthlyAbsorption[0], absorptionPerMonthHigh: d.monthlyAbsorption[1],
          monthsToSellLow: n ? Math.round(monthsLow) : null, monthsToSellHigh: n ? Math.round(monthsHigh) : null, overSupplied: n > 0 && monthsHigh > 18,
        },
      })),
      ...sensitivity.flat().map(({ b, g, residual }) => ({
        id: `sens-build${Math.round(b * 100)}-gdv${Math.round(g * 100)}`, label: `Build cost ${pctLabel(b)}, sales values ${pctLabel(g)}`, group: 'sensitivity',
        fields: { buildCostChangePct: Math.round(b * 100), salesValueChangePct: Math.round(g * 100), residualLandValue: Math.round(residual), belowLandAsking: residual < land },
      })),
      ...opps.slice(0, 12).map(({ p, o }) => ({
        id: `opp-${p.id}-${o.id}`, label: `${p.street.replace(' (fictional)', '')}, ${p.town.split(',')[0]}`, group: 'listed opportunity',
        fields: { option: o.name, status: o.status, askingPrice: p.price, units: o.units ?? null },
        notes: [o.summary, ...o.constraints].slice(0, 3),
      })),
    ],
    notes: [
      'Excludes SDLT on land, affordable housing (assumed nil) and VAT.',
      'Screening only: a viability consultant should run a full appraisal before bidding.',
      ...(count !== total ? [`The mix has ${count} units against a target of ${total}.`] : []),
    ],
  }), [m, scheme, count, total, appraisal, build, contingencyPct, profitPct, land, headroom, months, sellOut, absorption, sensitivity, opps]);
  const briefingFallback = (
    <BriefingFallback title="Appraisal check (built-in rules)" items={[
      <>Residual land value {gbpK(appraisal.residual)} against a land asking price of {gbpK(land)}: {headroom >= 0 ? `${gbpK(headroom)} headroom` : `${gbpK(-headroom)} short`}.</>,
      ...oversupplied.map((a) => <>{a.t.label}: {a.n} units could take up to {a.monthsHigh.toFixed(0)} months to sell.</>),
      ...(count !== total ? [<>The mix has {count} units against a target of {total}.</>] : []),
    ]} />
  );

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">Developer intelligence</div><h2 style={{ marginTop: 6 }}>What should I build — and what can I pay for the land?</h2>
          <p className="muted" style={{ marginTop: 6 }}>Explore demand by unit type, test a unit mix, and run a residual land appraisal. Scenarios show ranges, not point predictions.</p></div>
        <div className="row"><Tag kind="demo">Demonstration market inputs</Tag><Tag kind="live">Land Registry · ONS · planning pipeline · Streetkey search demand</Tag></div>
      </div>

      <div className="card flat filters">
        <label className="field">Market<select className="input" value={mk} onChange={(e) => switchMarket(e.target.value as keyof typeof MARKETS)}>{Object.entries(MARKETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label className="field">Total units<input className="input num" type="number" min={2} max={200} value={total} onChange={(e) => setTotal(Math.max(2, Number(e.target.value) || 2))} /></label>
        <label className="field">Scheme<select className="input" value={scheme} onChange={(e) => switchScheme(e.target.value as 'newbuild' | 'conversion')}><option value="conversion">Office → residential conversion</option><option value="newbuild">New build</option></select></label>
        <button className="btn accent" onClick={suggest}>Suggest demand-led mix</button>
        <span className="xs muted">Pipeline: {m.pipeline.toLocaleString('en-GB')} units consented/under construction within 1.5km (demo)</span>
      </div>

      <AiBriefing kind="developer" title="Scheme briefing" snapshot={briefing} fallback={briefingFallback}
        intro="Reads this appraisal, sensitivity and demand table, and sets out what to test or check before bidding." />

      <div className="split-r">
        <div className="stack" style={{ gap: 16 }}>
          <Section title="Demand by unit type" kicker="Explainable scenario" right={<Tag kind="est">Confidence ranges</Tag>}>
            <div className="table-wrap" tabIndex={0}><table className="t">
              <thead><tr><th>Unit type</th><th className="r">NDSS min</th><th className="r">Demand index</th><th className="r">Search share</th><th className="r">Absorption / month</th><th className="r">Units</th><th className="r">Months to sell</th></tr></thead>
              <tbody>{absorption.map(({ t, d, n, monthsLow, monthsHigh }) => (
                <tr key={t.key}>
                  <td><b className="small">{t.label}</b><div className="xs muted">{t.size}m² · {gbpK(t.price)} · {gbp(t.rent)} pcm</div></td>
                  <td className="r num small">{NDSS[ndssKey(t.key)]}m²</td>
                  <td className="r"><div className="bar" style={{ width: 70, display: 'inline-block', verticalAlign: 'middle' }}><i style={{ width: `${d.demandIndex}%`, background: d.demandIndex > 75 ? 'var(--sage)' : d.demandIndex > 55 ? 'var(--gold)' : 'var(--accent)' }} /></div> <span className="num small">{d.demandIndex}</span></td>
                  <td className="r num small">{Math.round(m.searchShare[t.key] * 100)}%</td>
                  <td className="r num small">{d.monthlyAbsorption[0]}–{d.monthlyAbsorption[1]}</td>
                  <td className="r"><input className="input num" aria-label={`Number of ${t.label} units`} style={{ width: 64, padding: '4px 6px' }} type="number" min={0} value={mix[t.key] ?? 0} onChange={(e) => setMix((x) => ({ ...x, [t.key]: Math.max(0, Number(e.target.value) || 0) }))} /></td>
                  <td className={`r num small ${monthsHigh > 18 ? 'neg' : ''}`}>{n ? `${monthsLow.toFixed(0)}–${monthsHigh.toFixed(0)}` : '—'}</td>
                </tr>
              ))}</tbody>
              <tfoot><tr><td>Total</td><td /><td /><td /><td /><td className={`r num ${count !== total ? 'neg' : ''}`}>{count}</td><td className="r num">{sellOut[0].toFixed(0)}–{sellOut[1].toFixed(0)} mo</td></tr></tfoot>
            </table></div>
            <ul className="ticks xs muted" style={{ marginTop: 8 }}>
              <li>Demand index blends (demo) enquiry-to-listing ratio, days-to-sell/let and Streetkey search share for the postcode district.</li>
              <li>Months-to-sell range = units ÷ absorption range; types with &gt;18 months of supply are flagged.</li>
              <li>The suggested mix keeps ≥10% family units and caps each type at ~6 months of upper-bound absorption. Local plan housing-mix policy prevails.</li>
            </ul>
          </Section>

          <Section title="Residual land appraisal" kicker="Deterministic">
            <div className="grid g4 keep2" style={{ gap: 10 }}>
              <label className="field">Build cost £/m² GIA<input className="input num" type="number" step={50} value={build} onChange={(e) => setBuild(Number(e.target.value) || 0)} /></label>
              <label className="field">Profit on GDV %<input className="input num" type="number" step={1} value={Math.round(profit * 100)} onChange={(e) => setProfit((Number(e.target.value) || 0) / 100)} /></label>
              <label className="field">Programme (months)<input className="input num" type="number" value={months} onChange={(e) => setMonths(Number(e.target.value) || 12)} /></label>
              <label className="field">Land asking price<div className="input-prefix"><span>£</span><input className="input num" type="number" step={10000} value={land} onChange={(e) => setLand(Number(e.target.value) || 0)} /></div></label>
            </div>
            <div className="table-wrap" tabIndex={0} style={{ marginTop: 12 }}><table className="t">
              <tbody>
                <tr><td>Gross development value ({count} units, {Math.round(appraisal.nia)}m² NIA)</td><td className="r num">{gbp(appraisal.gdv)}</td></tr>
                <tr><td>Build cost ({Math.round(appraisal.gia)}m² GIA @ {gbp(build)})</td><td className="r num">−{gbp(appraisal.build)}</td></tr>
                <tr><td>Professional fees (12%)</td><td className="r num">−{gbp(appraisal.fees)}</td></tr>
                <tr><td>Contingency ({scheme === 'conversion' ? 8 : 5}%)</td><td className="r num">−{gbp(appraisal.contingency)}</td></tr>
                <tr><td>Finance (8.5%, S-curve)</td><td className="r num">−{gbp(appraisal.finance)}</td></tr>
                <tr><td>Sales & marketing (2.5%)</td><td className="r num">−{gbp(appraisal.sales)}</td></tr>
                <tr><td>CIL / S106 allowance{scheme === 'conversion' ? ' (existing lawful floorspace offset)' : ''}</td><td className="r num">−{gbp(appraisal.cil)}</td></tr>
                <tr><td>Developer’s profit ({Math.round(profit * 100)}% GDV)</td><td className="r num">−{gbp(appraisal.profit)}</td></tr>
              </tbody>
              <tfoot><tr><td>Residual land value</td><td className={`r num ${appraisal.residual < 0 ? 'neg' : 'pos'}`}>{gbp(appraisal.residual)}</td></tr></tfoot>
            </table></div>
            <p className="xs muted" style={{ marginTop: 8 }}>Excludes SDLT on land, affordable housing (assumed nil — usually not true above policy thresholds), and VAT. A viability consultant should run a full appraisal (e.g. Argus) before bidding.</p>
          </Section>

          <Section title="Conversion & development opportunities" kicker="From Streetkey listings" right={<Tag kind="warn">Screening only</Tag>}>
            <ul className="clean">{opps.map(({ p, o }) => (
              <li key={p.id + o.id} className="card flat" style={{ padding: 12 }}>
                <div className="row between"><Link to={`/property/${p.id}/intelligence#development`}><b className="small">{p.street.replace(' (fictional)', '')}, {p.town.split(',')[0]}</b></Link><Tag kind={o.status === 'constrained' ? 'warn' : 'demo'}>{o.status}</Tag></div>
                <div className="small">{o.name} · {gbpK(p.price)} asking</div>
                <div className="xs muted">{o.summary}</div>
                {o.constraints.length > 0 && <div className="xs" style={{ color: 'var(--danger)', marginTop: 4 }}>⚠ {o.constraints.join(' · ')}</div>}
              </li>
            ))}</ul>
          </Section>
        </div>

        <div className="stack sticky" style={{ gap: 16 }}>
          <section className="card ink">
            <div className="eyebrow" style={{ color: 'inherit', opacity: 0.6 }}>Residual land value</div>
            <div className="num" style={{ fontSize: 36, marginTop: 6 }}>{gbpK(appraisal.residual)}</div>
            <div className="muted small">{gbpK(appraisal.rlvPerUnit)} per unit · land asking {gbpK(land)}</div>
            <div className="hr" style={{ background: 'rgba(255,255,255,.15)' }} />
            <Stat label="Headroom vs asking" value={gbpK(appraisal.residual - land)} tone={appraisal.residual >= land ? 'pos' : 'neg'} />
          </section>
          <Section title="Sensitivity" kicker="Residual land value">
            <div className="table-wrap" tabIndex={0}><table className="t heat"><thead><tr><th>Build ↓ / GDV →</th>{[-0.05, 0, 0.05].map((g) => <th key={g} className="r">{g > 0 ? '+' : ''}{g * 100}%</th>)}</tr></thead>
              <tbody>{sensitivity.map((row) => <tr key={row[0].b}><td style={{ textAlign: 'left', fontFamily: 'var(--sans)' }}>{row[0].b > 0 ? '+' : ''}{row[0].b * 100}%</td>{row.map(({ g, residual: r }) => <td key={g} style={{ background: r < land ? 'color-mix(in srgb, var(--danger) 18%, transparent)' : 'color-mix(in srgb, var(--sage) 15%, transparent)' }}>{gbpK(r)}</td>)}</tr>)}</tbody></table></div>
          </Section>
          <Section title="Preferred specification" kicker="Design styles explored by buyers" right={<Tag kind="obs">Aggregated</Tag>}>
            {styles.map(([s, n]) => <Meter key={s} label={s} value={n} max={styles[0][1]} display={n.toLocaleString('en-GB')} color="var(--accent)" />)}
          </Section>
          <div className="callout info xs">Demand figures are illustrative scenario inputs, not market statistics. Streetkey will only display market data with a named source, date and sample size.</div>
        </div>
      </div>
    </div>
  );
}
