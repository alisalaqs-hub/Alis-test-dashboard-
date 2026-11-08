import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { PROPERTIES } from '../data/properties';
import { dealScore } from '../engine/insights';
import { parseQuery, runSearch } from '../engine/search';
import { destination, SmartSearch, type Mode } from '../components/SmartSearch';
import { Icon } from '../components/Icons';
import { gbp, gbpK, HouseArt, Tag } from '../components/ui';
import { useStore } from '../store';
import { XRayHero } from '../components/XRay';
import { StreetkeyLogo } from '../components/StreetkeyLogo';

const TASKS: { to: string; icon: string; label: string; sub: string; tone: string }[] = [
  { to: destination('buy', 'homes for sale in London'), icon: 'search', label: 'Buy a home', sub: 'Search & AI matches', tone: 'ink' },
  { to: destination('rent', 'homes'), icon: 'key', label: 'Rent a home', sub: 'Homes to let', tone: 'ink' },
  { to: '/my-home', icon: 'home', label: 'What’s my home worth?', sub: 'Value, ideas & costs', tone: 'accent' },
  { to: '/import', icon: 'spark', label: 'Check any listing', sub: 'Paste one from any website', tone: 'ai' },
  { to: '/estimate', icon: 'tools', label: 'Cost a renovation', sub: 'Room-by-room estimate', tone: 'accent' },
  { to: '/studio', icon: 'palette', label: 'Redesign a room', sub: 'See it, then price it', tone: 'ai' },
  { to: '/invest', icon: 'chart', label: 'Check an investment', sub: 'Yield, cash flow, stress test', tone: 'ink' },
  { to: '/list', icon: 'tag', label: 'List your property', sub: 'Sell or let it yourself', tone: 'accent' },
];

