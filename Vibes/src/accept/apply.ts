/**
 * The writes.
 *
 * Three ordering decisions, each of which is wrong the obvious way round:
 *
 * 1. THE RECEIPT IS WRITTEN LAST. If it went first and the copy then failed,
 *    the receipt would vouch for bytes that were never written — a signed
 *    statement about content that does not exist. Written last, a crash leaves
 *    baselines that no receipt covers, which the honesty check reports as
 *    `unreceipted-baseline`. Loud and wrong beats quiet and wrong.
 *
 * 2. EACH FILE IS WRITTEN VIA A TEMP + RENAME IN THE SAME DIRECTORY. A partial
 *    write of a snapshot is a file that is neither the old behaviour nor the
 *    new one, and its sha matches nothing, so it would be unreceipted forever.
 *
 * 3. THE RECEIPT RECORDS THE SHA OF THE BYTES ACTUALLY WRITTEN, not the sha the
 *    run report claimed. The guard already proved they agree; hashing the real
 *    bytes means the receipt cannot drift from the file even if that guard is
 *    ever weakened.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import type { AcceptMode, ReceiptEntry, RepoPath, Sha } from '../types.js';
import { isTrusted } from '../types.js';
import { sha256 } from '../git/index.js';
import type { AcceptedFile, Candidate, TargetPlan } from './model.js';
import { GITATTRIBUTES_BASENAME, GITATTRIBUTES_CONTENT, RECEIPT_BASENAME } from './model.js';
import type { PruneProbe, ReceiptSourceContext, StoredReceipt } from './receipt.js';
import {
  TOOL_VERSION,
  emptyReceiptFile,
  parseReceiptFile,
  pruneReceipts,
  serializeReceiptFile,
  withId,
} from './receipt.js';

export interface ApplyTargetInput {
  readonly plan: TargetPlan;
  /** The subset the reviewer (or `--yes`) said yes to. */
  readonly accepted: readonly Candidate[];
  readonly rejected: number;
  readonly skipped: number;
  readonly mode: AcceptMode;
  readonly acceptedBy: string;
  readonly reason: string;
  readonly baseSha: Sha;
  readonly headSha: Sha;
  readonly unverifiedProducer: boolean;
  /** Bootstrap only: the agreeing doctor run digests. */
  readonly doctorRuns: readonly string[] | null;
  readonly acceptDeletionsDeclared: number | null;
  /** Probe used to prune receipts that the base tree now vouches for. */
  readonly probe: PruneProbe;
  readonly repoRoot: string;
}

export interface ApplyTargetResult {
  readonly receipt: StoredReceipt | null;
  readonly receiptPath: RepoPath | null;
  readonly files: readonly AcceptedFile[];
  /** Non-snapshot files accept created, e.g. a bootstrap `.gitattributes`. */
  readonly extraPaths: readonly RepoPath[];
  readonly prunedReceipts: readonly string[];
}

function toRepoPath(repoRoot: string, abs: string): RepoPath {
  return relative(repoRoot, abs).split(sep).join('/');
}

