import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { StreetkeyWordmark } from './Brand';
import { Icon } from './Icons';
import { AskLauncher, AskSheet } from './ai/AskChat';
import { useStore } from '../store';
import { applyMeta, metaFor } from '../lib/meta';
import { useAi } from '../lib/ai/core';
import { useServer } from '../lib/server';

/** The two searches most people start from. */
const BUY = '/search?q=homes%20for%20sale&mode=buy';
const RENT = '/search?q=homes%20to%20rent&mode=rent';
/** The header: what people come to a property site to do. Everything else is in the menu. */
const PRIMARY = [[BUY, 'Buy', 'buy'], [RENT, 'Rent', 'rent'], ['/prices', 'Sold prices', 'sold'], ['/list', 'Sell or let', 'list'], ['/my-home', 'My home', 'mine']] as const;
/** Which header link the current page belongs to. */
function section(pathname: string, search: string): string {
  if (pathname.startsWith('/to-rent') || (pathname === '/search' && /[?&]mode=rent\b|to%20rent|to\+rent/.test(search))) return 'rent';
  if (pathname === '/search' || pathname.startsWith('/for-sale')) return 'buy';
  if (pathname.startsWith('/prices') || pathname.startsWith('/sold-prices')) return 'sold';
  if (pathname.startsWith('/list') || pathname.startsWith('/floor-plan')) return 'list';
  if (pathname.startsWith('/my-home')) return 'mine';
  return '';
}
const FOOTER: { title: string; links: [to: string, label: string][] }[] = [
  { title: 'Find a home', links: [[BUY, 'Homes for sale'], [RENT, 'Homes to rent'], ['/prices', 'Sold prices'], ['/saved', 'Saved homes'], ['/compare', 'Compare homes']] },
  { title: 'Sell or let', links: [['/list', 'List your property'], ['/floor-plan', 'Floor plan maker'], ['/my-home', 'What homes like mine sold for'], ['/account/listings', 'My listings']] },
  { title: 'Tools', links: [['/import', 'Check any listing'], ['/estimate', 'Renovation costs'], ['/studio', 'Room design'], ['/invest', 'Investment calculator']] },
  { title: 'For professionals', links: [['/agents', 'Estate and letting agents'], ['/landlord', 'Landlords'], ['/account/agency', 'Your agency']] },
];
const MORE = [
  { title: 'Find a home', items: [[BUY, 'search', 'Homes for sale', 'Search, map and alerts'], [RENT, 'key', 'Homes to rent', 'Search, map and alerts'], ['/prices', 'pound', 'Sold prices', 'What homes really sold for'], ['/saved', 'heart', 'Saved', 'Homes and searches'], ['/compare', 'chart', 'Compare', 'Homes side by side']] },
  { title: 'Sell or let', items: [['/list', 'tag', 'List your property', 'For sale or to let'], ['/floor-plan', 'plan', 'Floor plan maker', 'Draw a plan from your measurements'], ['/my-home', 'home', 'My home', 'What sold nearby, and ideas for yours'], ['/account/listings', 'key', 'My listings and inbox', 'Manage listings, reply to enquiries']] },
  { title: 'Tools', items: [['/import', 'spark', 'Check any listing', 'From any website, privately'], ['/estimate', 'tools', 'Renovation costs', 'Room by room, for your area'], ['/studio', 'palette', 'Room design', 'Restyle a room, see the cost'], ['/invest', 'chart', 'Investment calculator', 'Yield, cash flow and stamp duty']] },
  { title: 'For professionals', items: [['/agents', 'building', 'Estate and letting agents', 'List free, with leads and results'], ['/landlord', 'key', 'Landlords', 'Advertise a rental'], ['/account/agency', 'briefcase', 'Your agency', 'Profile, feeds, valuation requests']] },
] as const;

