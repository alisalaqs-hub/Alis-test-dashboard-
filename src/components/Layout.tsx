import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Tag } from './ui';
import { BrixoWordmark } from './Brand';
import { useStore } from '../store';

const PRIMARY = [
  ['/search', 'Search'], ['/property/wal-001/intelligence', 'Intelligence'], ['/studio', 'Design Studio'],
  ['/estimate', 'Refurb Costs'], ['/invest', 'Invest'],
] as const;
const PRO = [
  ['/owner', 'Owner dashboard', 'How your listing is performing'],
  ['/agents', 'Agent Command Centre', 'Portfolio analytics & AI reports'],
  ['/landlord', 'Landlord management', 'Lettings, compliance, maintenance'],
  ['/developer', 'Developer intelligence', 'Demand, unit mix, appraisal'],
  ['/marketplace', 'Contractor marketplace', 'Standard scopes, benchmarked quotes'],
  ['/automation', 'AI agents', 'Automations, approvals, audit log'],
  ['/enterprise', 'API & Enterprise', 'White-label, keys, usage billing'],
] as const;

export default function Layout() {
  const { pathname } = useLocation();
  const { saved, compare } = useStore();
  const menu = useRef<HTMLDetailsElement>(null);
  const [theme, setTheme] = useState<string | null>(() => { try { return localStorage.getItem('brixo-theme'); } catch { return null; } });
  useEffect(() => { window.scrollTo(0, 0); if (menu.current) menu.current.open = false; }, [pathname]);
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    try { if (theme) localStorage.setItem('brixo-theme', theme); } catch { /* storage unavailable */ }
  }, [theme]);
  const dark = theme ? theme === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const proActive = PRO.some(([to]) => pathname.startsWith(to));
  return (
    <>
      <div className="demo-banner"><div><Tag kind="demo">Prototype</Tag><span>Listings, people, engagement and market figures are <b>simulated demonstration data</b>. Calculations are real; outputs are indicative, not advice.</span></div></div>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="logo" aria-label="BRIXO home"><BrixoWordmark /></NavLink>
          <div className="nav-wrap">
            <nav className="nav" aria-label="Primary">
              {PRIMARY.map(([to, label]) => (
                <NavLink key={to} to={to} className={() => (pathname.startsWith(to.split('/wal')[0]) && (to !== '/property/wal-001/intelligence' || pathname.includes('/intelligence')) ? 'active' : '')}>{label}</NavLink>
              ))}
              <NavLink to="/compare" className={({ isActive }) => (isActive ? 'active' : '')}>Compare{compare.length ? ` (${compare.length})` : ''}</NavLink>
              <NavLink to="/saved" className={({ isActive }) => (isActive ? 'active' : '')}>Saved{saved.length ? ` (${saved.length})` : ''}</NavLink>
            </nav>
            <details className="menu" ref={menu}>
              <summary style={proActive ? { background: 'var(--ink)', color: 'var(--paper)' } : undefined}>Professionals ▾</summary>
              <div className="panel">
                {PRO.map(([to, label, sub]) => <NavLink key={to} to={to}><b>{label}</b><span>{sub}</span></NavLink>)}
              </div>
            </details>
          </div>
          <button className="theme-btn" aria-label="Toggle colour theme" onClick={() => setTheme(dark ? 'light' : 'dark')}>{dark ? '☀' : '☾'}</button>
        </div>
      </header>
      <main><Outlet /></main>
      <footer className="site"><div>
        <span><b>BRIXO</b> — See Beyond the Property. Prototype v0.2 · Nov 2026</span>
        <span>Not regulated financial, tax, legal, planning, valuation or surveying advice. Verify with qualified professionals.</span>
      </div></footer>
    </>
  );
}
