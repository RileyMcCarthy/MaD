/**
 * App-level diagnostics wiring, installed once at startup.
 *
 * Three things that are invisible in a bug report unless captured deliberately:
 * what build the user is running, anything the app wrote to the console before
 * anyone thought to look, and whether the tab was in the background when the
 * device stream misbehaved (Chrome throttles hidden tabs, which perturbs a
 * ~100 Hz stream and reads exactly like a protocol fault if you can't see it).
 */

import { logger, type LogLevel } from './log';

const log = logger('app');

let installed = false;

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
}
