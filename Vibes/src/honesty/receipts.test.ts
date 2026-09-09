import { afterEach, describe, expect, test } from 'vitest';

import { makeFixture, type Fixture } from '../git/fixtures.test.js';
import { openRepo } from '../git/index.js';
import type { Receipt, ReceiptEntry } from '../types.js';
import {
  ACCEPT_RATIO_THRESHOLD,
  RECEIPT_LOG_SCHEMA,
  acceptSignals,
  acceptWithoutSourceChange,
  collectOutDir,
  isBookkeepingFile,
  parseReceipt,
  parseReceiptDocument,
  ratioOf,
  sha256,
  verifyProducer,
  verifyReceipts,
  type BaselineFile,
  type HonestyReceipt,
  type OutDirSnapshot,
} from './receipts.js';

const live: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const f = await makeFixture();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((f) => f.cleanup()));
});

const hash = (s: string): string => sha256(Buffer.from(s, 'utf8'));

const file = (name: string, content: string): BaselineFile => ({
  file: name,
  sha256: hash(content),
  bytes: Buffer.byteLength(content),
});

function receipt(over: Partial<HonestyReceipt> = {}): HonestyReceipt {
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

function entry(name: string, content: string, over: Partial<ReceiptEntry> = {}): ReceiptEntry {
  return { file: name, sha256: hash(content), previousSha256: null, verdict: 'different', ...over };
}

function outDir(over: Partial<OutDirSnapshot> = {}): OutDirSnapshot {
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

const verify = (current: OutDirSnapshot, base: OutDirSnapshot) =>
  verifyReceipts({ component: 'c', producer: 'p', outDir: 'c/vibes/snapshots/p', current, base });

/* ═════════════════════ the three outcomes, exactly three ══════════════ */

describe('verifyReceipts — the guardrail', () => {
  test('content identical to base is unchanged and needs no receipt', () => {
    const v = verify(outDir({ files: [file('a.txt', 'one')] }), outDir({ files: [file('a.txt', 'one')] }));
    expect(v.files[0]?.verdict).toBe('unchanged');
    expect(v.unreceipted).toEqual([]);
  });

  test('content matching a receipt entry is accepted, and the receipt says how', () => {
    const v = verify(
      outDir({
        files: [file('a.txt', 'two')],
        receipts: [
          receipt({
            id: 'rABC',
            mode: 'bulk',
            reason: 'regenerated after the codec change',
            entries: [entry('a.txt', 'two', { previousSha256: hash('one') })],
          }),
        ],
      }),
      outDir({ files: [file('a.txt', 'one')] }),
    );
    expect(v.files[0]).toMatchObject({
      verdict: 'accepted',
      receiptId: 'rABC',
      receiptMode: 'bulk',
      chainedToBase: true,
    });
    expect(v.counts.accepted).toBe(1);
  });

  test('content matching NEITHER is unreceipted — this is what `git add -A` looks like', () => {
    const v = verify(outDir({ files: [file('a.txt', 'hand-edited')] }), outDir({ files: [file('a.txt', 'one')] }));
    expect(v.unreceipted).toHaveLength(1);
    expect(v.unreceipted[0]?.repoPath).toBe('c/vibes/snapshots/p/a.txt');
    expect(v.unreceipted[0]?.note).toMatch(/no receipt vouches for it/);
  });

  test('a receipt for the WRONG sha does not vouch — the digest is the whole mechanism', () => {
    const v = verify(
      outDir({
        files: [file('a.txt', 'actual')],
        receipts: [receipt({ entries: [entry('a.txt', 'what the receipt claims')] })],
      }),
      outDir({ files: [file('a.txt', 'one')] }),
    );
    expect(v.unreceipted).toHaveLength(1);
  });

  test('a brand-new committed baseline file still needs a receipt', () => {
    const v = verify(outDir({ files: [file('new.txt', 'x')] }), outDir({ files: [] }));
    // bootstrap is separately true; the file is still unvouched-for.
    expect(v.bootstrap).toBe(true);
    expect(v.unreceipted[0]?.note).toMatch(/new committed baseline file/);
  });

  test('receipts UNION across the log — an older receipt keeps vouching', () => {
    // A branch with two accepting commits: the first batch's bytes still differ
    // from base and only the first receipt names them. Dropping it would
    // manufacture an error out of a correct history.
    const v = verify(
      outDir({
        files: [file('a.txt', 'v2'), file('b.txt', 'v2')],
        receipts: [
          receipt({ id: 'r1', entries: [entry('a.txt', 'v2')] }),
          receipt({ id: 'r2', entries: [entry('b.txt', 'v2')] }),
        ],
      }),
      outDir({ files: [file('a.txt', 'v1'), file('b.txt', 'v1')] }),
    );
    expect(v.unreceipted).toEqual([]);
    expect(v.counts.accepted).toBe(2);
  });

  test('chainedToBase is false when the receipt does not descend from base content', () => {
    const v = verify(
      outDir({
        files: [file('a.txt', 'v3')],
        receipts: [receipt({ entries: [entry('a.txt', 'v3', { previousSha256: hash('somewhere else') })] })],
      }),
      outDir({ files: [file('a.txt', 'v1')] }),
    );
    expect(v.files[0]?.verdict).toBe('accepted');
    expect(v.files[0]?.chainedToBase).toBe(false);
  });
});

describe('deletions and orphans', () => {
  test('a baseline file removed with no receipt is an unreceipted deletion', () => {
    const v = verify(outDir({ files: [] }), outDir({ files: [file('gone.txt', 'x')] }));
    expect(v.unreceiptedDeletions).toHaveLength(1);
    expect(v.unreceiptedDeletions[0]?.repoPath).toBe('c/vibes/snapshots/p/gone.txt');
  });

  test("a deletion recorded in the receipt's `deletions` array is receipted", () => {
    // `accept` stores deletions separately because a deleted file has no
    // content to hash. Missing this index reports every receipted removal as a
    // corpus shrink, which is the false positive that gets a check disabled.
    const v = verify(
      outDir({ files: [], receipts: [receipt({ id: 'rDEL', deletions: [{ file: 'gone.txt', previousSha256: hash('x') }] })] }),
      outDir({ files: [file('gone.txt', 'x')] }),
    );
    expect(v.unreceiptedDeletions).toEqual([]);
    expect(v.deletions[0]?.receiptId).toBe('rDEL');
  });

  test('a legacy `verdict: deleted` entry also counts as a receipted deletion', () => {
    const v = verify(
      outDir({
        files: [],
        receipts: [receipt({ id: 'rOLD', entries: [{ file: 'gone.txt', sha256: '', previousSha256: null, verdict: 'deleted' }] })],
      }),
      outDir({ files: [file('gone.txt', 'x')] }),
    );
    expect(v.unreceiptedDeletions).toEqual([]);
  });

  test('a receipt naming a file that no longer exists is an orphan', () => {
    const v = verify(
      outDir({ files: [], receipts: [receipt({ id: 'rX', entries: [entry('vanished.txt', 'x')] })] }),
      outDir({ files: [] }),
    );
    expect(v.orphanEntries).toEqual([
      { receiptId: 'rX', file: 'vanished.txt', repoPath: 'c/vibes/snapshots/p/vanished.txt' },
    ]);
  });

  test('a receipted deletion is not ALSO reported as an orphan', () => {
    const v = verify(
      outDir({
        files: [],
        receipts: [
          receipt({ id: 'rY', entries: [entry('gone.txt', 'x')], deletions: [{ file: 'gone.txt', previousSha256: null }] }),
        ],
      }),
      outDir({ files: [file('gone.txt', 'x')] }),
    );
    expect(v.orphanEntries).toEqual([]);
  });

  test('newReceipts are only those absent at base — an old decision is not re-raised', () => {
    const old = receipt({ id: 'rOLD' });
    const fresh = receipt({ id: 'rNEW' });
    const v = verify(outDir({ receipts: [old, fresh] }), outDir({ receipts: [old] }));
    expect(v.newReceipts.map((r) => r.id)).toEqual(['rNEW']);
  });
});

/* ════════════════════════════ parsing ═════════════════════════════════ */

describe('parseReceiptDocument', () => {
  const one = {
    id: 'r1',
    version: 1,
    component: 'c',
    producer: 'p',
    mode: 'bulk',
    acceptedBy: '--all',
    reason: 'regenerated',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    entries: [{ file: 'a.txt', sha256: hash('x'), previousSha256: null, verdict: 'different' }],
    counts: { changed: 4, accepted: 4, skippedEquivalent: 0, acceptRatio: 1 },
  };

  test('reads the log wrapper `accept` actually writes', () => {
    const text = JSON.stringify({ schema: RECEIPT_LOG_SCHEMA, component: 'c', producer: 'p', receipts: [one] });
    const r = parseReceiptDocument(text);
    expect(r.error).toBeNull();
    expect(r.receipts.map((x) => x.id)).toEqual(['r1']);
  });

  test('reads a bare receipt object too — a hand-repaired file must not force a delete', () => {
    const r = parseReceiptDocument(JSON.stringify(one));
    expect(r.error).toBeNull();
    expect(r.receipts).toHaveLength(1);
  });

  test('carries `deletions` and `sourceContext` through', () => {
    const text = JSON.stringify({
      schema: RECEIPT_LOG_SCHEMA,
      component: 'c',
      producer: 'p',
      receipts: [
        { ...one, deletions: [{ file: 'gone.txt', previousSha256: hash('y') }], sourceContext: { changedWitnessPaths: ['c/src/a.ts'] } },
      ],
    });
    const r = parseReceiptDocument(text);
    expect(r.receipts[0]?.deletions).toEqual([{ file: 'gone.txt', previousSha256: hash('y') }]);
    expect(r.receipts[0]?.changedWitnessPaths).toEqual(['c/src/a.ts']);
  });

  test('a malformed document yields ZERO receipts and an error, never a quiet empty read', () => {
    // Corrupting the file must not become the cheapest way to erase the trail.
    expect(parseReceiptDocument('{ not json').error).toMatch(/not valid JSON/);
    expect(parseReceiptDocument('[]').error).toMatch(/not a JSON object/);
    expect(parseReceiptDocument(JSON.stringify({ schema: 'other/9', receipts: [] })).error).toMatch(/unexpected receipt schema/);
    expect(parseReceiptDocument(JSON.stringify({ schema: RECEIPT_LOG_SCHEMA })).error).toMatch(/missing `receipts`/);
  });

  test('one bad receipt in the log invalidates the document rather than half-vouching', () => {
    const text = JSON.stringify({
      schema: RECEIPT_LOG_SCHEMA,
      component: 'c',
      producer: 'p',
      receipts: [one, { ...one, id: 'r2', entries: [{ file: 'b.txt', sha256: 'nothex', verdict: 'different' }] }],
    });
    const r = parseReceiptDocument(text);
    expect(r.receipts).toEqual([]);
    expect(r.error).toMatch(/receipts\[1\].*sha256/);
  });

  test('a non-reviewed accept with no reason is rejected', () => {
    expect(parseReceipt(JSON.stringify({ ...one, reason: '   ' })).error).toMatch(/requires a non-empty `reason`/);
  });

  test('an unknown verdict is rejected', () => {
    expect(parseReceipt(JSON.stringify({ ...one, entries: [{ file: 'a', sha256: hash('x'), verdict: 'fine' }] })).error).toMatch(
      /verdict is missing or unknown/,
    );
  });

  test('a deleted entry may omit its digest; every other verdict may not', () => {
    expect(parseReceipt(JSON.stringify({ ...one, entries: [{ file: 'a', verdict: 'deleted' }] })).error).toBeNull();
    expect(parseReceipt(JSON.stringify({ ...one, entries: [{ file: 'a', verdict: 'different' }] })).error).toMatch(/64-hex/);
  });
});

describe('isBookkeepingFile', () => {
  test('only top-level Vibes bookkeeping counts', () => {
    expect(isBookkeepingFile('.vibes-accept.json')).toBe(true);
    expect(isBookkeepingFile('.vibes-accept.abc123.json')).toBe(true);
    expect(isBookkeepingFile('_vibes-census.json')).toBe(true);
    expect(isBookkeepingFile('nested/.vibes-accept.json')).toBe(false);
    expect(isBookkeepingFile('snapshot.txt')).toBe(false);
  });
});

/* ════════════════════ the accept counter-signals ══════════════════════ */

describe('accept signals', () => {
  const bulk = receipt({
    id: 'rB',
    mode: 'bulk',
    acceptedBy: '--all',
    reason: 'make it green',
    entries: [entry('a.txt', 'x')],
    counts: { changed: 40, accepted: 40, skippedEquivalent: 0, acceptRatio: 1 },
  });

  test('acceptRatio is recomputed from the counts, never trusted', () => {
    // The stated ratio is a number written by the process being watched.
    const lying = receipt({ counts: { changed: 10, accepted: 9, skippedEquivalent: 0, acceptRatio: 0.01 } });
    expect(ratioOf(lying)).toBeCloseTo(0.9);
  });

  test('signals come only from receipts written in this branch', () => {
    const v = verify(outDir({ receipts: [bulk] }), outDir({ receipts: [bulk] }));
    expect(acceptSignals(v)).toEqual([]);
  });

  test('a bulk accept is detected by mode and by the acceptedBy sentinel', () => {
    const v = verify(outDir({ receipts: [bulk] }), outDir());
    expect(acceptSignals(v)[0]?.bulk).toBe(true);
    const byFlag = receipt({ id: 'rF', mode: 'reviewed', acceptedBy: '--yes', reason: 'r' });
    expect(acceptSignals(verify(outDir({ receipts: [byFlag] }), outDir()))[0]?.bulk).toBe(true);
  });

  test('accept-without-source-change fires above the ratio when no claimed source changed', () => {
    const signals = acceptSignals(verify(outDir({ receipts: [bulk] }), outDir()));
    expect(acceptWithoutSourceChange(signals, 0)).toHaveLength(1);
  });

  test('it does NOT fire when a claimed source path changed', () => {
    const signals = acceptSignals(verify(outDir({ receipts: [bulk] }), outDir()));
    expect(acceptWithoutSourceChange(signals, 1)).toEqual([]);
  });

  test('it does NOT fire at or below the ratio threshold', () => {
    const half = receipt({
      id: 'rH',
      mode: 'bulk',
      reason: 'r',
      counts: { changed: 10, accepted: 5, skippedEquivalent: 0, acceptRatio: 0.5 },
    });
    const signals = acceptSignals(verify(outDir({ receipts: [half] }), outDir()));
    expect(signals[0]?.acceptRatio).toBe(ACCEPT_RATIO_THRESHOLD);
    expect(acceptWithoutSourceChange(signals, 0)).toEqual([]);
  });

  test('a zero-accept receipt never fires it', () => {
    const none = receipt({ id: 'rZ', mode: 'bulk', reason: 'r', counts: { changed: 0, accepted: 0, skippedEquivalent: 3, acceptRatio: 0 } });
    const signals = acceptSignals(verify(outDir({ receipts: [none] }), outDir()));
    expect(acceptWithoutSourceChange(signals, 0)).toEqual([]);
  });
});

/* ══════════════════ against a real repo, not a mock ═══════════════════ */

describe('collectOutDir / verifyProducer against real git', () => {
  const OUT = 'c/vibes/snapshots/p';

  test('reads the committed baseline at a rev and separates receipts from snapshots', async () => {
    const f = await fixture();
    await f.write(`${OUT}/a.txt`, 'one\n');
    await f.write(`${OUT}/nested/b.txt`, 'two\n');
    await f.write(
      `${OUT}/.vibes-accept.json`,
      JSON.stringify({
        schema: RECEIPT_LOG_SCHEMA,
        component: 'c',
        producer: 'p',
        receipts: [
          {
            id: 'r1',
            version: 1,
            component: 'c',
            producer: 'p',
            mode: 'reviewed',
            acceptedBy: 'someone',
            reason: 'r',
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            entries: [],
            counts: { changed: 0, accepted: 0, skippedEquivalent: 0, acceptRatio: 0 },
          },
        ],
      }),
    );
    const head = await f.commit('baseline');

    const repo = await openRepo({ cwd: f.dir });
    const snapshot = await collectOutDir(repo, head, OUT);
    expect(snapshot.files.map((x) => x.file)).toEqual(['a.txt', 'nested/b.txt']);
    expect(snapshot.receipts.map((r) => r.id)).toEqual(['r1']);
    expect(snapshot.files[0]?.sha256).toBe(hash('one\n'));
  });

  test('an absent out dir reads as absent, not as an empty-and-fine corpus', async () => {
    const f = await fixture();
    await f.write('README.md', 'x\n');
    const head = await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });
    expect((await collectOutDir(repo, head, OUT)).absent).toBe(true);
  });

  test('a sibling directory sharing a name prefix is not swept in', async () => {
    const f = await fixture();
    await f.write(`${OUT}/a.txt`, 'mine\n');
    await f.write(`${OUT}-other/b.txt`, 'not mine\n');
    const head = await f.commit('init');
    const repo = await openRepo({ cwd: f.dir });
    expect((await collectOutDir(repo, head, OUT)).files.map((x) => x.file)).toEqual(['a.txt']);
  });

  test('end to end: a hand-edited committed baseline is unreceipted', async () => {
    const f = await fixture();
    await f.write(`${OUT}/a.txt`, 'generated output\n');
    const base = await f.commit('baseline');
    // The laundering attempt: edit the committed snapshot and commit it.
    await f.write(`${OUT}/a.txt`, 'quietly different\n');
    const head = await f.commit('git add -A && git commit');

    const repo = await openRepo({ cwd: f.dir });
    const v = await verifyProducer(repo, { component: 'c', producer: 'p', outDir: OUT, baseSha: base, headSha: head });
    expect(v.counts).toMatchObject({ total: 1, unchanged: 0, accepted: 0, unreceipted: 1 });
    expect(v.unreceipted[0]?.repoPath).toBe(`${OUT}/a.txt`);
  });

  test('end to end: the same edit WITH a receipt is accepted', async () => {
    const f = await fixture();
    await f.write(`${OUT}/a.txt`, 'generated output\n');
    const base = await f.commit('baseline');
    await f.write(`${OUT}/a.txt`, 'legitimately different\n');
    await f.write(
      `${OUT}/.vibes-accept.json`,
      JSON.stringify({
        schema: RECEIPT_LOG_SCHEMA,
        component: 'c',
        producer: 'p',
        receipts: [
          {
            id: 'rOK',
            version: 1,
            component: 'c',
            producer: 'p',
            mode: 'reviewed',
            acceptedBy: 'someone',
            reason: 'the codec changed on purpose',
            baseSha: base,
            headSha: 'b'.repeat(40),
            entries: [
              {
                file: 'a.txt',
                sha256: hash('legitimately different\n'),
                previousSha256: hash('generated output\n'),
                verdict: 'different',
              },
            ],
            counts: { changed: 1, accepted: 1, skippedEquivalent: 0, acceptRatio: 1 },
          },
        ],
      }),
    );
    const head = await f.commit('accepted');

    const repo = await openRepo({ cwd: f.dir });
    const v = await verifyProducer(repo, { component: 'c', producer: 'p', outDir: OUT, baseSha: base, headSha: head });
    expect(v.unreceipted).toEqual([]);
    expect(v.files[0]).toMatchObject({ verdict: 'accepted', receiptId: 'rOK', chainedToBase: true });
  });

  test('end to end: a corrupted receipt is invalid, and does NOT read as a clean run', async () => {
    const f = await fixture();
    await f.write(`${OUT}/a.txt`, 'one\n');
    const base = await f.commit('baseline');
    await f.write(`${OUT}/a.txt`, 'two\n');
    await f.write(`${OUT}/.vibes-accept.json`, '{ "schema": "vibes-accept/1", "receipts": [ }');
    const head = await f.commit('oops');

    const repo = await openRepo({ cwd: f.dir });
    const v = await verifyProducer(repo, { component: 'c', producer: 'p', outDir: OUT, baseSha: base, headSha: head });
    expect(v.invalidReceipts).toHaveLength(1);
    expect(v.unreceipted).toHaveLength(1);
  });
});

