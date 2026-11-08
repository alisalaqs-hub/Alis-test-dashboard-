import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import Search from './pages/Search';
import PropertyPage from './pages/Property';
import Estimator from './pages/Estimator';
import Investment from './pages/Investment';
import Studio from './pages/Studio';
import Landlord from './pages/Landlord';
import Marketplace from './pages/Marketplace';
import Agent from './pages/Agent';
import Developers from './pages/Developers';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="search" element={<Search />} />
        <Route path="property/:id" element={<PropertyPage />} />
        <Route path="estimate" element={<Estimator />} />
        <Route path="invest" element={<Investment />} />
        <Route path="studio" element={<Studio />} />
        <Route path="landlord" element={<Landlord />} />
        <Route path="marketplace" element={<Marketplace />} />
        <Route path="agents" element={<Agent />} />
        <Route path="developers" element={<Developers />} />
        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
  );
}
