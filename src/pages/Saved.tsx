import { Link } from 'react-router-dom';
import { getProperty } from '../data/properties';
import { gbp, gbpK, Section, Tag } from '../components/ui';
import { PropertyCard } from '../components/PropertyCard';
import { useStore } from '../store';

export default function Saved() {
  const { saved, designs, viewings, savedSearches, toggleSavedSearch, myListings, setListingStatus, tracked, untrack } = useStore();
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head"><div><h2>Saved homes</h2><p className="muted" style={{ marginTop: 4 }}>Your saved homes, searches, designs and viewings. They are kept on this device, and in your account when you are signed in.</p></div></div>
      <Section title={`Saved homes (${saved.length})`}>
        {saved.length === 0 ? <p className="small muted">Tap the heart on any home to keep it here. <Link to="/search">Start searching</Link></p> :
          <div className="hgrid">{saved.map((id) => { const p = getProperty(id); return p ? <PropertyCard key={id} p={p} /> : null; })}</div>}
      </Section>
      <Section title={`My listings (${myListings.length})`} right={<Link to="/list" className="btn sm">+ List a property</Link>}>
        {myListings.length === 0 ? <p className="small muted">Selling or letting? <Link to="/list">List your property</Link>. It takes about five minutes.</p> :
          <ul className="clean">{myListings.map((m) => <li key={m.id} className="row between card flat" style={{ padding: 10 }}>
            <Link to={`/property/${m.id}`} className="small" style={{ minWidth: 0 }}><b>{m.title}</b><div className="xs muted">{m.listing === 'rent' ? `${gbp(m.price)} pcm` : gbp(m.price)} · {m.postcode}</div></Link>
            <div className="row" style={{ flexWrap: 'nowrap' }}><Tag kind={m.status === 'live' ? 'ok' : 'neutral'}>{m.status}</Tag>
              <select className="input" style={{ width: 'auto' }} value={m.status} onChange={(e) => setListingStatus(m.id, e.target.value as typeof m.status)} aria-label="Listing status"><option value="live">Live</option><option value="under offer">Under offer</option><option value="withdrawn">Withdrawn</option></select></div>
          </li>)}</ul>}
      </Section>
      {tracked.length > 0 && <Section title={`Listings you’re checking from other sites (${tracked.length})`}><ul className="clean small">{tracked.map((t) => <li key={t.id} className="row between"><Link to={`/property/${t.id}/intelligence`}>{t.title}</Link><button className="btn ghost sm" onClick={() => untrack(t.id)}>Remove</button></li>)}</ul></Section>}
      <Section title={`Saved searches (${savedSearches.length})`}>{savedSearches.length === 0 ? <p className="small muted">Save a search from the results page to get an email when new homes match.</p> : <ul className="clean small">{savedSearches.map((s) => <li key={s.q} className="row between"><Link to={`/search?q=${encodeURIComponent(s.q)}&mode=${encodeURIComponent(s.mode)}${s.mode === 'buy' && s.filters ? '&market=buy' : ''}`}>{s.q}</Link><button className="btn ghost sm" onClick={() => toggleSavedSearch(s.q, s.mode)}>Remove</button></li>)}</ul>}</Section>
      <div className="grid g2">
        <Section title={`Saved designs (${designs.length})`}>{designs.length === 0 ? <p className="small muted"><Link to="/studio">Create a design</Link></p> : <ul className="clean small">{designs.map((d) => <li key={d.id} className="row between"><span>{d.style} {d.room} · {getProperty(d.propertyId)?.street.replace(' (fictional)', '')}</span><Link to={`/studio?property=${d.propertyId}&room=${d.room}`} className="num">{gbpK(d.total)}</Link></li>)}</ul>}</Section>
        <Section title={`Viewing requests (${viewings.length})`}>{viewings.length === 0 ? <p className="small muted">None yet.</p> : <ul className="clean small">{viewings.map((v) => <li key={v.id}>{getProperty(v.propertyId)?.street.replace(' (fictional)', '')}, {v.slot} <Tag kind="demo">{v.status}</Tag></li>)}</ul>}</Section>
      </div>
    </div>
  );
}
