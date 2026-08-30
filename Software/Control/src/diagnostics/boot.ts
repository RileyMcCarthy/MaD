/**
 * App-level diagnostics wiring, installed once at startup.
 *
 * Three things that are invisible in a bug report unless captured deliberately:
 * what build the user is running, anything the app wrote to the console before
 * anyone thought to look, and whether the tab was in the background when the
 * device stream misbehaved (Chrome throttles hidden tabs, which perturbs a
 * ~100 Hz stream and reads exactly like a protocol fault if you can't see it).
 */

import { logger, nowMs, type LogLevel } from './log';
import { startLogPersistence, type LogPersistence } from './persist';

const log = logger('app');

let installed = false;

/**
 * Identifies this page load, so a persisted log can be told apart from the one
 * that a reload destroyed. Derived from the boot time plus a random suffix —
 * `crypto.randomUUID` is not available on every target this app runs on.
 */
export const SESSION_ID = `s-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

let persistence: LogPersistence | null = null;

/** The live persistence handle, for the export path to flush before bundling. */
export function logPersistence(): LogPersistence | null {
  return persistence;
}

/** One line that identifies the environment a report came from. */
function logBootEnvironment(): void {
  const nav = navigator as Navigator & {
    hardwareConcurrency?: number;
    deviceMemory?: number;
  };
  log.info('boot', 'app started', {
    version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    gitSha: typeof __GIT_SHA__ === 'string' ? __GIT_SHA__ : 'unknown',
    mode: import.meta.env.MODE,
    sessionId: SESSION_ID,
    userAgent: navigator.userAgent,
    language: navigator.language,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemoryGb: nav.deviceMemory ?? null,
    // Capability gaps explain a whole class of "the button does nothing".
    webSerial: 'serial' in navigator,
    fileSystemAccess: 'showDirectoryPicker' in window,
    // An installed PWA and a tab behave differently around service workers.
    standalone: window.matchMedia('(display-mode: standalone)').matches,
    online: navigator.onLine,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  });
}

/**
 * Forward `console.error` / `console.warn` into the log, then call through.
 *
 * Third-party code and React itself report real problems this way (key
 * warnings, act() violations, uncaught render errors) and they would otherwise
 * never reach a report. The logger's console mirror binds the ORIGINAL methods
 * at module init, so this cannot feed itself.
 */
function interceptConsole(): void {
  const wrap = (level: Extract<LogLevel, 'warn' | 'error'>) => {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      try {
        const [first, ...rest] = args;
        log[level](
          'console',
          typeof first === 'string' ? first : String(first),
          rest.length > 0 ? { args: rest.length, detail: rest[0] } : undefined,
        );
      } catch {
        // Logging must never break the console it is wrapping.
      }
      original(...args);
    };
  };
  wrap('warn');
  wrap('error');
}

/** Tab visibility + connectivity, both of which perturb the device stream. */
function trackEnvironmentChanges(): void {
  document.addEventListener('visibilitychange', () => {
    log.info('visibility', document.visibilityState, {
      hidden: document.hidden,
    });
  });
  window.addEventListener('online', () => log.info('online'));
  window.addEventListener('offline', () => log.warn('offline'));
}

/** A main-thread stall longer than this is user-visible jank worth recording. */
const LONG_TASK_MS = 200;
/** How often to check heap growth. Slow: this is for leaks, not spikes. */
const HEAP_SAMPLE_MS = 30_000;
/** Report heap only when it moved by more than this since the last report. */
const HEAP_DELTA_MB = 25;

/**
 * Watch for main-thread stalls.
 *
 * The device worker keeps the ~100 Hz stream alive independently, so a frozen
 * UI and a broken device link are different faults with identical symptoms
 * ("it stopped updating"). Recording stalls is what separates them.
 *
 * `longtask` entries are the accurate source; the interval fallback covers
 * browsers where that entry type is unavailable, and also catches stalls that
 * block the observer's own delivery.
 */
function trackMainThreadHealth(): void {
  try {
    if (
      typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= LONG_TASK_MS) {
            log.warn('jank', 'main thread blocked', {
              durMs: Math.round(entry.duration),
              source: entry.name,
            });
          }
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    }
  } catch {
    // Entry type unsupported — the interval below still covers the worst cases.
  }

  // A timer that should fire every second but fires late by N ms means the main
  // thread was busy for N ms. Deliberately ignores hidden tabs, where the
  // browser throttles timers on purpose and a "stall" would be a false alarm.
  const TICK_MS = 1000;
  let expected = nowMs() + TICK_MS;
  setInterval(() => {
    const now = nowMs();
    const late = now - expected;
    expected = now + TICK_MS;
    if (late >= LONG_TASK_MS && !document.hidden) {
      log.warn('stall', 'timer ran late', { lateMs: Math.round(late) });
    }
  }, TICK_MS);
}

/**
 * Sample heap usage, reporting only meaningful movement.
 *
 * A session that climbs steadily over an hour is a leak; one that sits flat is
 * not. Chromium-only (`performance.memory`), which is the app's only target.
 */
function trackHeap(): void {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
  };
  if (perf.memory === undefined) return;
  const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));
  let lastReported = mb(perf.memory.usedJSHeapSize);
  log.info('heap', 'baseline', { usedMb: lastReported, limitMb: mb(perf.memory.jsHeapSizeLimit) });
  setInterval(() => {
    const used = mb(perf.memory?.usedJSHeapSize ?? 0);
    if (Math.abs(used - lastReported) < HEAP_DELTA_MB) return;
    const grew = used > lastReported;
    log.info('heap', grew ? 'grew' : 'released', { usedMb: used, deltaMb: used - lastReported });
    lastReported = used;
  }, HEAP_SAMPLE_MS);
}

/**
 * Install app-level capture. Idempotent — React StrictMode double-invokes
 * effects in dev, and double-wrapping the console would double every line.
 */
export function installAppDiagnostics(): void {
  if (installed) return;
  installed = true;
  interceptConsole();
  logBootEnvironment();
  trackEnvironmentChanges();
  trackMainThreadHealth();
  trackHeap();
  persistence = startLogPersistence(SESSION_ID);
}
