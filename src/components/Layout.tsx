import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { StreetkeyBow, StreetkeyWordmark } from './Brand';
import { Icon } from './Icons';
import { SmartSearch } from './SmartSearch';
import { useStore } from '../store';

const PRIMARY = [
  ['/search', 'Search'], ['/list', 'List a property'], ['/prices', 'Sold prices'], ['/studio', 'Design'], ['/estimate', 'Costs'], ['/invest', 'Invest'], ['/my-home', 'My Home'],
] as const;
const MORE = [
  { title: 'Explore', items: [['/search', 'search', 'Search homes', 'Buy, rent, commercial'], ['/prices', 'pound', 'Sold prices', 'What things really sold for'], ['/import', 'spark', 'Check any listing', 'From any website, privately'], ['/compare', 'chart', 'Compare', 'Side-by-side intelligence'], ['/saved', 'heart', 'Saved', 'Homes, searches & designs']] },
  { title: 'Sell & let', items: [['/list', 'tag', 'List your property', 'Sell or let it yourself'], ['/owner', 'chart', 'Owner dashboard', 'How your listing performs']] },
  { title: 'Plan & improve', items: [['/my-home', 'home', 'My Home', 'Value, ideas & costs for your home'], ['/studio', 'palette', 'Design studio', 'Redesign a room, see the cost'], ['/estimate', 'tools', 'Refurb costs', 'Regional estimate & BoQ'], ['/invest', 'chart', 'Investment', 'Yields, BRRR, flips, HMOs']] },
  { title: 'For professionals', items: [['/sources', 'building', 'Listing feeds', 'Connect your CRM to Streetkey'], ['/agents', 'briefcase', 'Agent command centre', 'Portfolio analytics & AI'], ['/landlord', 'key', 'Landlords', 'Lettings & compliance'], ['/developer', 'crane', 'Developers', 'Demand & appraisals'], ['/marketplace', 'tools', 'Contractors', 'Scoped, benchmarked quotes'], ['/automation', 'spark', 'AI agents', 'Automations & approvals'], ['/enterprise', 'building', 'API & Enterprise', 'White-label & widgets']] },
] as const;

export default function Layout() {
  const { pathname } = useLocation();
  const { saved } = useStore();
  const [sheet, setSheet] = useState<null | 'ask' | 'more'>(null);
  const [theme, setTheme] = useState<string | null>(() => { try { return localStorage.getItem('streetkey-theme'); } catch { return null; } });
  useEffect(() => { window.scrollTo(0, 0); setSheet(null); }, [pathname]);
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    try { if (theme) localStorage.setItem('streetkey-theme', theme); } catch { /* storage unavailable */ }
  }, [theme]);
  const sheetRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Modal sheet a11y: lock scroll, move focus in, trap Tab, close on Escape, restore focus.
  useEffect(() => {
    document.body.style.overflow = sheet ? 'hidden' : '';
    if (!sheet) { opener.current?.focus?.(); return; }
    opener.current = document.activeElement as HTMLElement;
    const el = sheetRef.current;
    const focusables = () => [...(el?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? [])];
    if (sheet === 'more') focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setSheet(null); }
      if (e.key === 'Tab') { const f = focusables(); if (!f.length) return; const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheet]);
  const dark = theme ? theme === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const isHome = pathname === '/';

  return (
    <>
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to main content</a>
      <div className="preview-bar" role="note"><div><b>PUBLIC PREVIEW</b><span className="pv-long">Listings and figures are demonstration data. Estimates are not advice.</span><span className="pv-short">Demo data · not advice</span><Link to="/terms">Terms</Link></div></div>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="logo" aria-label="Streetkey home" onClick={() => { if (pathname === '/') window.dispatchEvent(new Event('streetkey:turn')); }}><StreetkeyWordmark /></Link>
          <nav className="nav desktop-only" aria-label="Primary">
            {PRIMARY.map(([to, label]) => <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>)}
          </nav>
          <div className="row" style={{ gap: 8, marginLeft: 'auto', flexWrap: 'nowrap' }}>
            <Link to="/saved" className="icon-btn desktop-only" aria-label={`Saved (${saved.length})`}><Icon name="heart" />{saved.length > 0 && <span className="dot-badge">{saved.length}</span>}</Link>
            <button className="icon-btn desktop-only" aria-label="Toggle colour theme" onClick={() => setTheme(dark ? 'light' : 'dark')}>{dark ? '☀' : '☾'}</button>
            <button className="icon-btn" aria-label="Menu" aria-haspopup="dialog" onClick={() => setSheet('more')}><Icon name="menu" /></button>
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} className={isHome ? 'home-main' : undefined}><Outlet /></main>

      <footer className="site"><div>
        <span className="row" style={{ gap: 10 }}><StreetkeyBow size={22} /> <span><b>Streetkey</b> — See Beyond the Property. Public preview · listings and figures are demonstration data.</span></span>
        <nav aria-label="Legal"><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link><Link to="/accessibility">Accessibility</Link><Link to="/sources">Listing feeds</Link></nav>
      </div></footer>

      <nav className="tabbar" aria-label="App">
        <NavLink to="/" end className={({ isActive }) => (isActive || pathname.startsWith('/search') || pathname.startsWith('/property') ? 'on' : '')}><Icon name="search" /><span>Search</span></NavLink>
        <NavLink to="/saved" className={({ isActive }) => (isActive ? 'on' : '')}><span className="tab-ic"><Icon name="heart" />{saved.length > 0 && <span className="dot-badge">{saved.length}</span>}</span><span>Saved</span></NavLink>
        <button className="tab-ask" onClick={() => setSheet('ask')} aria-label="Ask Streetkey AI" aria-haspopup="dialog"><span className="ask-bubble"><Icon name="spark" size={26} /></span><span>Ask</span></button>
        <NavLink to="/my-home" className={({ isActive }) => (isActive ? 'on' : '')}><Icon name="home" /><span>My Home</span></NavLink>
        <button className={sheet === 'more' ? 'on' : ''} onClick={() => setSheet('more')} aria-haspopup="dialog"><Icon name="menu" /><span>More</span></button>
      </nav>

      {sheet && <div className="scrim" onClick={() => setSheet(null)} />}
      {sheet === 'ask' && (
        <div ref={sheetRef} className="sheet" role="dialog" aria-modal="true" aria-label="Ask Streetkey">
          <div className="sheet-grab" />
          <div className="row between"><h2 className="sheet-h">Ask Streetkey</h2><button className="icon-btn" aria-label="Close" onClick={() => setSheet(null)}><Icon name="x" /></button></div>
          <p className="small muted" style={{ margin: '4px 0 12px' }}>A place, a postcode, or what you want in your own words.</p>
          <SmartSearch autoFocus onDone={() => setSheet(null)} />
        </div>
      )}
      {sheet === 'more' && (
        <div ref={sheetRef} className="sheet sheet-tall" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="sheet-grab" />
          <div className="row between"><h2 className="sheet-h">Everything on Streetkey</h2><div className="row" style={{ flexWrap: 'nowrap' }}><button className="icon-btn" aria-label="Toggle colour theme" onClick={() => setTheme(dark ? 'light' : 'dark')}>{dark ? '☀' : '☾'}</button><button className="icon-btn" aria-label="Close" onClick={() => setSheet(null)}><Icon name="x" /></button></div></div>
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
