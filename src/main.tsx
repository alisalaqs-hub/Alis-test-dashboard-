import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import App from './App';
import { StoreProvider } from './store';
import { ServerProvider } from './lib/server';
import { PORTABLE } from './lib/meta';
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import './styles.css';

// Addresses used to look like /#/property/abc. Links people saved or were emailed still work:
// they are turned into the clean address before the page starts.
if (!PORTABLE && location.hash.startsWith('#/')) history.replaceState(null, '', location.hash.slice(1));
const Router = PORTABLE ? HashRouter : BrowserRouter;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <ServerProvider>
        <Router>
          <App />
        </Router>
      </ServerProvider>
    </StoreProvider>
  </StrictMode>,
);
