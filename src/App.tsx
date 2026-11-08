import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
const Home = lazy(() => import('./pages/Home'));
const Search = lazy(() => import('./pages/Search'));
const PropertyDetails = lazy(() => import('./pages/PropertyDetails'));
const PropertyPage = lazy(() => import('./pages/Property'));
const Compare = lazy(() => import('./pages/Compare'));
const Saved = lazy(() => import('./pages/Saved'));
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
