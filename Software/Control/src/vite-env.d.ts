/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import type { MadLogHook } from './diagnostics/log';

declare global {
  /** Semver from Software/Control/package.json, injected by vite.config.ts. */
  const __APP_VERSION__: string;
  /** Short git SHA of the build, or `"unknown"` without git metadata. */
  const __GIT_SHA__: string;
  /**
   * Debug handle onto the session log, attached in dev (and in prod when the
   * user has opted in via the `mad:log` localStorage key) by `diagnostics/log`.
   *
   * Exists so the e2e harness can dump the full merged main+worker timeline
   * from a failed assertion:
   *   `page.evaluate(() => globalThis.__madLog?.snapshot())`
   *
   * Optional by design — never assume it is present in shipped code paths.
   */
  var __madLog: MadLogHook | undefined;
}
