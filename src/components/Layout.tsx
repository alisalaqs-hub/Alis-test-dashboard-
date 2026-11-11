import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { StreetkeyBow, StreetkeyWordmark } from './Brand';
import { Icon } from './Icons';
import { AskLauncher, AskSheet } from './ai/AskChat';
import { useStore } from '../store';
import { applyMeta, metaFor } from '../lib/meta';
import { useAi } from '../lib/ai/core';
import { useServer } from '../lib/server';

const PRIMARY = [
  ['/search', 'Search'], ['/list', 'List a property'], ['/prices', 'Sold prices'], ['/studio', 'Design'], ['/estimate', 'Costs'], ['/invest', 'Invest'], ['/my-home', 'My Home'],
] as const;
const MORE = [
  { title: 'Explore', items: [['/search', 'search', 'Search homes', 'Buy, rent, commercial'], ['/prices', 'pound', 'Sold prices', 'What things really sold for'], ['/import', 'spark', 'Check any listing', 'From any website, privately'], ['/compare', 'chart', 'Compare', 'Side-by-side intelligence'], ['/saved', 'heart', 'Saved', 'Homes, searches & designs']] },
  { title: 'Sell & let', items: [['/list', 'tag', 'List your property', 'Sell or let it yourself'], ['/account/listings', 'key', 'My listings & inbox', 'Manage listings, reply to buyers'], ['/owner', 'chart', 'Owner dashboard', 'How your listing performs']] },
  { title: 'Plan & improve', items: [['/my-home', 'home', 'My Home', 'Value, ideas & costs for your home'], ['/studio', 'palette', 'Design studio', 'Redesign a room, see the cost'], ['/estimate', 'tools', 'Refurb costs', 'Regional estimate & BoQ'], ['/invest', 'chart', 'Investment', 'Yields, BRRR, flips, HMOs']] },
  { title: 'For professionals', items: [['/sources', 'building', 'Listing feeds', 'Connect your CRM to Streetkey'], ['/agents', 'briefcase', 'Agent command centre', 'Portfolio analytics & AI'], ['/landlord', 'key', 'Landlords', 'Lettings & compliance'], ['/developer', 'crane', 'Developers', 'Demand & appraisals'], ['/marketplace', 'tools', 'Contractors', 'Scoped, benchmarked quotes'], ['/automation', 'spark', 'AI agents', 'Automations & approvals'], ['/enterprise', 'building', 'API & Enterprise', 'White-label & widgets']] },
] as const;

export default function Layout() {
  const { pathname } = useLocation();
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
            {PRIMARY.map(([to, label]) => <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>)}
          </nav>
          <div className="row" style={{ gap: 8, marginLeft: 'auto', flexWrap: 'nowrap' }}>
            <Link to="/saved" className="icon-btn desktop-only" aria-label={`Saved (${saved.length})`}><Icon name="heart" />{saved.length > 0 && <span className="dot-badge">{saved.length}</span>}</Link>
            {online && (user
              ? (() => { const ini = user.name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase(); return <Link to="/account" className="icon-btn acct-btn" aria-label={`${ini}: your account`} title={`${user.name}: your account`}>{ini}</Link>; })()
              : <Link to="/account" className="btn sm ghost signin-btn">Sign in</Link>)}
            <button type="button" className="icon-btn" aria-label="Menu" aria-haspopup="dialog" onClick={() => openSheet('more')}><Icon name="menu" /></button>
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} className={isHome ? 'home-main' : undefined}><Outlet /></main>

      <footer className="site"><div>
        <span className="row" style={{ gap: 10 }}><StreetkeyBow size={22} /> <span><b>Streetkey</b> — See Beyond the Property. {online ? 'Listings marked “Example” are illustrations, not homes for sale. Estimates are a guide, not advice.' : 'Listings shown are examples, not homes for sale. Estimates are a guide, not advice.'}</span></span>
        <nav aria-label="Legal"><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link><Link to="/accessibility">Accessibility</Link><Link to="/data-sources">Data sources</Link><Link to="/sources">Listing feeds</Link></nav>
      </div></footer>

      <nav className="tabbar" aria-label="App">
        <NavLink to="/" end className={({ isActive }) => (isActive || pathname.startsWith('/search') || pathname.startsWith('/property') ? 'on' : '')}><Icon name="search" /><span>Search</span></NavLink>
        <NavLink to="/saved" className={({ isActive }) => (isActive ? 'on' : '')}><span className="tab-ic"><Icon name="heart" />{saved.length > 0 && <span className="dot-badge">{saved.length}</span>}</span><span>Saved</span></NavLink>
        {/* Says "AI" only when AI can answer; without it the sheet is Streetkey's search. */}
        <button type="button" className="tab-ask" onClick={() => openSheet('ask')} aria-label={aiOn ? 'Ask Streetkey AI' : 'Ask Streetkey'} aria-haspopup="dialog"><span className="ask-bubble"><Icon name="spark" size={26} stroke={2.2} /></span><span>Ask</span></button>
        <NavLink to="/my-home" className={({ isActive }) => (isActive ? 'on' : '')}><Icon name="home" /><span>My Home</span></NavLink>
        <button type="button" data-more className={sheet === 'more' ? 'on' : ''} onClick={() => openSheet('more')} aria-haspopup="dialog"><Icon name="menu" /><span>More</span></button>
      </nav>

      {sheet && <div className="scrim" onClick={() => setSheet(null)} />}
      <AskLauncher onOpen={() => openSheet('ask')} />
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