async function writeAtomic(abs: string, data: Buffer | string): Promise<void> {
  await fs.mkdir(dirname(abs), { recursive: true });
  // Same directory, so the rename is atomic — a cross-device rename would fall
  // back to a copy and reintroduce the partial-write window this avoids.
  const tmp = `${abs}.vibes-tmp-${process.pid.toString(36)}${Date.now().toString(36)}`;
  await fs.writeFile(tmp, data);
  try {
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** Remove directories emptied by a deletion, stopping at the baseline dir. */
async function pruneEmptyDirs(fileAbs: string, stopAt: string): Promise<void> {
  let dir = dirname(fileAbs);
  while (dir.startsWith(stopAt) && dir !== stopAt) {
    try {
      await fs.rmdir(dir);
    } catch {
      return; // not empty, or gone — either way we are done climbing
    }
    dir = dirname(dir);
  }
}

export async function applyTarget(input: ApplyTargetInput): Promise<ApplyTargetResult> {
  const { plan, accepted, repoRoot } = input;
  const target = plan.target;
  const entries: ReceiptEntry[] = [];
  const deletions: { file: string; previousSha256: string | null }[] = [];
  const files: AcceptedFile[] = [];

  for (const c of accepted) {
    if (c.action === 'write') {
      if (c.absReceived === null) continue;
      const bytes = await fs.readFile(c.absReceived);
      await writeAtomic(c.absBaseline, bytes);
      const sha = sha256(bytes);
      entries.push({
        file: c.file,
        sha256: sha,
        previousSha256: c.baselineSha256,
        verdict: c.verdict.kind,
      });
      files.push({
        component: c.component,
        producer: c.producer,
        file: c.file,
        repoPath: c.repoPath,
        action: 'write',
        sha256: sha,
        previousSha256: c.baselineSha256,
      });
    } else {
      await fs.rm(c.absBaseline, { force: true });
      await pruneEmptyDirs(c.absBaseline, target.baselineDir);
      deletions.push({ file: c.file, previousSha256: c.baselineSha256 });
      files.push({
        component: c.component,
        producer: c.producer,
        file: c.file,
        repoPath: c.repoPath,
        action: 'delete',
        sha256: null,
        previousSha256: c.baselineSha256,
      });
    }
  }

  if (files.length === 0) {
    // Nothing moved, so nothing to vouch for. Writing an empty receipt would
    // add a diff hunk that says "I ran the tool", which is noise.
    return { receipt: null, receiptPath: null, files: [], extraPaths: [], prunedReceipts: [] };
  }

  const extraPaths: RepoPath[] = [];
  if (input.mode === 'bootstrap') {
    const attrAbs = join(target.baselineDir, GITATTRIBUTES_BASENAME);
    if (!(await exists(attrAbs))) {
      await writeAtomic(attrAbs, GITATTRIBUTES_CONTENT);
      extraPaths.push(toRepoPath(repoRoot, attrAbs));
    }
  }

  const changed = plan.candidates.length;
  const sourceContext: ReceiptSourceContext = {
    changedWitnessPaths: [...target.changedWitnessPaths],
    corpusChangedPaths: [...target.corpusChangedPaths],
    exercisedWitnessPaths: [...target.exercisedWitnessPaths],
  };

  const receipt = withId({
    version: 1,
    toolVersion: TOOL_VERSION,
    component: target.component,
    producer: target.producer,
    mode: input.mode,
    acceptedBy: input.acceptedBy,
    reason: input.reason,
    baseSha: input.baseSha,
    headSha: input.headSha,
    // Refusal 2 guarantees this is 'ok'. Recorded anyway, because a receipt
    // claiming otherwise is then one grep away rather than unprovable.
    producerOutcome: target.outcome,
    producerTrust: isTrusted(target.outcome),
    ciJob: target.ciJob,
    producerEverCIVerified: target.everCIVerified,
    entries,
    counts: {
      changed,
      accepted: files.length,
      skippedEquivalent: plan.skippedEquivalent.length,
      added: entries.filter((e) => e.verdict === 'added').length,
      deleted: deletions.length,
      // Rounded so the same acceptance always serialises to the same bytes.
      acceptRatio: changed === 0 ? 0 : Math.round((files.length / changed) * 10000) / 10000,
    },
    ...(input.unverifiedProducer ? { unverifiedProducer: true } : {}),
    ...(input.doctorRuns !== null ? { doctorRuns: [...input.doctorRuns] } : {}),
    ...(deletions.length > 0 ? { deletions } : {}),
    ...(input.acceptDeletionsDeclared !== null
      ? { acceptDeletionsDeclared: input.acceptDeletionsDeclared }
      : {}),
    ...(input.mode === 'reviewed'
      ? { reviewed: { rejected: input.rejected, skipped: input.skipped } }
      : {}),
    sourceContext,
  });

  const receiptAbs = join(target.baselineDir, RECEIPT_BASENAME);
  const existing = await readReceipts(receiptAbs, target.component, target.producer);
  const pruned = pruneReceipts(
    existing.receipts.filter((r) => r.id !== receipt.id),
    input.probe,
  );
  const file = {
    ...existing,
    receipts: [...pruned.kept, receipt],
  };
  await writeAtomic(receiptAbs, serializeReceiptFile(file));

  return {
    receipt,
    receiptPath: toRepoPath(repoRoot, receiptAbs),
    files,
    extraPaths,
    prunedReceipts: pruned.dropped,
  };
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * A malformed receipt file is a HARD ERROR, never an empty list.
 *
 * Reading it as "no receipts" would make corrupting the file the cheapest way
 * to erase an audit trail: mangle the JSON, accept again, and the previous
 * statements are silently gone.
 */
export class ReceiptFileCorruptError extends Error {
  constructor(
    readonly path: string,
    readonly problems: readonly string[],
  ) {
    super(`${path} is not a valid receipt file:\n  ${problems.join('\n  ')}`);
    this.name = 'ReceiptFileCorruptError';
  }
}

export async function readReceipts(
  absPath: string,
  component: string,
  producer: string,
): Promise<{ schema: string; component: string; producer: string; receipts: StoredReceipt[] }> {
  let text: string;
  try {
    text = await fs.readFile(absPath, 'utf8');
  } catch {
    const empty = emptyReceiptFile(component, producer);
    return { ...empty, receipts: [] };
  }
  const parsed = parseReceiptFile(text);
  if (parsed.file === null) throw new ReceiptFileCorruptError(absPath, parsed.errors);
  return { ...parsed.file, receipts: [...parsed.file.receipts] };
}
