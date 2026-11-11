import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from 'react';
import { Link, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router-dom';
import Layout from './components/Layout';
import { getProperty, publicListings, type Property } from './data/properties';
import { dedupe } from './engine/listings';
import { clearAiClick, ensureAnnouncer, watchActivation } from './lib/ai/core';
import { isServerRef } from './lib/listingAdapter';
import { useServer } from './lib/server';
import { useStore } from './store';
const Home = lazy(() => import('./pages/Home'));
const NotFound = lazy(() => import('./pages/NotFound'));
const Search = lazy(() => import('./pages/Search'));
const PropertyDetails = lazy(() => import('./pages/PropertyDetails'));
const PropertyPage = lazy(() => import('./pages/Property'));
const Compare = lazy(() => import('./pages/Compare'));
const Saved = lazy(() => import('./pages/Saved'));
const MyHome = lazy(() => import('./pages/MyHome'));
const Prices = lazy(() => import('./pages/Prices'));
const ListProperty = lazy(() => import('./pages/ListProperty'));
const ImportListing = lazy(() => import('./pages/ImportListing'));
const Sources = lazy(() => import('./pages/Sources'));
const Privacy = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Privacy })));
const Terms = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Terms })));
const AccessibilityPage = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Accessibility })));
const DataSources = lazy(() => import('./pages/Legal').then((m) => ({ default: m.DataSources })));
const Estimator = lazy(() => import('./pages/Estimator'));
const Investment = lazy(() => import('./pages/Investment'));
const Studio = lazy(() => import('./pages/Studio'));
const Owner = lazy(() => import('./pages/Owner'));
const Landlord = lazy(() => import('./pages/Landlord'));
const Developer = lazy(() => import('./pages/Developer'));
const Marketplace = lazy(() => import('./pages/Marketplace'));
const Agent = lazy(() => import('./pages/Agent'));
const Automation = lazy(() => import('./pages/Automation'));
const Enterprise = lazy(() => import('./pages/Developers'));
const acct = (name: string) => lazy(() => import('./pages/Account').then((m) => ({ default: (m as unknown as Record<string, ComponentType>)[name] })));
const AccountHome = acct('AccountHome');
const MyListings = acct('MyListings');
const Inbox = acct('Inbox');
const Thread = acct('Thread');
const Searches = acct('Searches');
const Designs = acct('Designs');
const PrivacySettings = acct('PrivacySettings');
const Agency = acct('Agency');
const Forgot = acct('Forgot');
const Reset = acct('Reset');
const Verify = acct('Verify');
const Admin = lazy(() => import('./pages/Admin'));

/* ───────── Pages that read the address once, when they mount ─────────
 * These pages set up their form from URL parameters in a useState initialiser. Navigating to the same
 * route with different parameters (header links, Back/Forward, links from Ask Streetkey) keeps the page
 * mounted, so without a key it would keep showing the previous record's figures or draft. */

/** /list?edit=<ref> and /list are different forms: switching starts afresh (no fields, photos or ticked declarations carried over). */
function ListRoute() {
  const [params] = useSearchParams();
  return <ListProperty key={params.get('edit') ?? 'new'} />;
}

/** Each conversation mounts fresh, so no reply draft or AI suggestion carries over to another enquirer's thread. */
function ThreadRoute() {
  const { id = '' } = useParams();
  return <Thread key={id} />;
}

/** What a property page started from: the listing's own figures, or example figures (and why). */
type PropertyStart = {
  ref: string;
  from: 'none' | 'listing' | 'missing' | 'merged';
  /** 'merged': the listing Streetkey shows for the same home instead, if there is one. */
  instead?: { id: string; title: string };
  /** Bumped when the person asks to start again from the listing's details. */
  gen: number;
};

/**
 * The listing Streetkey shows instead of `p` when both advertise the same home: the shared registry
 * merges duplicates (see dedupe), so `p` loads but can't be looked up by its own reference.
 */
function shownInstead(p: Property): { id: string; title: string } | undefined {
  const { duplicates } = dedupe([...publicListings().filter((x) => x.id !== p.id).map((x) => ({ ...x })), { ...p }]);
  const kept = duplicates.find((d) => d.dropped === p.id)?.kept;
  const other = kept && kept !== p.id ? getProperty(kept) : undefined;
  return other ? { id: other.id, title: other.title } : undefined;
}

/**
 * /estimate and /invest prefill from ?property=. A live listing that isn't loaded yet (a shared link, a
 * refresh) is fetched first, so the page starts from its figures rather than the example ones; if it
 * can't be used, the page says so. The page starts afresh whenever the property (or an imported
 * refurbishment cost) changes, so its figures always belong to the property named in its header.
 * Once the page has started for a property it is never swapped out underneath the person (for example
 * when the site's list of listings refreshes): if the listing's details turn up later, they're offered.
 */
