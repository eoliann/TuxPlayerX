import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import './styles/globals.css';

/**
 * The Android build (TAURI_ENV_PLATFORM is set by the Tauri CLI) loads the phone / tablet / TV interface;
 * every other build loads the desktop one. `?mobile` previews the mobile interface in a desktop browser.
 * Each interface is a separate chunk, so neither app downloads the other's code.
 */
const isMobile = import.meta.env.TAURI_ENV_PLATFORM === 'android' || new URLSearchParams(window.location.search).has('mobile');
const App = isMobile ? lazy(() => import('./mobile/MobileApp')) : lazy(() => import('./desktop/App'));

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <App />
    </Suspense>
  </React.StrictMode>,
);
