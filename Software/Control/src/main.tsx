import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { setupPwa } from './pwa';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register the service worker with a deferred (prompt) update flow.
setupPwa();
