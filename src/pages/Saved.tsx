import { Link } from 'react-router-dom';
import { getProperty } from '../data/properties';
import { gbp, gbpK, HouseArt, Section, Tag } from '../components/ui';
import { useStore } from '../store';

export default function Saved() {
  const { saved, designs, viewings, toggleSaved, savedSearches, toggleSavedSearch } = useStore();
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head"><div><div className="eyebrow">Your BRIXO</div><h2 style={{ marginTop: 6 }}>Saved properties, designs & viewings</h2></div><Tag kind="neutral">Stored in this browser (prototype)</Tag></div>
      <Section title={`Saved properties (${saved.length})`}>
        {saved.length === 0 ? <p className="small muted">Tap ♡ Save on any listing. <Link to="/search">Start searching →</Link></p> :
          <div className="grid g3">{saved.map((id) => { const p = getProperty(id); if (!p) return null; return (
            <div key={id} className="card flat" style={{ padding: 10 }}>
              <Link to={`/property/${id}`} style={{ textDecoration: 'none' }}><div style={{ height: 120, borderRadius: 10, overflow: 'hidden' }}><HouseArt hue={p.photoHue} type={p.type} /></div><div className="num" style={{ marginTop: 6 }}>{gbp(p.price)}</div><div className="small">{p.title}</div></Link>
              <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => toggleSaved(id)}>Remove</button>
            </div>); })}</div>}
      </Section>
      <Section title={`Saved searches (${savedSearches.length})`}>{savedSearches.length === 0 ? <p className="small muted">Tap ♡ on a search to save it and get alerts for new matches.</p> : <ul className="clean small">{savedSearches.map((s) => <li key={s.q} className="row between"><Link to={`/search?q=${encodeURIComponent(s.q)}&mode=${s.mode}`}>{s.q}</Link><button className="btn ghost sm" onClick={() => toggleSavedSearch(s.q, s.mode)}>Remove</button></li>)}</ul>}</Section>
      <div className="grid g2">
        <Section title={`Saved designs (${designs.length})`}>{designs.length === 0 ? <p className="small muted"><Link to="/studio">Create a design →</Link></p> : <ul className="clean small">{designs.map((d) => <li key={d.id} className="row between"><span>{d.style} {d.room} · {getProperty(d.propertyId)?.street.replace(' (fictional)', '')}</span><Link to={`/studio?property=${d.propertyId}&room=${d.room}`} className="num">{gbpK(d.total)}</Link></li>)}</ul>}</Section>
        <Section title={`Viewing requests (${viewings.length})`}>{viewings.length === 0 ? <p className="small muted">None yet.</p> : <ul className="clean small">{viewings.map((v) => <li key={v.id}>{getProperty(v.propertyId)?.street.replace(' (fictional)', '')} — {v.slot} <Tag kind="demo">{v.status}</Tag></li>)}</ul>}</Section>
      </div>
    </div>
  );
}
