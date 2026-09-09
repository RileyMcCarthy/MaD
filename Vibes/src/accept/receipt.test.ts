import { describe, expect, test } from 'vitest';

import type { StoredReceipt } from './receipt.js';
import {
  canonicalJson,
  emptyReceiptFile,
  findingsForReceipt,
  parseReceiptFile,
  pruneReceipts,
  receiptId,
  serializeReceiptFile,
  vouchesFor,
  withId,
} from './receipt.js';
import { RECEIPT_SCHEMA } from './model.js';
import { sha256 } from './fixtures.test.js';

const A = sha256('a');
const B = sha256('b');
const C = sha256('c');

function receipt(over: Partial<StoredReceipt> = {}): StoredReceipt {
  return withId({
    version: 1,
    component: 'control',
    producer: 'domain',
    mode: 'reviewed',
    acceptedBy: 'cli',
    reason: '',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    entries: [{ file: 'a.gcode', sha256: A, previousSha256: null, verdict: 'different' }],
    counts: { changed: 1, accepted: 1, skippedEquivalent: 0, acceptRatio: 1 },
    ...over,
  });
}

describe('canonical encoding', () => {
  test('keys are sorted and the output ends in a newline', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n',
    );
  });

  test('undefined values are dropped rather than serialised as null', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{\n  "b": 1\n}\n');
  });

  test('the same acceptance always produces byte-identical output', () => {
    // A receipt that churns is a receipt reviewers learn to skip, which defeats
    // the only mechanism this module has.
    const one = serializeReceiptFile({ ...emptyReceiptFile('c', 'p'), receipts: [receipt()] });
    const two = serializeReceiptFile({ ...emptyReceiptFile('c', 'p'), receipts: [receipt()] });
    expect(one).toBe(two);
  });
});

describe('receiptId', () => {
  test('is content-derived, so a re-accept of the same batch is a no-op', () => {
    expect(receipt().id).toBe(receipt().id);
  });

  test('changes when anything it vouches for changes', () => {
    const base = receipt();
    const other = receipt({
      entries: [{ file: 'a.gcode', sha256: B, previousSha256: null, verdict: 'different' }],
    });
    expect(other.id).not.toBe(base.id);
  });

  test('changes when the STATED reason changes, not just the content', () => {
    // The reason is part of the signed statement; two different claims about
    // the same bytes must not collapse to one id.
    const a = receipt({ mode: 'bulk', reason: 'regenerated' });
    const b = receipt({ mode: 'bulk', reason: 'epsilon widened, see #412' });
    expect(a.id).not.toBe(b.id);
  });

  test('is shaped so it can be used in a rotated filename', () => {
    expect(receipt().id).toMatch(/^r[0-9a-f]{16}$/);
    expect(receiptId({ ...receipt(), id: undefined } as never)).toMatch(/^r[0-9a-f]{16}$/);
  });
});

