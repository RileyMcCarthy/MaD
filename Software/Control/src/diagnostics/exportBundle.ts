/**
 * Build + download a diagnostics bundle for triaging a field issue without a
 * backend.
 *
 * The bundle is the session log (merged main + worker), the worker's throughput
 * counters, and — when asked for — the raw serial tail. Sample values are not
 * included: they are high-volume and belong in the test CSV, not here.
 */

import { logSnapshot, type LogSnapshot } from './log';
import { summariseForTriage, type TriageSummary } from './triage';
import { logPersistence, SESSION_ID } from './boot';
import { readPreviousSession, type PersistedSession } from './persist';
import { deviceClient } from '@/device/session';
import { useStore } from '@/store/useStore';
import type { ByteRingSnapshot } from './byteRing';

export interface DiagnosticsBundle {
  /** Read this first — everything below is the evidence behind it. */
  triage: TriageSummary;
  sessionId: string;
  generatedAt: string;
  version: string;
  gitSha: string;
  userAgent: string;
  buildMode: string;
  capabilities: { webSerial: boolean; fileSystemAccess: boolean };
  device: {
    connection: string;
    responding: boolean;
    firmwareVersion: string | null;
    portLabel: string | null;
  };
  worker: unknown;
  log: LogSnapshot;
  /** Raw serial tail — omitted unless explicitly requested (see options). */
  serialTail?: ByteRingSnapshot;
  /**
   * The previous page load's log, when one was persisted.
   *
   * Present after a reload, which is exactly the case the in-memory ring cannot
   * cover: if the app froze and the user restarted it, the failure is in here
   * and not in `log`. A `closed: false` on it means that session never shut
   * down cleanly.
   */
  previousSession?: PersistedSession;
}

export interface BundleOptions {
  /**
   * Attach the previous session's persisted log. On by default: a report filed
   * after a reload is otherwise missing the very failure that caused it.
   */
  includePreviousSession?: boolean;
  /**
   * Include the raw RX/TX byte window. Opt-in: it is the most useful artifact
   * for a framing or CRC bug and also the most opaque, so the choice to attach
   * it should be deliberate rather than silent.
   */
  includeSerialTail?: boolean;
}

export async function buildDiagnosticsBundle(
  opts: BundleOptions = {},
): Promise<DiagnosticsBundle> {
  const s = useStore.getState();
  // Get everything buffered into IndexedDB before snapshotting, so a bundle and
  // the persisted copy cannot disagree.
  try {
    await logPersistence()?.flush();
  } catch {
    // Persistence is best-effort and must never block a report.
  }
  let worker: unknown = null;
  try {
    worker = await deviceClient.getDiagnostics();
  } catch {
    worker = { error: 'worker diagnostics unavailable' };
  }

  let serialTail: ByteRingSnapshot | undefined;
  if (opts.includeSerialTail) {
    try {
      serialTail = await deviceClient.getByteTail();
    } catch {
      // A dead or never-started worker has no tail; the rest of the bundle is
      // still worth producing.
      serialTail = undefined;
    }
  }

  let previousSession: PersistedSession | undefined;
  if (opts.includePreviousSession !== false) {
    try {
      previousSession = (await readPreviousSession(SESSION_ID)) ?? undefined;
    } catch {
      previousSession = undefined;
    }
  }

  const log = logSnapshot();
  return {
    triage: summariseForTriage(log),
    sessionId: SESSION_ID,
    generatedAt: new Date().toISOString(),
    version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    gitSha: typeof __GIT_SHA__ === 'string' ? __GIT_SHA__ : 'unknown',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    buildMode: import.meta.env.MODE,
    capabilities: {
      webSerial: typeof navigator !== 'undefined' && 'serial' in navigator,
      fileSystemAccess: typeof window !== 'undefined' && 'showDirectoryPicker' in window,
    },
    device: {
      connection: s.connection,
      responding: s.responding,
      firmwareVersion: s.firmwareVersion,
      portLabel: s.portLabel,
    },
    worker,
    log,
    ...(serialTail ? { serialTail } : {}),
    ...(previousSession ? { previousSession } : {}),
  };
}

export async function downloadDiagnostics(opts: BundleOptions = {}): Promise<void> {
  const bundle = await buildDiagnosticsBundle(opts);
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mad-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
