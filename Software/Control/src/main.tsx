import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { setupPwa } from './pwa';
import { installAppDiagnostics } from './diagnostics/boot';
import './styles.css';

// Before anything renders, so a crash during the first paint is still captured.
installAppDiagnostics();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register the service worker with a deferred (prompt) update flow.
setupPwa();