test('the contract Receipt shape is a subset of HonestyReceipt', () => {
  const r: Receipt = receipt();
  expect(r.version).toBe(1);
});

describe('accept-written .gitattributes is not a snapshot', () => {
  // Regression: the first real CI run of this tool reported
  // `unreceipted-baseline` against every adopted corpus, because
  // `vibes accept --bootstrap` writes a `.gitattributes` beside the baselines
  // and never lists it in the receipt. Scanning it guaranteed a permanent
  // error on every correctly-bootstrapped repo.
  test('collectOutDir skips a top-level .gitattributes', async () => {
    const f = await fixture();
    await f.write('snaps/a.txt', 'one\n');
    await f.write('snaps/.gitattributes', '* -merge -diff linguist-generated=true\n');
    await f.git('add', '-A');
    const rev = await f.commit('baseline');

    const repo = await openRepo({ cwd: f.dir });
    const out = await collectOutDir(repo, rev, 'snaps');
    expect(out.files.map((x) => x.file)).toEqual(['a.txt']);
  });

  test('a NESTED .gitattributes is still a snapshot', async () => {
    // Only the top level is accept's. A producer that genuinely emits
    // `cases/.gitattributes` is emitting a snapshot and must stay vouched for.
    const f = await fixture();
    await f.write('snaps/cases/.gitattributes', 'x\n');
    await f.git('add', '-A');
    const rev = await f.commit('baseline');

    const repo = await openRepo({ cwd: f.dir });
    const out = await collectOutDir(repo, rev, 'snaps');
    expect(out.files.map((x) => x.file)).toEqual(['cases/.gitattributes']);
  });
});
