/**
 * Shared report fixtures for the emit tests.
 *
 * These build REAL `RunReport` values against the contract in types.ts rather
 * than mocking the emitter's inputs — a fixture that drifts from the type is a
 * test that proves nothing.
 */

import { describe, expect, it } from 'vitest';
import type {
  ComponentResult,
  Finding,
  ProducerResult,
  RunReport,
  SnapshotResult,
  SnapState,
  Verdict,
} from '../types.js';

export function verdict(kind: Verdict['kind'], summary?: string): Verdict {
  return summary === undefined ? { kind, mode: 'exact' } : { kind, mode: 'exact', summary };
}

export function snap(
  file: string,
  state: SnapState,
  overrides: Partial<SnapshotResult> = {},
): SnapshotResult {
  const kind: Verdict['kind'] =
    state === 'verified-unchanged'
      ? 'identical'
      : state === 'changed'
        ? 'different'
        : state === 'added'
          ? 'added'
          : state === 'deleted'
            ? 'deleted'
            : state === 'not-selected'
              ? 'not-selected'
              : 'not-run';
  return {
    component: 'control',
    producer: 'domain',
    file,
    state,
    verdict: verdict(kind),
    baselineSha256: state === 'added' ? null : 'a'.repeat(64),
    receivedSha256: state === 'deleted' ? null : 'b'.repeat(64),
    receiptId: null,
    renderer: null,
    bytes: 128,
    ...overrides,
  };
}

export function producer(
  name: string,
  outcome: ProducerResult['outcome'],
  overrides: Partial<ProducerResult> = {},
): ProducerResult {
  return {
    component: 'control',
    producer: name,
    outcome,
    exitCode: outcome === 'ok' ? 0 : 1,
    signal: null,
    durationMs: 1200,
    stdoutPath: null,
    stderrPath: null,
    emitted: [],
    warnings: [],
    everCIVerified: true,
    ...overrides,
  };
}

export function component(overrides: Partial<ComponentResult> = {}): ComponentResult {
  return {
    component: 'control',
    state: 'verified-unchanged',
    producers: [producer('domain', 'ok')],
    snapshots: [],
    tests: null,
    coverage: null,
    findings: [],
    exercisedWitnessPaths: [],
    unclaimedPaths: [],
    ...overrides,
  };
}

export function finding(id: string, severity: Finding['severity'], overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    severity,
    title: `${id} title`,
    detail: `${id} detail`,
    ...overrides,
  };
}

export function makeReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    version: 1,
    baseRef: 'origin/main',
    baseSha: '1234567890abcdef1234567890abcdef12345678',
    headSha: 'fedcba0987654321fedcba0987654321fedcba09',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 4200,
    components: [component()],
    findings: [],
    fullyVerified: true,
    exitCode: 0,
    ...overrides,
  };
}

describe('fixtures', () => {
  it('build a report that matches the contract shape', () => {
    const r = makeReport({
      components: [component({ snapshots: [snap('a.txt', 'changed')] })],
    });
    expect(r.components[0]?.snapshots[0]?.state).toBe('changed');
    expect(r.version).toBe(1);
  });
});
