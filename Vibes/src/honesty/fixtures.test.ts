/**
 * Builders for the honesty layer's inputs.
 *
 * The honesty module is pure — every input is a value some other module already
 * computed — so its tests construct scenarios directly rather than mocking a
 * git port. That is the point: mocking a port would only test my belief about
 * the port, and the interesting failures here are joins between values, not
 * calls. The one place a real repo IS used is `receipts.test.ts`, because
 * reading a committed baseline is genuinely a git question.
 *
 * (Self-test at the bottom so vitest, pointed at `*.test.ts`, does not report
 * this file as a suite with no tests.)
 */

import { createHash } from 'node:crypto';

import { expect, test } from 'vitest';

import type { ChangedSourcePath } from '../git/index.js';
import type { Outcome, ReceiptEntry, SnapState, SnapshotResult, VerdictKind } from '../types.js';
import type { AttributionComponent, AttributionProducer, ComponentStatus } from './attribution.js';
import { verifyReceipts } from './receipts.js';
import type {
  BaselineFile,
  HonestyReceipt,
  OutDirSnapshot,
  ReceiptVerification,
} from './receipts.js';

export const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

/* ─────────────────────────── changed source ──────────────────────────── */

export function changed(
  path: string,
  over: Partial<ChangedSourcePath> = {},
): ChangedSourcePath {
  return {
    path,
    oldPath: null,
    status: 'modified',
    kind: 'file',
    similarity: null,
    isUntracked: false,
    isBinary: false,
    submodule: null,
    lines: null,
    cosmetic: false,
    ...over,
  };
}

/* ───────────────────────────── snapshots ─────────────────────────────── */

export function snap(
  file: string,
  state: SnapState,
  over: Partial<SnapshotResult> = {},
): SnapshotResult {
  const kind: VerdictKind =
    state === 'changed'
      ? 'different'
      : state === 'added'
        ? 'added'
        : state === 'deleted'
          ? 'deleted'
          : state === 'not-run'
            ? 'not-run'
            : state === 'not-selected'
              ? 'not-selected'
              : 'identical';
  return {
    component: 'c',
    producer: 'p',
    file,
    state,
    verdict: { kind, mode: 'exact' },
    baselineSha256: hash(`base:${file}`),
    receivedSha256: hash(`recv:${file}`),
    receiptId: null,
    renderer: null,
    bytes: 16,
    ...over,
  };
}

/* ───────────────────────────── producers ─────────────────────────────── */

export interface ProducerSpec {
  readonly name?: string;
  readonly outDir?: string;
  readonly outcome?: Outcome;
  readonly hasBaseline?: boolean;
  readonly everCIVerified?: boolean;
  readonly snapshots?: readonly SnapshotResult[];
}

export function producer(spec: ProducerSpec = {}): AttributionProducer {
  return {
    name: spec.name ?? 'p',
    outDir: spec.outDir ?? 'c/vibes/snapshots/p',
    outcome: spec.outcome ?? 'ok',
    hasBaseline: spec.hasBaseline ?? true,
    everCIVerified: spec.everCIVerified ?? true,
    ciJob: 'ci-gate',
    snapshots: spec.snapshots ?? [],
  };
}

export interface ComponentSpec {
  readonly id?: string;
  readonly root?: string;
  readonly status?: ComponentStatus;
  readonly witnesses?: readonly string[];
  readonly generates?: readonly string[];
  readonly submodules?: readonly string[];
  readonly producers?: readonly AttributionProducer[];
}

export function component(spec: ComponentSpec = {}): AttributionComponent {
  const root = spec.root ?? 'c';
  return {
    id: spec.id ?? 'c',
    root,
    status: spec.status ?? 'active',
    witnesses: spec.witnesses ?? [`${root}/src/**`],
    generates: spec.generates ?? [],
    submodules: spec.submodules ?? [],
    producers: spec.producers ?? [producer()],
  };
}

/* ───────────────────────────── receipts ─────────────────────────────── */

export function receiptOf(over: Partial<HonestyReceipt> = {}): HonestyReceipt {
  return {
    id: 'r0001',
    version: 1,
    component: 'c',
    producer: 'p',
    mode: 'reviewed',
    acceptedBy: 'someone',
    reason: 'reviewed the diff',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    entries: [],
    counts: { changed: 0, accepted: 0, skippedEquivalent: 0, acceptRatio: 0 },
    deletions: [],
    changedWitnessPaths: null,
    ...over,
  };
}

export function entryOf(name: string, content: string, over: Partial<ReceiptEntry> = {}): ReceiptEntry {
  return { file: name, sha256: hash(content), previousSha256: null, verdict: 'different', ...over };
}

export function baselineFile(name: string, content: string): BaselineFile {
  return { file: name, sha256: hash(content), bytes: Buffer.byteLength(content) };
}

export function outDirOf(over: Partial<OutDirSnapshot> = {}): OutDirSnapshot {
  return {
    outDir: 'c/vibes/snapshots/p',
    rev: 'HEAD',
    files: [],
    receipts: [],
    invalidReceipts: [],
    absent: false,
    ...over,
  };
}

/** One producer's verification, built from the two out-dir sides. */
export function verificationOf(
  current: Partial<OutDirSnapshot>,
  base: Partial<OutDirSnapshot> = {},
  where: { component?: string; producer?: string; outDir?: string } = {},
): ReceiptVerification {
  const outDir = where.outDir ?? 'c/vibes/snapshots/p';
  return verifyReceipts({
    component: where.component ?? 'c',
    producer: where.producer ?? 'p',
    outDir,
    current: outDirOf({ ...current, outDir }),
    base: outDirOf({ ...base, outDir }),
  });
}

test('fixture builders produce coherent values', () => {
  const c = component({ producers: [producer({ snapshots: [snap('a.txt', 'changed')] })] });
  expect(c.producers[0]?.snapshots[0]?.verdict.kind).toBe('different');
  expect(changed('c/src/x.ts').status).toBe('modified');
  const v = verificationOf({ files: [baselineFile('a.txt', 'two')] }, { files: [baselineFile('a.txt', 'one')] });
  expect(v.unreceipted).toHaveLength(1);
});