function PropertyRoute({ page: Page, keyParams = [] }: { page: ComponentType; keyParams?: string[] }) {
  useStore(); // re-render when listings arrive in the shared registry
  const [params] = useSearchParams();
  const { status, online, loadListing } = useServer();
  const ref = params.get('property') ?? '';
  const known = !!ref && !!getProperty(ref);
  const [loaded, setLoaded] = useState<{ ref: string; p: Property | null } | null>(null);
  const [start, setStart] = useState<PropertyStart | null>(null);
  const reFocus = useRef(false);
  let s = start?.ref === ref ? start : null;
  const result = loaded?.ref === ref ? loaded : null;
  const fetching = !s && !known && !result && online && isServerRef(ref);

  useEffect(() => {
    if (!fetching) return;
    let live = true;
    void loadListing(ref).then((p) => { if (live) setLoaded({ ref, p }); }, () => { if (live) setLoaded({ ref, p: null }); });
    return () => { live = false; };
  }, [fetching, ref, loadListing]);

  // Decide once per property what the page starts from (React re-renders straight away with it).
  if (!s) {
    const from: PropertyStart['from'] | null = !ref ? 'none'
      : known ? 'listing'
      : !isServerRef(ref) || status === 'offline' || (result && !result.p) ? 'missing'
      : result?.p ? 'merged'
      : null; // still loading
    if (from) {
      s = { ref, from, gen: 0, instead: from === 'merged' && result?.p ? shownInstead(result.p) : undefined };
      setStart(s);
    }
  }

  // After "Start from them", focus goes to the page's heading rather than being lost with the note.
  const gen = s?.gen ?? 0;
  useEffect(() => {
    if (!reFocus.current) return;
    reFocus.current = false;
    const h = document.querySelector<HTMLElement>('#main h1, #main h2') ?? document.getElementById('main');
    if (h) { if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1'); h.focus(); }
  }, [gen]);

  if (!s) return <div className="muted small" role="status" style={{ padding: '24px 0' }}>Loading the listing’s details…</div>;

  const current = s;
  const startFromListing = () => { reFocus.current = true; setStart({ ref, from: 'listing', gen: current.gen + 1 }); };
  const withProperty = (id: string) => { const next = new URLSearchParams(params); next.set('property', id); return `?${next.toString()}`; };
  const late = current.from !== 'listing' && current.from !== 'none' && known;
  const key = [ref, current.gen, ...keyParams.map((k) => params.get(k) ?? '')].join('|');
  return (
    <>
      {(current.from === 'missing' || current.from === 'merged') && (
        <p className="callout info small" role="status" style={{ margin: '0 0 14px' }}>
          {current.from === 'missing' ? 'We couldn’t load that listing, so these are example figures. Enter your own below.'
            : current.instead ? <>Streetkey shows this home under another listing, so these are example figures. <Link to={withProperty(current.instead.id)}>Start from {current.instead.title}</Link> instead, or enter your own figures below.</>
            : 'We couldn’t use that listing’s details here, so these are example figures. Enter your own below.'}
          {late && <> The listing’s details have now loaded: <button type="button" className="linkish" onClick={startFromListing}>start from them</button>.</>}
        </p>
      )}
      <Page key={key} />
    </>
  );
}

/** App-wide: screen-reader live regions exist from the start, and focus is never moved for an AI action begun on another page. */
function useAppWideAi() {
  const { pathname } = useLocation();
  useEffect(() => { ensureAnnouncer(); watchActivation(); }, []);
  useEffect(() => { clearAiClick(); }, [pathname]);
}

export default function App() {
  useAppWideAi();
  return (
    <Suspense fallback={<div className="muted small" style={{ padding: 40 }}>Loading…</div>}>
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="search" element={<Search />} />
        {/* Place pages with their own address, for search engines and sharing: /for-sale/leeds, /to-rent/e17, /sold-prices/st-albans */}
        <Route path="for-sale/:place" element={<Search />} />
        <Route path="to-rent/:place" element={<Search />} />
        <Route path="property/:id" element={<PropertyDetails />} />
        <Route path="property/:id/intelligence" element={<PropertyPage />} />
        <Route path="compare" element={<Compare />} />
        <Route path="saved" element={<Saved />} />
        <Route path="my-home" element={<MyHome />} />
        <Route path="prices" element={<Prices />} />
        <Route path="sold-prices/:place" element={<Prices />} />
        <Route path="list" element={<ListRoute />} />
        <Route path="import" element={<ImportListing />} />
        <Route path="sources" element={<Sources />} />
        <Route path="privacy" element={<Privacy />} />
        <Route path="terms" element={<Terms />} />
        <Route path="accessibility" element={<AccessibilityPage />} />
        <Route path="data-sources" element={<DataSources />} />
        <Route path="estimate" element={<PropertyRoute page={Estimator} />} />
        {/* An imported refurbishment figure (its amount, where it came from and the design it's for) is read once, so a new one starts afresh. */}
        <Route path="invest" element={<PropertyRoute page={Investment} keyParams={['refurb', 'from', 'label']} />} />
        <Route path="studio" element={<Studio />} />
        <Route path="owner" element={<Owner />} />
        <Route path="agents" element={<Agent />} />
        <Route path="landlord" element={<Landlord />} />
        <Route path="developer" element={<Developer />} />
        <Route path="marketplace" element={<Marketplace />} />
        <Route path="automation" element={<Automation />} />
        <Route path="enterprise" element={<Enterprise />} />
        <Route path="developers" element={<Enterprise />} />
        <Route path="account" element={<AccountHome />} />
        <Route path="account/listings" element={<MyListings />} />
        <Route path="account/inbox" element={<Inbox />} />
        <Route path="account/inbox/:id" element={<ThreadRoute />} />
        <Route path="account/searches" element={<Searches />} />
        <Route path="account/designs" element={<Designs />} />
        <Route path="account/privacy" element={<PrivacySettings />} />
        <Route path="account/agency" element={<Agency />} />
        <Route path="account/forgot" element={<Forgot />} />
        <Route path="account/reset" element={<Reset />} />
        <Route path="account/verify" element={<Verify />} />
        <Route path="admin" element={<Admin />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
    </Suspense>
  );
}
