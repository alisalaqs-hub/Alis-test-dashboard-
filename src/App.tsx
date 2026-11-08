import { lazy, Suspense } from 'react';
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
        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
    </Suspense>
  );
}
