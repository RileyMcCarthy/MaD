/**
 * Receipt verification — THE guardrail.
 *
 * Recompute sha256 of EVERY committed baseline file and cross-check it against
 * the union of receipts in that out dir plus the baseline content at <base>.
 * Three outcomes, and only three:
 *
 *   content == base content            → unchanged. Fine.
 *   content == a receipt entry's sha   → accepted, and the receipt says HOW.
 *   content matches neither            → `unreceipted-baseline`, ERROR.
 *
 * That third line is the whole mechanism. `git add -A && git commit` cannot
 * launder a snapshot change: the bytes moved, nothing vouches for them, the run
 * fails. Hand-editing a baseline has the same result. Fabricating a receipt
 * requires computing the correct sha256s AND writing mode/reason/counts into a
 * file that lands in the PR diff — at which point nothing has been hidden; a
 * signed statement has been filed.
 *
 * We cannot make blind acceptance impossible. We make it visible, attributable
 * and expensive. This file is where "visible" is enforced.
 *
 * ── CONTRACT WITH `vibes accept` ──────────────────────────────────────────
 * Receipts are read as a UNION over every `.vibes-accept*.json` in the out dir,
 * and each of those files is a LOG: `{schema:'vibes-accept/1', component,
 * producer, receipts:[…]}`. Both halves of that matter.
 *
 * The log shape exists because a branch with two accepting commits needs BOTH
 * receipts alive: after the second accept, the first batch's bytes still differ
 * from `<base>` and nothing else vouches for them. If `accept` replaced the
 * file and dropped old entries, a snapshot accepted in commit 1 and untouched
 * since would read `unreceipted-baseline` in commit 2 — and the first person to
 * hit that would delete the check rather than debug it.
 *
 * The file format is DUPLICATED here rather than imported from `accept/`, on
 * purpose: `accept` is a command layer that sits above this one and will want
 * to call the honesty check, so importing upwards would close a cycle. The
 * price is that the two parsers can drift; the mitigation is that this one is
 * deliberately permissive about everything except the fields it verifies
 * against (`entries[].file`, `entries[].sha256`, `deletions[].file`), and that
 * an unparseable receipt is a loud ERROR rather than a silent zero-receipt read.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'node:crypto';

import type { GitRepo } from '../git/index.js';
import type {
  AcceptMode,
  ComponentId,
  ProducerName,
  Receipt,
  ReceiptEntry,
  RepoPath,
  Sha,
  VerdictKind,
} from '../types.js';

/** Written by `vibes accept`, not by a producer. */
const GITATTRIBUTES_BASENAME = '.gitattributes';

/** What `vibes accept` writes. */
export const RECEIPT_BASENAME = '.vibes-accept.json';
/** What verification reads — the canonical name plus any rotated sibling. */
export const RECEIPT_FILE_RE = /^\.vibes-accept(?:\.[A-Za-z0-9_-]+)?\.json$/;
/** The log wrapper `accept` writes around its receipts. */
export const RECEIPT_LOG_SCHEMA = 'vibes-accept/1';

/**
 * Files inside an out dir that are Vibes bookkeeping rather than behaviour.
 * The runner must exclude these from snapshot comparison, or the report shows
 * the receipt diffing against itself on every accept.
 */
