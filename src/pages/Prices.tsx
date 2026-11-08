import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PROPERTIES } from '../data/properties';
import { gbp, gbpK, Section, Spark, Stat, Tag } from '../components/ui';

/** Sold prices — built from comparables & price history in the demo dataset. Production: HM Land Registry Price Paid (OGL). */
export default function Prices() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const term = (params.get('q') ?? '').trim().toLowerCase();
  const rows = useMemo(() => PROPERTIES.filter((p) => !term || p.town.toLowerCase().includes(term) || p.district.toLowerCase() === term || p.postcode.toLowerCase().startsWith(term)).flatMap((p) => [
    ...p.comparables.filter((c) => c.kind === 'sold').map((c) => ({ key: p.id + c.address, address: c.address, area: `${p.town.split(',')[0]} · ${p.district}`, beds: c.beds, price: c.price, date: c.date, note: c.refurbished ? 'Refurbished' : 'Unmodernised', near: p })),
    ...p.priceHistory.filter((h) => h.event === 'Sold').map((h) => ({ key: p.id + h.date, address: p.street, area: `${p.town.split(',')[0]} · ${p.district}`, beds: p.beds, price: h.price, date: h.date, note: 'Previous sale', near: p })),
  ]).sort((a, b) => b.date.localeCompare(a.date)), [term]);
  const recent = rows.filter((r) => r.date >= '2025-11');
  const sorted = [...recent].map((r) => r.price).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const idx = rows[0]?.near.areaIndex;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div><div className="eyebrow">Sold prices</div><h2 style={{ marginTop: 6 }}>What homes really sold for</h2></div>
        <div className="row"><Tag kind="demo">Demo sales</Tag><Tag kind="live">HM Land Registry Price Paid (OGL)</Tag></div>
      </div>
      <form className="smart-box" style={{ maxWidth: 640 }} onSubmit={(e) => { e.preventDefault(); setParams(q ? { q } : {}); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Town or postcode, e.g. Croydon or E17" aria-label="Town or postcode" />
        <button className="smart-go" type="submit">Show prices</button>
      </form>
      <div className="chips">{['Walthamstow', 'Croydon', 'Manchester', 'Leeds', 'Bristol', 'Cardiff', 'Glasgow'].map((c) => <button key={c} className="chip" onClick={() => { setQ(c); setParams({ q: c }); }}>{c}</button>)}</div>
      <div className="grid g3">
        <div className="card"><Stat label="Sales in the last 12 months" value={recent.length} sub={term ? `in “${params.get('q')}”` : 'all demo areas'} /></div>
        <div className="card"><Stat label="Median sold price (12m)" value={median ? gbpK(median) : '—'} /></div>
        <div className="card"><Stat label="Area trend (24m)" value={idx ? `${(idx[23] - 100).toFixed(1)}%` : '—'} />{idx && <Spark data={idx} height={36} />}</div>
      </div>
      <Section title={`${rows.length} sales`} kicker="Most recent first">
        {rows.length === 0 ? <p className="small muted">No demo sales for that search. Try one of the areas above.</p> :
          <div className="table-wrap" tabIndex={0}><table className="t"><thead><tr><th>Address</th><th>Beds</th><th className="r">Price</th><th>Date</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.key}><td className="small"><b>{r.address.replace(' (fictional)', '')}</b><div className="xs muted">{r.area} · {r.note} · <Link to={`/property/${r.near.id}`}>nearby listing</Link></div></td><td className="num">{r.beds}</td><td className="r num">{gbp(r.price)}</td><td className="small">{r.date}</td></tr>)}</tbody></table></div>}
      </Section>
    </div>
  );
}
