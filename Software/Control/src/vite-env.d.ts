/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import type { MadLogHook } from './diagnostics/log';

declare global {
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