export function isBookkeepingFile(fileRelToOutDir: string): boolean {
  if (fileRelToOutDir.includes('/')) return false; // top level only
  return (
    RECEIPT_FILE_RE.test(fileRelToOutDir) ||
    fileRelToOutDir === '_vibes-census.json' ||
    fileRelToOutDir === '_vibes-provenance.json' ||
    fileRelToOutDir === '.gitattributes'
  );
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/* ───────────────────────────── collection ────────────────────────────── */

export interface BaselineFile {
  /** Path relative to the out dir, POSIX. */
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface InvalidReceipt {
  readonly path: RepoPath;
  readonly message: string;
}

/**
 * A file the accept REMOVED.
 *
 * Kept out of `entries` because `ReceiptEntry` requires a content digest and a
 * deleted file has none. A sentinel sha there would be a value the content scan
 * could match against — i.e. a receipt that vouches for arbitrary bytes.
 */
export interface ReceiptDeletion {
  readonly file: string;
  readonly previousSha256: string | null;
}

/**
 * The contract's `Receipt` plus the two fields `accept` records that the shared
 * type has no slot for. Both are load-bearing here: `deletions` is what stops a
 * receipted removal reading as `corpus-shrank`, and `changedWitnessPaths` is
 * the diff as it stood AT ACCEPT TIME, which is evidence a later run cannot
 * reconstruct.
 */
export interface HonestyReceipt extends Receipt {
  readonly deletions: readonly ReceiptDeletion[];
  /** `sourceContext.changedWitnessPaths`, or null when the receipt predates it. */
  readonly changedWitnessPaths: readonly RepoPath[] | null;
}

export interface OutDirSnapshot {
  readonly outDir: RepoPath;
  readonly rev: string;
  readonly files: readonly BaselineFile[];
  readonly receipts: readonly HonestyReceipt[];
  readonly invalidReceipts: readonly InvalidReceipt[];
  /** True when the out dir does not exist at this rev at all. */
  readonly absent: boolean;
}

/**
 * Read one producer's committed out dir at a rev.
 *
 * The tree is read once and the blobs are batched by oid — never
 * `git show <rev>:<path>` per file, which is one process per snapshot and turns
 * a 300-file corpus into 300 spawns.
 */
export async function collectOutDir(
  repo: GitRepo,
  rev: string,
  outDir: RepoPath,
): Promise<OutDirSnapshot> {
  const dir = outDir.replace(/\/+$/, '');
  const prefix = `${dir}/`;
  const entries = await repo.lsTreeEntries(rev, dir);

  const blobs = entries.filter((e) => e.type === 'blob' && e.path.startsWith(prefix));
  const contents = await repo.readBlobsByOid(blobs.map((e) => e.oid));

  const files: BaselineFile[] = [];
  const receipts: HonestyReceipt[] = [];
  const invalidReceipts: InvalidReceipt[] = [];

  for (const e of blobs) {
    const rel = e.path.slice(prefix.length);
    const buf = contents.get(e.oid) ?? null;
    if (buf === null) continue;
    if (RECEIPT_FILE_RE.test(rel) && !rel.includes('/')) {
      const parsed = parseReceiptDocument(buf.toString('utf8'));
      if (parsed.error !== null) invalidReceipts.push({ path: e.path, message: parsed.error });
      else receipts.push(...parsed.receipts);
      continue;
    }
    // `.gitattributes` at the top of an out dir is written by `vibes accept`
    // itself, with fixed content, and is not producer output. It can therefore
    // never appear in a receipt's entries, so scanning it guarantees a
    // permanent `unreceipted-baseline` error on every adopted corpus — which is
    // exactly what the first real CI run of this tool reported against itself.
    // `isBookkeepingFile` already classifies it; this agrees with it.
    //
    // KNOWN GAP, stated rather than hidden: this means a hand-edit of that file
    // is not caught here. It matters — dropping `-merge` would let git
    // auto-merge two branches' snapshots into a file matching neither, while
    // still passing review. That belongs in policy drift, not in the receipt
    // scan, and is not implemented yet.
    if (rel === GITATTRIBUTES_BASENAME) continue;

    // Census and provenance are Vibes bookkeeping, but they are NOT skipped
    // here: their bytes are behaviour the census check reads, and skipping them
    // would make a shrinking corpus invisible to the receipt scan too.
    files.push({ file: rel, sha256: sha256(buf), bytes: buf.length });
  }

  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { outDir: dir, rev, files, receipts, invalidReceipts, absent: entries.length === 0 };
}

/* ───────────────────────────── parsing ───────────────────────────────── */

export type ReceiptParse =
  | { readonly receipt: HonestyReceipt; readonly error: null }
  | { readonly receipt: null; readonly error: string };

export type ReceiptDocumentParse =
  | { readonly receipts: readonly HonestyReceipt[]; readonly error: null }
  | { readonly receipts: readonly HonestyReceipt[]; readonly error: string };

const SHA256_RE = /^[0-9a-f]{64}$/;
const MODES: ReadonlySet<string> = new Set<AcceptMode>(['reviewed', 'bulk', 'bootstrap']);
const VERDICTS: ReadonlySet<string> = new Set<VerdictKind>([
  'identical',
  'equivalent',
  'different',
  'structural',
  'added',
  'deleted',
  'not-run',
  'not-selected',
]);

/**
 * Shape validation is not ceremony here. An unparseable receipt vouches for
 * nothing, and "vouches for nothing" must read as an ERROR rather than as a
 * clean run — otherwise the cheapest way to defeat the guardrail is to commit
 * a receipt with a typo in it.
 */
/**
 * Read one `.vibes-accept*.json`.
 *
 * Accepts the log wrapper `accept` writes AND a bare receipt object, because a
 * hand-written or hand-repaired receipt is a real thing that shows up in a repo
 * and rejecting it would push people towards deleting the file instead — which
 * is strictly worse, since a deleted receipt reads as `unreceipted-baseline`
 * for content that was in fact reviewed.
 *
 * A malformed document yields ZERO receipts and an error string. It must never
 * yield "no receipts, no problem": corrupting the file would then become the
 * cheapest way to erase the audit trail without failing anything.
 */
export function parseReceiptDocument(text: string): ReceiptDocumentParse {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (e) {
    return { receipts: [], error: `not valid JSON: ${(e as Error).message}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { receipts: [], error: 'not a JSON object' };
  }
  const doc = value as Record<string, unknown>;

  if (!('receipts' in doc) && !('schema' in doc)) {
    const one = parseReceiptValue(doc);
    return one.receipt === null
      ? { receipts: [], error: one.error }
      : { receipts: [one.receipt], error: null };
  }
  if (doc['schema'] !== RECEIPT_LOG_SCHEMA) {
    return {
      receipts: [],
      error: `unexpected receipt schema ${JSON.stringify(doc['schema'])} (want ${JSON.stringify(RECEIPT_LOG_SCHEMA)})`,
    };
  }
  const list = doc['receipts'];
  if (!Array.isArray(list)) return { receipts: [], error: 'missing `receipts` array' };

  const out: HonestyReceipt[] = [];
  for (const [i, raw] of list.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { receipts: [], error: `receipts[${String(i)}] is not an object` };
    }
    const parsed = parseReceiptValue(raw as Record<string, unknown>);
    if (parsed.receipt === null) {
      return { receipts: [], error: `receipts[${String(i)}]: ${parsed.error}` };
    }
    out.push(parsed.receipt);
  }
  return { receipts: out, error: null };
}

export function parseReceipt(text: string): ReceiptParse {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (e) {
    return { receipt: null, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { receipt: null, error: 'not a JSON object' };
  }
  return parseReceiptValue(value as Record<string, unknown>);
}

function parseReceiptValue(r: Record<string, unknown>): ReceiptParse {

  const str = (k: string): string | null => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const id = str('id');
  const component = str('component');
  const producer = str('producer');
  const mode = str('mode');
  const acceptedBy = str('acceptedBy');
  const reason = str('reason');
  const baseSha = str('baseSha');
  const headSha = str('headSha');

  if (id === null || id === '') return { receipt: null, error: 'missing `id`' };
  if (r['version'] !== 1) return { receipt: null, error: 'missing or unsupported `version` (expected 1)' };
  if (component === null) return { receipt: null, error: 'missing `component`' };
  if (producer === null) return { receipt: null, error: 'missing `producer`' };
  if (mode === null || !MODES.has(mode)) {
    return { receipt: null, error: 'missing or invalid `mode` (reviewed | bulk | bootstrap)' };
  }
  if (acceptedBy === null) return { receipt: null, error: 'missing `acceptedBy`' };
  if (baseSha === null) return { receipt: null, error: 'missing `baseSha`' };
  if (headSha === null) return { receipt: null, error: 'missing `headSha`' };
  // A non-reviewed accept with no stated reason is the exact move the receipt
  // exists to make attributable; an empty one is rejected rather than recorded.
  if (mode !== 'reviewed' && (reason === null || reason.trim() === '')) {
    return { receipt: null, error: `mode "${mode}" requires a non-empty \`reason\`` };
  }

  const rawEntries = r['entries'];
  if (!Array.isArray(rawEntries)) return { receipt: null, error: 'missing `entries` array' };
  const entries: ReceiptEntry[] = [];
  for (const [i, raw] of rawEntries.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      return { receipt: null, error: `entries[${String(i)}] is not an object` };
    }
    const e = raw as Record<string, unknown>;
    const file = typeof e['file'] === 'string' ? e['file'] : null;
    const sha = typeof e['sha256'] === 'string' ? e['sha256'] : null;
    const verdict = typeof e['verdict'] === 'string' ? e['verdict'] : null;
    const prev = typeof e['previousSha256'] === 'string' ? e['previousSha256'] : null;
    if (file === null || file === '') {
      return { receipt: null, error: `entries[${String(i)}].file is missing` };
    }
    if (verdict === null || !VERDICTS.has(verdict)) {
      return { receipt: null, error: `entries[${String(i)}].verdict is missing or unknown` };
    }
    // A deletion has no content to vouch for; every other verdict must carry a
    // real digest, or the entry silently vouches for anything.
    if (verdict !== 'deleted' && (sha === null || !SHA256_RE.test(sha))) {
      return { receipt: null, error: `entries[${String(i)}].sha256 is not a 64-hex digest` };
    }
    if (prev !== null && prev !== '' && !SHA256_RE.test(prev)) {
      return { receipt: null, error: `entries[${String(i)}].previousSha256 is not a 64-hex digest` };
    }
    entries.push({
      file,
      sha256: sha ?? '',
      previousSha256: prev,
      verdict: verdict as VerdictKind,
    });
  }

  const rawCounts = r['counts'];
  const counts =
    typeof rawCounts === 'object' && rawCounts !== null
      ? (rawCounts as Record<string, unknown>)
      : {};
  const num = (k: string): number => (typeof counts[k] === 'number' ? (counts[k] as number) : 0);

  // `deletions` is a sibling array, not an entry verdict. A malformed row here
  // is dropped rather than fatal: over-reporting a deletion as unreceipted is
  // the safe direction, and a fatal parse would take the whole log's vouching
  // power down with it.
  const deletions: ReceiptDeletion[] = [];
  if (Array.isArray(r['deletions'])) {
    for (const raw of r['deletions'] as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const d = raw as Record<string, unknown>;
      const file = typeof d['file'] === 'string' ? d['file'] : null;
      if (file === null || file === '') continue;
      deletions.push({
        file,
        previousSha256: typeof d['previousSha256'] === 'string' ? d['previousSha256'] : null,
      });
    }
  }

  const ctx = r['sourceContext'];
  const changedWitnessPaths =
    typeof ctx === 'object' && ctx !== null && Array.isArray((ctx as Record<string, unknown>)['changedWitnessPaths'])
      ? ((ctx as Record<string, unknown>)['changedWitnessPaths'] as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        )
      : null;

  const receipt: HonestyReceipt = {
    id,
    version: 1,
    component,
    producer,
    mode: mode as AcceptMode,
    acceptedBy,
    reason: reason ?? '',
    baseSha,
    headSha,
    entries,
    counts: {
      changed: num('changed'),
      accepted: num('accepted'),
      skippedEquivalent: num('skippedEquivalent'),
      acceptRatio: num('acceptRatio'),
    },
    deletions,
    changedWitnessPaths,
    ...(r['unverifiedProducer'] === true ? { unverifiedProducer: true } : {}),
    ...(Array.isArray(r['doctorRuns'])
      ? { doctorRuns: (r['doctorRuns'] as unknown[]).filter((x): x is string => typeof x === 'string') }
      : {}),
  };
  return { receipt, error: null };
}

/* ──────────────────────────── verification ───────────────────────────── */

export type BaselineVerdict = 'unchanged' | 'accepted' | 'unreceipted';

export interface BaselineFileCheck {
  readonly file: string;
  readonly repoPath: RepoPath;
  readonly sha256: string;
  readonly baseSha256: string | null;
  readonly verdict: BaselineVerdict;
  readonly receiptId: string | null;
  readonly receiptMode: AcceptMode | null;
  readonly receiptReason: string | null;
  /** A receipt entry for this file records `previousSha256 === baseSha256`, so
   *  the accepted content descends from what base actually held. Informational:
   *  a broken chain is still an accepted file, but it is worth printing. */
  readonly chainedToBase: boolean;
  readonly note: string;
}

export interface DeletionCheck {
  readonly file: string;
  readonly repoPath: RepoPath;
  readonly baseSha256: string;
  readonly receipted: boolean;
  readonly receiptId: string | null;
}

export interface OrphanEntry {
  readonly receiptId: string;
  readonly file: string;
  readonly repoPath: RepoPath;
}

export interface ReceiptVerification {
  readonly component: ComponentId;
  readonly producer: ProducerName;
  readonly outDir: RepoPath;
  readonly files: readonly BaselineFileCheck[];
  readonly unreceipted: readonly BaselineFileCheck[];
  readonly deletions: readonly DeletionCheck[];
  readonly unreceiptedDeletions: readonly DeletionCheck[];
  readonly orphanEntries: readonly OrphanEntry[];
  readonly receipts: readonly HonestyReceipt[];
  /** Receipts whose id is not present at base — written in THIS branch. */
  readonly newReceipts: readonly HonestyReceipt[];
  readonly invalidReceipts: readonly InvalidReceipt[];
  /** Nothing committed at base: this producer is bootstrapping, not regressing. */
  readonly bootstrap: boolean;
  readonly counts: {
    readonly total: number;
    readonly unchanged: number;
    readonly accepted: number;
    readonly unreceipted: number;
  };
}

export interface VerifyInput {
  readonly component: ComponentId;
  readonly producer: ProducerName;
  readonly outDir: RepoPath;
  /** The committed baseline being judged — normally the HEAD tree. Pass the
   *  worktree hashes instead to catch a hand-edit before it is committed. */
  readonly current: OutDirSnapshot;
  readonly base: OutDirSnapshot;
}

export function verifyReceipts(input: VerifyInput): ReceiptVerification {
  const dir = input.outDir.replace(/\/+$/, '');
  const baseByFile = new Map(input.base.files.map((f) => [f.file, f]));
  const currentByFile = new Map(input.current.files.map((f) => [f.file, f]));

  // The union of receipts. Later receipts do not supersede earlier ones: a file
  // accepted three commits ago and untouched since is still vouched for by that
  // receipt, and dropping it would manufacture an `unreceipted-baseline`.
  const vouchers = new Map<string, { entry: ReceiptEntry; receipt: HonestyReceipt }[]>();
  for (const receipt of input.current.receipts) {
    for (const entry of receipt.entries) {
      const list = vouchers.get(entry.file) ?? [];
      list.push({ entry, receipt });
      vouchers.set(entry.file, list);
    }
  }
  // Deletions live in their own array (see `ReceiptDeletion`), so they are
  // indexed separately. Missing this index is how a receipted removal reads as
  // `corpus-shrank` — the exact false positive that gets a check disabled.
  const deletionVouchers = new Map<string, HonestyReceipt>();
  for (const receipt of input.current.receipts) {
    for (const d of receipt.deletions) {
      if (!deletionVouchers.has(d.file)) deletionVouchers.set(d.file, receipt);
    }
  }

  const baseIds = new Set(input.base.receipts.map((r) => r.id));
  const newReceipts = input.current.receipts.filter((r) => !baseIds.has(r.id));

  const files: BaselineFileCheck[] = [];
  for (const f of input.current.files) {
    const baseFile = baseByFile.get(f.file) ?? null;
    const repoPath = `${dir}/${f.file}`;
    if (baseFile !== null && baseFile.sha256 === f.sha256) {
      files.push({
        file: f.file,
        repoPath,
        sha256: f.sha256,
        baseSha256: baseFile.sha256,
        verdict: 'unchanged',
        receiptId: null,
        receiptMode: null,
        receiptReason: null,
        chainedToBase: true,
        note: 'byte-identical to the baseline at base',
      });
      continue;
    }
    const vouched = (vouchers.get(f.file) ?? []).filter(
      (v) => v.entry.verdict !== 'deleted' && v.entry.sha256 === f.sha256,
    );
    const hit = vouched[0];
    if (hit !== undefined) {
      const chained = (vouchers.get(f.file) ?? []).some(
        (v) => v.entry.previousSha256 !== null && v.entry.previousSha256 === baseFile?.sha256,
      );
      files.push({
        file: f.file,
        repoPath,
        sha256: f.sha256,
        baseSha256: baseFile?.sha256 ?? null,
        verdict: 'accepted',
        receiptId: hit.receipt.id,
        receiptMode: hit.receipt.mode,
        receiptReason: hit.receipt.reason,
        chainedToBase: chained,
        note: `accepted by ${hit.receipt.id} (${hit.receipt.mode}, by ${hit.receipt.acceptedBy})`,
      });
      continue;
    }
    files.push({
      file: f.file,
      repoPath,
      sha256: f.sha256,
      baseSha256: baseFile?.sha256 ?? null,
      verdict: 'unreceipted',
      receiptId: null,
      receiptMode: null,
      receiptReason: null,
      chainedToBase: false,
      note:
        baseFile === null
          ? 'new committed baseline file that no receipt vouches for'
          : 'committed baseline content differs from base and no receipt vouches for it',
    });
  }

  const deletions: DeletionCheck[] = [];
  for (const b of input.base.files) {
    if (currentByFile.has(b.file)) continue;
    const byEntry = (vouchers.get(b.file) ?? []).find((v) => v.entry.verdict === 'deleted');
    const byArray = deletionVouchers.get(b.file);
    const receipt = byEntry?.receipt ?? byArray ?? null;
    deletions.push({
      file: b.file,
      repoPath: `${dir}/${b.file}`,
      baseSha256: b.sha256,
      receipted: receipt !== null,
      receiptId: receipt?.id ?? null,
    });
  }

  const orphanEntries: OrphanEntry[] = [];
  for (const [file, list] of vouchers) {
    if (currentByFile.has(file)) continue;
    if (list.every((v) => v.entry.verdict === 'deleted')) continue;
    if (deletionVouchers.has(file)) continue;
    const first = list[0];
    if (first === undefined) continue;
    orphanEntries.push({ receiptId: first.receipt.id, file, repoPath: `${dir}/${file}` });
  }

  const unreceipted = files.filter((f) => f.verdict === 'unreceipted');
  return {
    component: input.component,
    producer: input.producer,
    outDir: dir,
    files,
    unreceipted,
    deletions,
    unreceiptedDeletions: deletions.filter((d) => !d.receipted),
    orphanEntries,
    receipts: input.current.receipts,
    newReceipts,
    invalidReceipts: input.current.invalidReceipts,
    bootstrap: input.base.files.length === 0,
    counts: {
      total: files.length,
      unchanged: files.filter((f) => f.verdict === 'unchanged').length,
      accepted: files.filter((f) => f.verdict === 'accepted').length,
      unreceipted: unreceipted.length,
    },
  };
}

/** Collect both sides and verify, in the order the CLI wants them. */
export async function verifyProducer(
  repo: GitRepo,
  opts: {
    readonly component: ComponentId;
    readonly producer: ProducerName;
    readonly outDir: RepoPath;
    readonly baseSha: Sha;
    readonly headSha: Sha;
  },
): Promise<ReceiptVerification> {
  const [current, base] = await Promise.all([
    collectOutDir(repo, opts.headSha, opts.outDir),
    collectOutDir(repo, opts.baseSha, opts.outDir),
  ]);
  return verifyReceipts({
    component: opts.component,
    producer: opts.producer,
    outDir: opts.outDir,
    current,
    base,
  });
}

/* ─────────────────────── the accept counter-signals ──────────────────── */

/**
 * `accept-without-source-change` fires at ratio > 0.5 with no claimed source
 * change. Half is not a tuned constant — it is "most of what was offered", the
 * point at which the accept stops being a decision about particular files.
 */
export const ACCEPT_RATIO_THRESHOLD = 0.5;

export interface AcceptSignal {
  readonly component: ComponentId;
  readonly producer: ProducerName;
  readonly receiptId: string;
  readonly mode: AcceptMode;
  readonly acceptedBy: string;
  readonly reason: string;
  readonly acceptRatio: number;
  readonly accepted: number;
  readonly changed: number;
  readonly bulk: boolean;
  readonly unverifiedProducer: boolean;
  /** The witness paths that had changed AT ACCEPT TIME, as recorded by
   *  `accept`. Null for a receipt written before that field existed. A later
   *  run cannot reconstruct this, which is exactly why it is worth carrying. */
  readonly changedWitnessPathsAtAccept: readonly RepoPath[] | null;
  readonly deletions: number;
}

/** Signals from receipts written in THIS branch. An old receipt describes a
 *  decision that was already reviewed; re-raising it every run is noise. */
export function acceptSignals(v: ReceiptVerification): readonly AcceptSignal[] {
  return v.newReceipts.map((r) => ({
    component: v.component,
    producer: v.producer,
    receiptId: r.id,
    mode: r.mode,
    acceptedBy: r.acceptedBy,
    reason: r.reason,
    acceptRatio: ratioOf(r),
    accepted: r.counts.accepted,
    changed: r.counts.changed,
    bulk: r.mode === 'bulk' || r.acceptedBy === '--all' || r.acceptedBy === '--yes',
    unverifiedProducer: r.unverifiedProducer === true,
    changedWitnessPathsAtAccept: r.changedWitnessPaths,
    deletions: r.deletions.length,
  }));
}

/**
 * `acceptRatio` is recomputed from the counts rather than trusted, because it is
 * a number written by the same process the check is watching. A stated ratio
 * that disagrees with accepted/changed is itself worth knowing about.
 */
export function ratioOf(r: Receipt): number {
  const { accepted, changed } = r.counts;
  if (changed > 0) return accepted / changed;
  return accepted > 0 ? 1 : r.counts.acceptRatio;
}

/**
 * THE cheapest real defence in the design: a lot of behaviour accepted while
 * nothing the producer claims to cover changed. That is "regenerate until
 * green", and it needs no coverage data to detect.
 *
 * ── ON THE NAME `exercisedWitnessPaths` ───────────────────────────────────
 * The spec says this fires when `exercisedWitnessPaths` is empty, and the
 * contract defines that field as "witness globs that had a changed source file
 * this diff" — i.e. CLAIMED-and-changed, not the `exercised` attribution
 * verdict. The two read alike and are not the same set, so the parameter here
 * is named for what it actually is.
 *
 * Feeding the `exercised` VERDICT in would fire on every legitimate accept:
 * after accepting, the baseline matches the received output, so on the next run
 * nothing moves and every claimed path reads `unexercised`. The honest question
 * is "did any source this producer claims change at all", which is the claimed
 * count — `ComponentAttribution.claimedPaths.length`.
 */
export function acceptWithoutSourceChange(
  signals: readonly AcceptSignal[],
  claimedChangedPathCount: number,
): readonly AcceptSignal[] {
  if (claimedChangedPathCount > 0) return [];
  return signals.filter((s) => s.acceptRatio > ACCEPT_RATIO_THRESHOLD && s.accepted > 0);
}
