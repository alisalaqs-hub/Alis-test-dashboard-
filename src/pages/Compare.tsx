import { Link, useSearchParams } from 'react-router-dom';
import { getProperty, type Property } from '../data/properties';
import { dealScore, refurbInputFor } from '../engine/insights';
import { estimateRefurb } from '../engine/refurb';
import { rentalScenario, valuationScenario } from '../engine/valuation';
import { gbp, gbpK, HouseArt, Tag } from '../components/ui';
import { useStore } from '../store';

type Row = { label: string; get: (p: Property) => number | string; best?: 'min' | 'max'; fmt?: (n: number) => string };

export default function Compare() {
  const [params] = useSearchParams();
  const { compare, toggleCompare } = useStore();
  const ids = params.get('ids')?.split(',') ?? (compare.length ? compare : ['wal-001', 'cro-002', 'ley-014']);
  const props = ids.map(getProperty).filter(Boolean) as Property[];
  const data = new Map(props.map((p) => [p.id, { ds: dealScore(p), est: estimateRefurb(refurbInputFor(p)), v: valuationScenario(p), r: rentalScenario(p) }]));
  const rows: Row[] = [
    { label: 'Price', get: (p) => p.price, best: 'min', fmt: gbp },
    { label: '£ per m²', get: (p) => Math.round(p.price / Math.max(1, p.floorArea)), best: 'min', fmt: gbp },
    { label: 'Bedrooms', get: (p) => p.beds, best: 'max' },
    { label: 'Floor area (m²)', get: (p) => p.floorArea, best: 'max' },
    { label: 'EPC score', get: (p) => p.epc.score, best: 'max' },
    { label: 'Refurb estimate', get: (p) => data.get(p.id)!.est.total, best: 'min', fmt: gbpK },
    { label: 'Post-works value', get: (p) => data.get(p.id)!.v.postWorks.mid, best: 'max', fmt: gbpK },
    { label: 'Indicative value-add', get: (p) => Math.round(data.get(p.id)!.ds.uplift), best: 'max', fmt: gbpK },
    { label: 'Rent (mid, pcm)', get: (p) => data.get(p.id)!.r.mid, best: 'max', fmt: gbp },
    { label: 'Gross yield (all-in)', get: (p) => +(data.get(p.id)!.ds.grossYield * 100).toFixed(2), best: 'max', fmt: (n) => `${n}%` },
    { label: 'Deal score', get: (p) => data.get(p.id)!.ds.total, best: 'max' },
    { label: 'Price check', get: (p) => data.get(p.id)!.v.verdict },
    { label: 'Commute', get: (p) => p.commute.minutes + p.station.walkMins, best: 'min', fmt: (n) => `${n} min` },
    { label: 'Flood / subsidence', get: (p) => `${p.risks.flood} / ${p.risks.subsidence}` },
    { label: 'Days on market', get: (p) => p.daysOnMarket },
  ];
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head"><div><div className="eyebrow">Compare</div><h2 style={{ marginTop: 6 }}>Side-by-side intelligence</h2><p className="muted" style={{ marginTop: 6 }}>Best value in each row is highlighted. Add properties from search (up to 3).</p></div><Tag kind="demo" /></div>
      <div className="card"><div className="table-wrap" tabIndex={0}><table className="t">
        <thead><tr><th />{props.map((p) => <th key={p.id} style={{ minWidth: 180 }}><div style={{ height: 90, borderRadius: 10, overflow: 'hidden', marginBottom: 6 }}><HouseArt hue={p.photoHue} type={p.type} /></div><Link to={`/property/${p.id}`} style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13, color: 'var(--ink)' }}>{p.street.replace(' (fictional)', '')}, {p.town.split(',')[0]}</Link>{compare.includes(p.id) && <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => toggleCompare(p.id)}>✕</button>}</th>)}</tr></thead>
        <tbody>{rows.map((r) => { const vals = props.map(r.get); const nums = vals.filter((v): v is number => typeof v === 'number'); const best = r.best && nums.length === vals.length ? (r.best === 'min' ? Math.min(...nums) : Math.max(...nums)) : null; return (
          <tr key={r.label}><td className="small muted">{r.label}</td>{vals.map((v, k) => <td key={k} className="num" style={best != null && v === best ? { background: 'var(--sage-soft)', fontWeight: 700 } : undefined}>{typeof v === 'number' ? (r.fmt ? r.fmt(v) : v) : v}</td>)}</tr>
        ); })}</tbody>
      </table></div></div>
    </div>
  );
}