export default function Layout() {
  const { pathname, search } = useLocation();
  const here = section(pathname, search);
  const { saved } = useStore();
  const { online, user } = useServer();
  const { available: aiOn } = useAi();
  const [sheet, setSheet] = useState<null | 'ask' | 'more'>(null);
  useEffect(() => { window.scrollTo(0, 0); setSheet(null); }, [pathname]);
  // Each page's title, description and search-engine rule. Pages that depend on what they load set their own.
  useEffect(() => { const m = metaFor(pathname); if (!m.dynamic) applyMeta(m, pathname); }, [pathname]);
  const sheetRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const shown = useRef<null | 'ask' | 'more'>(null);
  /**
   * Opens a sheet, remembering what had focus first. This must happen before the sheet renders:
   * the Ask sheet's box takes focus as it mounts (child effects run before this component's).
   */
  const openSheet = (s: 'ask' | 'more') => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !sheetRef.current?.contains(a)) opener.current = a;
    setSheet(s);
  };
  // Modal sheet a11y: lock scroll, move focus in, trap Tab, close on Escape, restore focus.
  useEffect(() => {
    document.body.style.overflow = sheet ? 'hidden' : '';
    if (!sheet) {
      const was = shown.current;
      shown.current = null;
      if (!was) return; // nothing was open (first render)
      // Back to what opened it; if that's gone (it was inside the page that changed, or hidden),
      // to the visible Ask launcher (desktop) or Ask tab (phone), or the Menu button.
      const usable = (x: HTMLElement | null | undefined): x is HTMLElement => !!x && x.isConnected && x !== document.body && x.getClientRects().length > 0;
      const back = [opener.current, ...document.querySelectorAll<HTMLElement>(was === 'ask' ? '.ask-launch, .tab-ask' : '.topbar [aria-label="Menu"], .tabbar [data-more]')].find(usable);
      opener.current = null;
      back?.focus();
      return;
    }
    shown.current = sheet;
    const el = sheetRef.current;
    const focusables = () => [...(el?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? [])];
    if (sheet === 'more') focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      // A control inside the sheet that used Escape itself (e.g. closing search suggestions) has the last word.
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); setSheet(null); }
      if (e.key === 'Tab') { const f = focusables(); if (!f.length) return; const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheet]);
  const isHome = pathname === '/';

  return (
    <>
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to main content</a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="logo" aria-label="Streetkey home" onClick={() => { if (pathname === '/') window.dispatchEvent(new Event('streetkey:turn')); }}><StreetkeyWordmark /></Link>
          <nav className="nav desktop-only" aria-label="Primary">
            {PRIMARY.map(([to, label, id]) => <Link key={id} to={to} className={here === id ? 'active' : ''} aria-current={here === id ? 'page' : undefined}>{label}</Link>)}
          </nav>
          <div className="row" style={{ gap: 8, marginLeft: 'auto', flexWrap: 'nowrap' }}>
            <AskLauncher onOpen={() => openSheet('ask')} />
            <Link to="/saved" className="icon-btn desktop-only" aria-label={`Saved (${saved.length})`}><Icon name="heart" />{saved.length > 0 && <span className="dot-badge">{saved.length}</span>}</Link>
            {online && (user
              ? (() => { const ini = user.name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase(); return <Link to="/account" className="icon-btn acct-btn" aria-label={`${ini}: your account`} title={`${user.name}: your account`}>{ini}</Link>; })()
              : <Link to="/account" className="btn sm ghost signin-btn">Sign in</Link>)}
            <button type="button" className="icon-btn" aria-label="Menu" aria-haspopup="dialog" onClick={() => openSheet('more')}><Icon name="menu" /></button>
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} className={isHome ? 'home-main' : undefined}><Outlet /></main>

      <footer className="site">
        <div className="foot">
          <div className="foot-brand">
            <Link to="/" className="logo" aria-label="Streetkey home"><StreetkeyWordmark /></Link>
            <p>Homes for sale and to rent, with the full picture: real sold prices, flood risk, energy ratings and the cost of works.</p>
          </div>
          {FOOTER.map((g) => (
            <nav key={g.title} aria-label={g.title} className="foot-col">
              <h2>{g.title}</h2>
              <ul>{g.links.map(([to, label]) => <li key={label}><Link to={to}>{label}</Link></li>)}</ul>
            </nav>
          ))}
        </div>
        <div className="foot-base">
          <p>© {new Date().getFullYear()} Streetkey. {online ? 'Listings marked “Example” are illustrations, not homes for sale.' : 'Listings shown are examples, not homes for sale.'} Estimates are a guide, not advice. Sold prices from HM Land Registry; flood risk from the Environment Agency.</p>
          <nav aria-label="Legal"><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link><Link to="/accessibility">Accessibility</Link><Link to="/data-sources">Data sources</Link></nav>
        </div>
      </footer>

      <nav className={`tabbar${/^\/property\/[^/]+\/?$/.test(pathname) ? ' on-listing' : ''}`} aria-label="App">
        <NavLink to="/" end className={({ isActive }) => (isActive || pathname.startsWith('/search') || pathname.startsWith('/property') ? 'on' : '')}><Icon name="search" /><span>Search</span></NavLink>
        <NavLink to="/saved" className={({ isActive }) => (isActive ? 'on' : '')}><span className="tab-ic"><Icon name="heart" />{saved.length > 0 && <span className="dot-badge">{saved.length}</span>}</span><span>Saved</span></NavLink>
        {/* Says "AI" only when AI can answer; without it the sheet is Streetkey's search. */}
        <button type="button" className="tab-ask" onClick={() => openSheet('ask')} aria-label={aiOn ? 'Ask Streetkey AI' : 'Ask Streetkey'} aria-haspopup="dialog"><span className="ask-bubble"><Icon name="spark" size={26} stroke={2.2} /></span><span>Ask</span></button>
        <NavLink to="/my-home" className={({ isActive }) => (isActive ? 'on' : '')}><Icon name="home" /><span>My Home</span></NavLink>
        <button type="button" data-more className={sheet === 'more' ? 'on' : ''} onClick={() => openSheet('more')} aria-haspopup="dialog"><Icon name="menu" /><span>More</span></button>
      </nav>

      {sheet && <div className="scrim" onClick={() => setSheet(null)} />}
      {sheet === 'ask' && (
        <div ref={sheetRef} className="sheet" role="dialog" aria-modal="true" aria-labelledby="ask-sheet-title">
          <div className="sheet-grab" />
          <AskSheet page={pathname} onClose={() => setSheet(null)} />
        </div>
      )}
      {sheet === 'more' && (
        <div ref={sheetRef} className="sheet sheet-tall" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="sheet-grab" />
          <div className="row between"><h2 className="sheet-h">Everything on Streetkey</h2><div className="row" style={{ flexWrap: 'nowrap' }}><button className="icon-btn" aria-label="Close" onClick={() => setSheet(null)}><Icon name="x" /></button></div></div>
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
