import { lazy, Suspense, type ComponentType } from 'react';
import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
const Home = lazy(() => import('./pages/Home'));
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

export default function App() {
  return (
    <Suspense fallback={<div className="muted small" style={{ padding: 40 }}>Loading…</div>}>
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="search" element={<Search />} />
        <Route path="property/:id" element={<PropertyDetails />} />
        <Route path="property/:id/intelligence" element={<PropertyPage />} />
        <Route path="compare" element={<Compare />} />
        <Route path="saved" element={<Saved />} />
        <Route path="my-home" element={<MyHome />} />
        <Route path="prices" element={<Prices />} />
        <Route path="list" element={<ListProperty />} />
        <Route path="import" element={<ImportListing />} />
        <Route path="sources" element={<Sources />} />
        <Route path="privacy" element={<Privacy />} />
        <Route path="terms" element={<Terms />} />
        <Route path="accessibility" element={<AccessibilityPage />} />
        <Route path="estimate" element={<Estimator />} />
        <Route path="invest" element={<Investment />} />
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
        <Route path="account/inbox/:id" element={<Thread />} />
        <Route path="account/searches" element={<Searches />} />
        <Route path="account/designs" element={<Designs />} />
        <Route path="account/privacy" element={<PrivacySettings />} />
        <Route path="account/agency" element={<Agency />} />
        <Route path="account/forgot" element={<Forgot />} />
        <Route path="account/reset" element={<Reset />} />
        <Route path="account/verify" element={<Verify />} />
        <Route path="admin" element={<Admin />} />
        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
    </Suspense>
  );
}