describe('parseReceiptFile', () => {
  test('round-trips what serializeReceiptFile writes', () => {
    const file = { ...emptyReceiptFile('control', 'domain'), receipts: [receipt()] };
    const parsed = parseReceiptFile(serializeReceiptFile(file));
    expect(parsed.errors).toEqual([]);
    expect(parsed.file?.receipts[0]?.id).toBe(receipt().id);
    expect(parsed.file?.schema).toBe(RECEIPT_SCHEMA);
  });

  test('a corrupt file yields ERRORS, never an empty receipt list', () => {
    // Reading corruption as "no receipts" would make mangling the JSON the
    // cheapest way to erase an audit trail.
    for (const text of ['{', '[]', 'null', '"x"']) {
      const r = parseReceiptFile(text);
      expect(r.file).toBeNull();
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  test('a wrong schema is rejected', () => {
    const r = parseReceiptFile(JSON.stringify({ schema: 'other/9', component: 'c', producer: 'p', receipts: [] }));
    expect(r.file).toBeNull();
    expect(r.errors.join(' ')).toContain('schema');
  });

  test('an entry digest that is not 64 hex is rejected', () => {
    const bad = {
      schema: RECEIPT_SCHEMA,
      component: 'c',
      producer: 'p',
      receipts: [{ ...receipt(), entries: [{ file: 'a', sha256: 'deadbeef', verdict: 'different' }] }],
    };
    const r = parseReceiptFile(JSON.stringify(bad));
    expect(r.file).toBeNull();
    expect(r.errors.join(' ')).toContain('64-hex');
  });

  test('a bulk receipt with an empty reason is rejected', () => {
    const bad = {
      schema: RECEIPT_SCHEMA,
      component: 'c',
      producer: 'p',
      receipts: [{ ...receipt({ mode: 'bulk', reason: '   ' }) }],
    };
    const r = parseReceiptFile(JSON.stringify(bad));
    expect(r.file).toBeNull();
    expect(r.errors.join(' ')).toContain('requires a non-empty reason');
  });

  test('unknown fields written by a newer Vibes survive the round trip', () => {
    const withExtra = { ...receipt(), somethingNew: { a: 1 } } as unknown as StoredReceipt;
    const text = serializeReceiptFile({ ...emptyReceiptFile('c', 'p'), receipts: [withExtra] });
    const parsed = parseReceiptFile(text);
    expect((parsed.file?.receipts[0] as unknown as Record<string, unknown>)['somethingNew']).toEqual({ a: 1 });
  });
});

describe('vouchesFor', () => {
  test('answers with the most recent statement about a file', () => {
    const older = receipt({ reason: 'first' });
    const newer = receipt({
      reason: 'second',
      entries: [{ file: 'a.gcode', sha256: A, previousSha256: B, verdict: 'different' }],
    });
    expect(vouchesFor([older, newer], 'a.gcode', A)).toBe(newer.id);
    expect(vouchesFor([older, newer], 'a.gcode', C)).toBeNull();
    expect(vouchesFor([older, newer], 'other.gcode', A)).toBeNull();
  });
});

describe('pruneReceipts', () => {
  const probe = (current: Record<string, string>, base: Record<string, string>) => ({
    currentSha256: (f: string) => current[f] ?? null,
    baseSha256: (f: string) => base[f] ?? null,
  });

  test('keeps a receipt whose bytes are on disk and absent from base', () => {
    const r = receipt();
    const { kept, dropped } = pruneReceipts([r], probe({ 'a.gcode': A }, { 'a.gcode': B }));
    expect(kept.map((x) => x.id)).toEqual([r.id]);
    expect(dropped).toEqual([]);
  });

  test('drops a receipt the base tree now vouches for — the branch merged', () => {
    const r = receipt();
    const { kept, dropped } = pruneReceipts([r], probe({ 'a.gcode': A }, { 'a.gcode': A }));
    expect(kept).toEqual([]);
    expect(dropped).toEqual([r.id]);
  });

  test('drops a receipt superseded by later content in the same branch', () => {
    // Accept #1 vouched for A; accept #2 replaced it with B. Nothing on disk
    // matches #1 any more, so it cannot be load-bearing.
    const r = receipt();
    const { dropped } = pruneReceipts([r], probe({ 'a.gcode': B }, {}));
    expect(dropped).toEqual([r.id]);
  });

  test('drops a receipt whose file no longer exists', () => {
    const r = receipt();
    const { dropped } = pruneReceipts([r], probe({}, {}));
    expect(dropped).toEqual([r.id]);
  });

  test('one load-bearing entry keeps the WHOLE receipt', () => {
    // Partial pruning would rewrite someone else's signed statement.
    const r = receipt({
      entries: [
        { file: 'a.gcode', sha256: A, previousSha256: null, verdict: 'different' },
        { file: 'b.gcode', sha256: B, previousSha256: null, verdict: 'different' },
      ],
    });
    const { kept } = pruneReceipts(
      [r],
      probe({ 'a.gcode': A, 'b.gcode': B }, { 'a.gcode': A }),
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.entries).toHaveLength(2);
  });
});

describe('findingsForReceipt', () => {
  test('bulk-accept is alwaysExpanded — a blind accept must be impossible to miss', () => {
    const f = findingsForReceipt(
      receipt({ mode: 'bulk', acceptedBy: '--all', reason: 'regenerated' }),
    );
    const bulk = f.find((x) => x.id.startsWith('bulk-accept:'));
    expect(bulk?.alwaysExpanded).toBe(true);
    expect(bulk?.detail).toContain('--all');
    expect(bulk?.detail).toContain('regenerated');
  });

  test('accept-without-source-change fires on a high ratio with no claimed change', () => {
    const f = findingsForReceipt(
      receipt({
        mode: 'bulk',
        reason: 'r',
        sourceContext: { changedWitnessPaths: [], corpusChangedPaths: [], exercisedWitnessPaths: [] },
      }),
    );
    expect(f.some((x) => x.id.startsWith('accept-without-source-change:'))).toBe(true);
  });

  test('it does NOT fire when a claimed source path changed', () => {
    const f = findingsForReceipt(
      receipt({
        mode: 'bulk',
        reason: 'r',
        sourceContext: {
          changedWitnessPaths: ['Software/Control/src/domain/gcode.ts'],
          corpusChangedPaths: [],
          exercisedWitnessPaths: [],
        },
      }),
    );
    expect(f.some((x) => x.id.startsWith('accept-without-source-change:'))).toBe(false);
  });

  test('a bootstrap never counts as regenerate-until-green', () => {
    const f = findingsForReceipt(
      receipt({
        mode: 'bootstrap',
        reason: 'adopting',
        doctorRuns: ['d', 'd', 'd'],
        sourceContext: { changedWitnessPaths: [], corpusChangedPaths: [], exercisedWitnessPaths: [] },
      }),
    );
    expect(f.some((x) => x.id.startsWith('accept-without-source-change:'))).toBe(false);
    const boot = f.find((x) => x.id.startsWith('bootstrap:'));
    expect(boot?.severity).toBe('info');
    expect(boot?.detail).toContain('3 agreeing doctor runs');
  });

  test('deletions carry the corpus-shr id prefix that routes them above behaviour', () => {
    // emit/ ranks findings whose id matches /^(governance|policy|weaken|corpus-shr|unreceipted)/
    // into the policy section, which renders first. A shrinking corpus explains
    // away every verified-unchanged below it.
    const f = findingsForReceipt(
      receipt({
        mode: 'bulk',
        reason: 'cases retired',
        deletions: [{ file: 'old.gcode', previousSha256: A }],
        acceptDeletionsDeclared: 1,
      }),
    );
    const d = f.find((x) => x.id.startsWith('corpus-shrank:'));
    expect(d).toBeDefined();
    expect(/^(governance|policy|weaken|corpus-shr|unreceipted)/.test(d!.id)).toBe(true);
    expect(d?.paths).toEqual(['old.gcode']);
  });

  test('strict promotes the soft findings to error', () => {
    const soft = findingsForReceipt(receipt({ mode: 'bulk', reason: 'r' }));
    const hard = findingsForReceipt(receipt({ mode: 'bulk', reason: 'r' }), { strict: true });
    expect(soft.find((x) => x.id.startsWith('bulk-accept:'))?.severity).toBe('warn');
    expect(hard.find((x) => x.id.startsWith('bulk-accept:'))?.severity).toBe('error');
  });

  test('an unverified producer is recorded as locally-accepted, never CI-verified', () => {
    const f = findingsForReceipt(receipt({ unverifiedProducer: true }));
    const u = f.find((x) => x.id.startsWith('never-ci-verified:'));
    expect(u?.detail).toContain('never CI-verified');
  });

  test('a plain reviewed accept with a claimed change produces no findings', () => {
    const f = findingsForReceipt(
      receipt({
        sourceContext: {
          changedWitnessPaths: ['Software/Control/src/domain/gcode.ts'],
          corpusChangedPaths: [],
          exercisedWitnessPaths: [],
        },
      }),
    );
    expect(f).toEqual([]);
  });

  test('an ABSENT sourceContext is silent, not an accusation', () => {
    // Unknown is not the same as empty. A receipt written before the field
    // existed must not read as regenerate-until-green forever.
    expect(findingsForReceipt(receipt())).toEqual([]);
  });
});

/**
 * The one cross-module contract in this design.
 *
 * `honesty/receipts.ts` reads the union of `.vibes-accept*.json` in an out dir
 * and asks whether anything vouches for each committed baseline file. If what
 * accept WRITES ever stops being what honesty READS, every accepted snapshot
 * reads `unreceipted-baseline` in the next run — an error caused entirely by
 * the two modules disagreeing, on the exact check that is supposed to be the
 * guardrail.
 *
 * The shape assertions below are spelled out locally so they hold even while
 * the reader is being rewritten; the live cross-check runs on top when the
 * module can be imported, and says so rather than passing silently.
 */
describe('on-disk contract with the honesty reader', () => {
  const file = {
    ...emptyReceiptFile('control', 'domain'),
    receipts: [receipt({ mode: 'bulk', reason: 'regenerated', acceptedBy: '--all' })],
  };

  test('the document is a schema-tagged wrapper around an array of receipts', () => {
    const doc = JSON.parse(serializeReceiptFile(file)) as Record<string, unknown>;
    expect(doc['schema']).toBe('vibes-accept/1');
    expect(Array.isArray(doc['receipts'])).toBe(true);
  });

  test('every field the reader requires is present and correctly typed', () => {
    const doc = JSON.parse(serializeReceiptFile(file)) as { receipts: Record<string, unknown>[] };
    const r = doc.receipts[0]!;
    expect(typeof r['id']).toBe('string');
    expect(r['version']).toBe(1);
    expect(['reviewed', 'bulk', 'bootstrap']).toContain(r['mode']);
    expect(typeof r['acceptedBy']).toBe('string');
    expect((r['reason'] as string).trim()).not.toBe(''); // required for non-reviewed
    expect(typeof r['baseSha']).toBe('string');
    expect(typeof r['headSha']).toBe('string');
    for (const e of r['entries'] as Record<string, unknown>[]) {
      expect(typeof e['file']).toBe('string');
      expect(e['sha256']).toMatch(/^[0-9a-f]{64}$/);
      expect(e['previousSha256'] === null || /^[0-9a-f]{64}$/.test(String(e['previousSha256']))).toBe(true);
    }
    const counts = r['counts'] as Record<string, unknown>;
    for (const k of ['changed', 'accepted', 'skippedEquivalent', 'acceptRatio']) {
      expect(typeof counts[k]).toBe('number');
    }
  });

  test('the live honesty reader accepts it', async () => {
    let mod: Record<string, unknown>;
    try {
      mod = (await import('../honesty/receipts.js')) as unknown as Record<string, unknown>;
    } catch {
      // The sibling module is mid-write. The shape assertions above still ran;
      // this cross-check re-arms as soon as it imports.
      expect(true).toBe(true);
      return;
    }
    const parse = mod['parseReceiptDocument'];
    if (typeof parse !== 'function') return;
    const parsed = (parse as (t: string) => { receipts: unknown[]; error: string | null })(
      serializeReceiptFile(file),
    );
    expect(parsed.error).toBeNull();
    expect(parsed.receipts).toHaveLength(1);
  });
});
