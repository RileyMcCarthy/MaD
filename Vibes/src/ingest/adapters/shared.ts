/**
 * What every adapter takes and returns.
 *
 * Adapters are pure string → model functions: no filesystem, no clock, no
 * globbing. That is what makes them testable against real captured artifacts,
 * and it is why staleness (a filesystem fact) is decided by the caller and
 * merely stamped onto the summary here.
 */

import type { CoverageSummary, RepoPath, TestSummary } from '../../types.js';
import type { ParseNote, UnmappedCoveragePath } from '../model.js';

export type { ParseNote } from '../model.js';

export interface TestParseOptions {
  readonly repoRoot: string;
  /** Absolute component root — the anchor for relative paths in the artifact. */
  readonly rootAbs: string;
  /** Becomes `TestSummary.source`. */
  readonly sourceLabel: string;
  /** Stamped onto the summary; the caller decided it from the file's mtime. */
  readonly stale: boolean;
  /** When present, case `file` attributes are only kept if they are tracked. */
  readonly trackedPaths?: ReadonlySet<RepoPath> | undefined;
}

export interface TestParseResult {
  readonly summary: TestSummary;
  readonly notes: readonly ParseNote[];
}

export interface CoverageParseResult {
  readonly summary: CoverageSummary;
  readonly notes: readonly ParseNote[];
  readonly unmapped: readonly UnmappedCoveragePath[];
}

/** Adapters throw this when the bytes are not the format at all. */
export class AdapterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterParseError';
  }
}

/**
 * Long failure output is real signal, but a 4 MB stack trace in a report is
 * not. Cap and say so — silently truncating is how a report starts lying by
 * omission.
 */
export const MAX_MESSAGE_CHARS = 2000;

export function capMessage(s: string): string {
  const t = s.trim();
  if (t.length <= MAX_MESSAGE_CHARS) return t;
  return `${t.slice(0, MAX_MESSAGE_CHARS)}\n… [truncated ${t.length - MAX_MESSAGE_CHARS} chars]`;
}

/** Seconds (JUnit `time=`, pio durations) → ms. Non-numeric → null. */
export function secondsToMs(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  return n * 1000;
}
