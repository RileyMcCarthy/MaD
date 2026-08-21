/**
 * Build + download a redaction-safe diagnostics bundle (no sample data, no file
 * contents) for triaging field issues without a backend.
 */

import { diagnosticsSnapshot } from './recorder';
import { deviceClient } from '@/device/session';
import { useStore } from '@/store/useStore';

export interface DiagnosticsBundle {
  generatedAt: string;
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
  log: ReturnType<typeof diagnosticsSnapshot>;
}

export async function buildDiagnosticsBundle(): Promise<DiagnosticsBundle> {
  const s = useStore.getState();
  let worker: unknown = null;
  try {
    worker = await deviceClient.getDiagnostics();
  } catch {
    worker = { error: 'worker diagnostics unavailable' };
  }
  return {
    generatedAt: new Date().toISOString(),
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
    log: diagnosticsSnapshot(),
  };
}

export async function downloadDiagnostics(): Promise<void> {
  const bundle = await buildDiagnosticsBundle();
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
