import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { BrixoWordmark } from './Brand';
import { Icon } from './Icons';
import { SmartSearch } from './SmartSearch';
import { useStore } from '../store';

const PRIMARY = [
  ['/search', 'Search'], ['/prices', 'Sold prices'], ['/studio', 'Design'], ['/estimate', 'Costs'], ['/invest', 'Invest'], ['/my-home', 'My Home'],
] as const;
const MORE = [
  { title: 'Explore', items: [['/search', 'search', 'Search homes', 'Buy, rent, commercial'], ['/prices', 'pound', 'Sold prices', 'What things really sold for'], ['/compare', 'chart', 'Compare', 'Side-by-side intelligence'], ['/saved', 'heart', 'Saved', 'Homes, searches & designs']] },
  { title: 'Plan & improve', items: [['/my-home', 'home', 'My Home', 'Value, ideas & costs for your home'], ['/studio', 'palette', 'Design studio', 'Redesign a room, see the cost'], ['/estimate', 'tools', 'Refurb costs', 'Regional estimate & BoQ'], ['/invest', 'chart', 'Investment', 'Yields, BRRR, flips, HMOs']] },
  { title: 'For professionals', items: [['/owner', 'tag', 'Owner dashboard', 'How your listing performs'], ['/agents', 'briefcase', 'Agent command centre', 'Portfolio analytics & AI'], ['/landlord', 'key', 'Landlords', 'Lettings & compliance'], ['/developer', 'crane', 'Developers', 'Demand & appraisals'], ['/marketplace', 'tools', 'Contractors', 'Scoped, benchmarked quotes'], ['/automation', 'spark', 'AI agents', 'Automations & approvals'], ['/enterprise', 'building', 'API & Enterprise', 'White-label & widgets']] },
] as const;

export default function Layout() {
  const { pathname } = useLocation();
  const { saved } = useStore();
  const [sheet, setSheet] = useState<null | 'ask' | 'more'>(null);
  const [theme, setTheme] = useState<string | null>(() => { try { return localStorage.getItem('brixo-theme'); } catch { return null; } });
  useEffect(() => { window.scrollTo(0, 0); setSheet(null); }, [pathname]);
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    try { if (theme) localStorage.setItem('brixo-theme', theme); } catch { /* storage unavailable */ }
  }, [theme]);
  useEffect(() => { document.body.style.overflow = sheet ? 'hidden' : ''; }, [sheet]);
  const dark = theme ? theme === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const isHome = pathname === '/';

  return (
    <>
      <header className={`topbar${isHome ? ' on-hero' : ''}`}>
        <div className="topbar-inner">
          <Link to="/" className="logo" aria-label="BRIXO home"><BrixoWordmark /></Link>
          <nav className="nav desktop-only" aria-label="Primary">
            {PRIMARY.map(([to, label]) => <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>)}
          </nav>
          <div className="row" style={{ gap: 8, marginLeft: 'auto', flexWrap: 'nowrap' }}>
            <Link to="/saved" className="icon-btn desktop-only" aria-label={`Saved (${saved.length})`}><Icon name="heart" />{saved.length > 0 && <span className="dot-badge">{saved.length}</span>}</Link>
            <button className="icon-btn desktop-only" aria-label="Toggle colour theme" onClick={() => setTheme(dark ? 'light' : 'dark')}>{dark ? '☀' : '☾'}</button>
            <button className="icon-btn" aria-label="Menu" onClick={() => setSheet('more')}><Icon name="menu" /></button>
          </div>
        </div>
      </header>

      <main className={isHome ? 'home-main' : undefined}><Outlet /></main>

      <footer className="site"><div>
        <span><b>BRIXO</b> — See Beyond the Property. Prototype v0.3 · all listings and figures are demonstration data.</span>
        <span>Not regulated financial, tax, legal, planning, valuation or surveying advice.</span>
      </div></footer>

      <nav className="tabbar" aria-label="App">
        <NavLink to="/" end className={({ isActive }) => (isActive || pathname.startsWith('/search') || pathname.startsWith('/property') ? 'on' : '')}><Icon name="search" /><span>Search</span></NavLink>
        <NavLink to="/saved" className={({ isActive }) => (isActive ? 'on' : '')}><span className="tab-ic"><Icon name="heart" />{saved.length > 0 && <span className="dot-badge">{saved.length}</span>}</span><span>Saved</span></NavLink>
        <button className="tab-ask" onClick={() => setSheet('ask')} aria-label="Ask BRIXO AI"><span className="ask-bubble"><Icon name="spark" size={26} /></span><span>Ask</span></button>
        <NavLink to="/my-home" className={({ isActive }) => (isActive ? 'on' : '')}><Icon name="home" /><span>My Home</span></NavLink>
        <button className={sheet === 'more' ? 'on' : ''} onClick={() => setSheet('more')}><Icon name="menu" /><span>More</span></button>
      </nav>

      {sheet && <div className="scrim" onClick={() => setSheet(null)} />}
      {sheet === 'ask' && (
        <div className="sheet" role="dialog" aria-label="Ask BRIXO">
          <div className="sheet-grab" />
          <div className="row between"><h3>Ask BRIXO</h3><button className="icon-btn" aria-label="Close" onClick={() => setSheet(null)}><Icon name="x" /></button></div>
          <p className="small muted" style={{ margin: '4px 0 12px' }}>A place, a postcode, or what you want in your own words.</p>
          <SmartSearch autoFocus onDone={() => setSheet(null)} />
        </div>
      )}
      {sheet === 'more' && (
        <div className="sheet sheet-tall" role="dialog" aria-label="Menu">
          <div className="sheet-grab" />
          <div className="row between"><h3>Everything on BRIXO</h3><div className="row" style={{ flexWrap: 'nowrap' }}><button className="icon-btn" aria-label="Toggle colour theme" onClick={() => setTheme(dark ? 'light' : 'dark')}>{dark ? '☀' : '☾'}</button><button className="icon-btn" aria-label="Close" onClick={() => setSheet(null)}><Icon name="x" /></button></div></div>
          {MORE.map((g) => (
            <div key={g.title} style={{ marginTop: 14 }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>{g.title}</div>
              <div className="menu-grid">{g.items.map(([to, ic, label, sub]) => <Link key={to + label} to={to} className="menu-item"><span className="menu-ic"><Icon name={ic} /></span><span><b>{label}</b><small>{sub}</small></span></Link>)}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
