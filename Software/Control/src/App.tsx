import { lazy, Suspense, useEffect } from 'react';
import {
  HashRouter,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import CapabilityGate from './ui/CapabilityGate';
import ErrorBoundary from './ui/ErrorBoundary';
import { useStore, UiNotification } from './store/useStore';
import { NotificationType } from './domain';

/** Messages that browsers fire as global errors but are benign noise. */
const IGNORED_ERROR_PATTERNS = [/ResizeObserver loop/i];

/** Route uncaught async / event-handler errors (which error boundaries miss)
 *  to a throttled toast + the console, so a frozen promise rejection or a
 *  handler throw is visible instead of silent. */
function useGlobalErrorHandlers(): void {
  useEffect(() => {
    let lastMsg = '';
    let lastAt = 0;
    const report = (label: string, msg: string) => {
      if (IGNORED_ERROR_PATTERNS.some((re) => re.test(msg))) return;
      const now = Date.now();
      if (msg === lastMsg && now - lastAt < 3000) return; // throttle duplicates
      lastMsg = msg;
      lastAt = now;
       
      console.error(`[${label}]`, msg);
      useStore.getState().notify(NotificationType.ERROR, `Unexpected error: ${msg}`);
    };
    const onError = (e: ErrorEvent) => report('error', e.message || String(e.error));
    const onRejection = (e: PromiseRejectionEvent) =>
      report('unhandledrejection', e.reason instanceof Error ? e.reason.message : String(e.reason));
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
}

// Note: the UI deliberately does NOT guard tab-close/reload. The machine runs
// tests autonomously from its SD card and is protected by its own hardware
// e-stop + sensors, so losing the UI is a non-event — the test keeps running and
// the UI simply reconnects to monitor it. No beforeunload/pagehide interference.

// Connect is the landing route — keep it eager. The rest (incl. the uPlot-heavy
// Live/Viewer screens) are code-split so the initial bundle stays lean.
import Connect from './ui/screens/Connect';
const Live = lazy(() => import('./ui/screens/Live'));
const Profiles = lazy(() => import('./ui/screens/Profiles'));
const Create = lazy(() => import('./ui/screens/Create'));
const Runs = lazy(() => import('./ui/screens/Runs'));
const TestRunViewer = lazy(() => import('./ui/screens/TestRunViewer'));
const About = lazy(() => import('./ui/screens/About'));
const Firmware = lazy(() => import('./ui/screens/Firmware'));
const Settings = lazy(() => import('./ui/screens/Settings'));

function StatusBar() {
  const connection = useStore((s) => s.connection);
  const responding = useStore((s) => s.responding);
  const portLabel = useStore((s) => s.portLabel);
  const fw = useStore((s) => s.firmwareVersion);
  const canReconnect = useStore((s) => s.canReconnect);
  const reconnect = useStore((s) => s.reconnect);
  const emergencyStop = useStore((s) => s.emergencyStop);
  const updateReady = useStore((s) => s.updateReady);
  const applyUpdate = useStore((s) => s.applyUpdate);
  const label =
    connection === 'connected'
      ? `Connected · ${portLabel ?? 'device'}${fw ? ` · fw ${fw}` : ''}`
      : connection === 'connecting'
        ? 'Connecting…'
        : 'Disconnected';
  return (
    <div className="statusbar">
      <span className={`dot ${connection}`} />
      <span className="muted">{label}</span>
      {connection === 'connected' && (
        <span className={`badge ${responding ? 'downloaded' : 'error'}`} data-testid="responding">
          {responding ? 'Responding' : 'Not responding'}
        </span>
      )}
      {connection === 'disconnected' && canReconnect && (
        <button onClick={() => void reconnect()} data-testid="reconnect">
          Reconnect
        </button>
      )}
      {updateReady && (
        <button
          onClick={applyUpdate}
          title={
            connection === 'disconnected'
              ? 'Apply the downloaded update (reloads the app).'
              : 'Disconnect first — applying an update reloads the app.'
          }
          data-testid="apply-update"
        >
          Update ready
        </button>
      )}
      {connection === 'connected' && (
        <button
          className="estop"
          onClick={() => void emergencyStop()}
          title="Disable all machine motion immediately. Software control stop — not a safety-rated hardware E-stop."
          aria-label="Emergency stop: disable all motion"
          data-testid="estop"
        >
          ⏹ STOP
        </button>
      )}
    </div>
  );
}

/** Auto-dismissing toast. Errors/warnings linger longer so they stay readable;
 *  clicking dismisses immediately. */
function Toast({ n, onDismiss }: { n: UiNotification; onDismiss: () => void }) {
  useEffect(() => {
    const ms = n.Type === NotificationType.ERROR || n.Type === NotificationType.WARN ? 8000 : 4000;
    const t = setTimeout(onDismiss, ms);
    return () => clearTimeout(t);
  }, [n.id, n.Type, onDismiss]);
  return (
    <div
      className={`toast ${n.Type}`}
      onClick={onDismiss}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onDismiss();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Dismiss notification: ${n.Message}`}
    >
      {n.Message}
    </div>
  );
}

function Toasts() {
  const notifications = useStore((s) => s.notifications);
  const dismiss = useStore((s) => s.dismissNotification);
  return (
    <div className="toasts">
      {notifications.slice(-5).map((n) => (
        <Toast key={n.id} n={n} onDismiss={() => dismiss(n.id)} />
      ))}
    </div>
  );
}

function Shell() {
  const location = useLocation();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">MaD Control</div>
        <nav className="nav">
          <NavLink to="/connect">Connect</NavLink>
          <NavLink to="/live">Live</NavLink>
          <NavLink to="/profiles">Samples</NavLink>
          <NavLink to="/create">Motion Profiles</NavLink>
          <NavLink to="/runs">Test Runs</NavLink>
          <NavLink to="/firmware">Firmware</NavLink>
          <NavLink to="/about">About</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="sidebar-footer">Web Serial · WASM</div>
      </aside>
      <main className="main">
        <StatusBar />
        {/* Screen-level boundary: a crashed screen shows a recoverable panel but
            leaves the sidebar, status bar, and global STOP intact. Keyed by route
            so navigating away clears a stuck error. */}
        <ErrorBoundary key={location.pathname} title="This screen hit an error">
          <Suspense fallback={<div className="panel muted">Loading…</div>}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <Toasts />
    </div>
  );
}

export default function App() {
  const init = useStore((s) => s.init);
  useGlobalErrorHandlers();
  useEffect(() => {
    init();
  }, [init]);

  return (
    <ErrorBoundary full title="MaD Control crashed">
      <CapabilityGate>
        <HashRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Navigate to="/connect" replace />} />
            <Route path="/connect" element={<Connect />} />
            <Route path="/live" element={<Live />} />
            {/* Machine configuration now lives within Settings; keep the old
                path as a redirect for deep links / bookmarks. */}
            <Route path="/config" element={<Navigate to="/settings" replace />} />
            <Route path="/profiles" element={<Profiles />} />
            <Route path="/create" element={<Create />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/view/:testName" element={<TestRunViewer />} />
            <Route path="/firmware" element={<Firmware />} />
            <Route path="/about" element={<About />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
        </HashRouter>
      </CapabilityGate>
    </ErrorBoundary>
  );
}
