/**
 * Diagnostics flight recorder (main thread).
 *
 * A small ring buffer of *significant* device/app events — connects, disconnects,
 * protocol errors, timeouts, NACKs, and app-level errors. Deliberately NOT fed
 * the ~100 Hz sample stream (that would be noise). Combined with the worker's
 * byte/throughput counters, it gives a one-click, backend-free session log to
 * triage an intermittent field failure on real hardware.
 */

export type DiagLevel = 'info' | 'warn' | 'error';

export interface DiagEntry {
  /** epoch ms */
  t: number;
  level: DiagLevel;
  /** short category, e.g. 'connected', 'device-error', 'timeout', 'nack'. */
  tag: string;
  message: string;
}

/** Retained entries. Significant events only, so a small ring covers a long session. */
const CAPACITY = 1000;

const ring: DiagEntry[] = [];
let total = 0;
const counters: Record<string, number> = {};

export function record(level: DiagLevel, tag: string, message = ''): void {
  if (ring.length >= CAPACITY) ring.shift();
  ring.push({ t: Date.now(), level, tag, message });
  counters[tag] = (counters[tag] ?? 0) + 1;
  total += 1;
}

export interface DiagnosticsSnapshot {
  entries: DiagEntry[];
  counters: Record<string, number>;
  /** Total recorded since reset (may exceed entries.length once the ring wraps). */
  total: number;
}

export function diagnosticsSnapshot(): DiagnosticsSnapshot {
  return { entries: ring.slice(), counters: { ...counters }, total };
}

export function resetDiagnostics(): void {
  ring.length = 0;
  total = 0;
  for (const k of Object.keys(counters)) delete counters[k];
}