export default function Home() {
  const { recent, savedSearches, toggleSavedSearch, saved, toggleSaved } = useStore();
  const forYou = useMemo(() => PROPERTIES.filter((p) => p.listing !== 'rent' && p.type !== 'commercial').map((p) => ({ p, ds: dealScore(p) })).sort((a, b) => b.ds.total - a.ds.total).slice(0, 8), []);
  const resume = recent[0] ?? { q: '3 bed house in London under £500k', mode: 'buy', at: '' };
  const resumeCount = useMemo(() => runSearch(parseQuery(resume.mode === 'rent' ? `${resume.q} to rent` : resume.q)).length, [resume.q, resume.mode]);
  const isSaved = savedSearches.some((s) => s.q === resume.q);

  return (
    <div className="home">
      <section className="home-hero" aria-labelledby="hero-h">
        <div className="home-hero-inner">
          <div className="hero-copy">
            <div className="row" style={{ gap: 8 }}><span className="label-mono">Find</span><Tag kind="demo">Demo data</Tag></div>
            <h1 id="hero-h">Find a home<i className="stop">.</i><br /><span>Unlock the whole street<b className="stop">.</b></span></h1>
            <p className="hero-sub">Every home comes with its value, the true cost of works, schools, travel, energy and what it could become — before you book a viewing.</p>
            <SmartSearch />
          </div>
          <div className="hero-xray"><StreetkeyLogo /></div>
        </div>
      </section>

      <div className="home-body">
        <section className="resume card">
          <div className="row between" style={{ flexWrap: 'nowrap', gap: 12 }}>
            <Link to={destination(resume.mode as Mode, resume.q)} className="row" style={{ flexWrap: 'nowrap', gap: 12, textDecoration: 'none', minWidth: 0 }}>
              <span className="resume-thumb"><HouseArt hue={18} type="terraced" /></span>
              <span style={{ minWidth: 0 }}>
                <span className="eyebrow">{recent.length ? 'Pick up where you left off' : 'Suggested search'}</span>
                <b className="resume-q">{resume.q}</b>
                <span className="xs muted">{resumeCount} match{resumeCount === 1 ? '' : 'es'} · {resume.mode === 'rent' ? 'To rent' : 'For sale'}</span>
              </span>
            </Link>
            <button className={`icon-btn${isSaved ? ' saved' : ''}`} aria-label={isSaved ? 'Unsave search' : 'Save search & get alerts'} onClick={() => toggleSavedSearch(resume.q, resume.mode)}><Icon name="heart" /></button>
          </div>
          {isSaved && <div className="xs muted" style={{ marginTop: 8 }}>Saved — you’ll be alerted to new matches (alerts need sign-in in production).</div>}
        </section>

        <section>
          <span className="label-mono">Get started</span>
          <h2 className="home-h">What would you like to do?</h2>
          <div className="task-grid">
            {TASKS.map((t) => (
              <Link key={t.label} to={t.to} className={`task task-${t.tone}`}>
                <span className="task-ic"><Icon name={t.icon} /></span>
                <b>{t.label}</b>
                <small>{t.sub}</small>
              </Link>
            ))}
          </div>
        </section>

        <section>
          <span className="label-mono">For you</span>
          <div className="row between"><h2 className="home-h">Picked for you</h2><Link to={destination('buy', 'homes for sale')} className="small" style={{ fontWeight: 600 }}>See all →</Link></div>
          <p className="small muted" style={{ marginTop: -6, marginBottom: 12 }}>Ranked by Streetkey deal score — every card shows the price check and renovation cost.</p>
          <div className="carousel">
            {forYou.map(({ p, ds }, i) => (
              <article key={p.id} className="pcard">
                <Link to={`/property/${p.id}`} className="pcard-img"><HouseArt hue={p.photoHue} type={p.type} seed={i} /><span className={`grade grade-${ds.grade} pcard-grade`}>{ds.grade}</span></Link>
                <button className={`pcard-heart${saved.includes(p.id) ? ' on' : ''}`} aria-label={saved.includes(p.id) ? 'Remove from saved' : 'Save'} onClick={() => toggleSaved(p.id)}><Icon name="heart" size={20} /></button>
                <Link to={`/property/${p.id}`} className="pcard-body">
                  <span className="num" style={{ fontSize: 19 }}>{gbp(p.price)}</span>
                  <span className="small" style={{ fontWeight: 600 }}>{p.beds} bed {p.type} · {p.town.split(',')[0]}</span>
                  <span className="pcard-ai"><Icon name="spark" size={14} /> Works ≈ {gbpK(ds.refurbEstimate)} · value-add {gbpK(ds.uplift)}</span>
                </Link>
              </article>
            ))}
          </div>
        </section>

        <section className="xr-section" aria-labelledby="xr-h">
          <div>
            <span className="label-mono">Look inside</span>
            <h2 id="xr-h" className="home-h">Look inside any listing</h2>
            <p className="muted" style={{ maxWidth: 460 }}>Every Streetkey listing has its plans underneath: what the works really cost, where the space is, how efficient it could be and what it could be worth. Drag the lens across the house.</p>
            <Link to="/import" className="btn" style={{ marginTop: 14 }}>Check a listing from any website →</Link>
          </div>
          <XRayHero />
        </section>

        <section className="myhome-cta card ink">
          <div>
            <span className="eyebrow" style={{ color: 'inherit', opacity: 0.6 }}>Own a home?</span>
            <h2 style={{ marginTop: 6 }}>Know what it’s worth — and what it could be worth.</h2>
            <p className="muted small" style={{ marginTop: 6 }}>Value range, loft & extension ideas, renovation costs and an energy upgrade plan in under a minute.</p>
          </div>
          <Link to="/my-home" className="btn accent">Check my home <Icon name="arrow" size={18} /></Link>
        </section>

        <section className="lenses">
          {[
            ['tag', 'Price check', 'Is the asking price fair? Ranges from comparable sales.'],
            ['tools', 'True cost of works', 'Regional, trade-by-trade estimates with VAT.'],
            ['palette', 'Design ideas', 'Restyle any room and see the price.'],
            ['chart', 'Investment view', 'Yield, cash flow and stress tests.'],
          ].map(([ic, t, s]) => <div key={t} className="lens"><span className="task-ic"><Icon name={ic} /></span><div><b>{t}</b><small>{s}</small></div></div>)}
        </section>

        <section>
          <span className="label-mono">Professionals</span>
          <h2 className="home-h">For professionals</h2>
          <div className="chips">
            {[['/agents', 'Estate agents'], ['/landlord', 'Landlords'], ['/developer', 'Developers'], ['/marketplace', 'Contractors'], ['/automation', 'AI agents'], ['/enterprise', 'API & white-label']].map(([to, l]) => <Link key={to} to={to} className="chip">{l} →</Link>)}
          </div>
        </section>
      </div>
    </div>
  );
}
