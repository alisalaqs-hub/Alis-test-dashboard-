import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Tag } from './ui';

const NAV = [
  ['/', 'Ask Plinth'], ['/search', 'Discover'], ['/property/wal-001', 'Intelligence'], ['/estimate', 'Refurb estimator'],
  ['/invest', 'Investment'], ['/studio', 'Design studio'], ['/landlord', 'Landlords'], ['/marketplace', 'Contractors'],
  ['/agents', 'Agents'], ['/developers', 'API & white-label'],
] as const;

export function Logo() {
  return (
    <svg className="logo-mark" viewBox="0 0 24 24" aria-hidden>
      <rect x="2" y="17" width="20" height="5" rx="1" fill="var(--ink)" />
      <rect x="5" y="11" width="14" height="5" rx="1" fill="var(--accent)" />
      <rect x="8" y="5" width="8" height="5" rx="1" fill="var(--ink)" opacity="0.55" />
    </svg>
  );
}

export default function Layout() {
  const { pathname } = useLocation();
  const [theme, setTheme] = useState<string | null>(() => { try { return localStorage.getItem('plinth-theme'); } catch { return null; } });
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    try { if (theme) localStorage.setItem('plinth-theme', theme); } catch { /* storage unavailable */ }
  }, [theme]);
  const dark = theme ? theme === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return (
    <>
      <div className="demo-banner"><div><Tag kind="demo">Prototype</Tag><span>All listings, people and market figures are <b>fictional demonstration data</b>. Calculations are real; outputs are indicative, not advice.</span></div></div>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="logo"><Logo /><span>plinth<span className="dot">.</span></span></NavLink>
          <nav className="nav" aria-label="Primary">
            {NAV.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive || (to.startsWith('/property') && pathname.startsWith('/property')) ? 'active' : '')}>{label}</NavLink>
            ))}
          </nav>
          <button className="theme-btn" aria-label="Toggle colour theme" onClick={() => setTheme(dark ? 'light' : 'dark')}>{dark ? '☀' : '☾'}</button>
        </div>
      </header>
      <main><Outlet /></main>
      <footer className="site"><div>
        <span>plinth. — the intelligence layer beneath every property decision. Prototype v0.1 · Nov 2026</span>
        <span>Not regulated financial, tax, legal, planning or surveying advice. Estimates must be verified by qualified professionals.</span>
      </div></footer>
    </>
  );
}
