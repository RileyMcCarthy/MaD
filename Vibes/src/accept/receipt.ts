/**
 * The receipt — the actual guardrail.
 *
 * The honesty check recomputes sha256 of every committed baseline file and
 * cross-checks it against the union of receipts in that out dir plus the
 * content at `<base>`. Three outcomes: matches base (unchanged), matches a
 * receipt entry (accepted, and the receipt says HOW), matches neither
 * (`unreceipted-baseline`, error). So `git add -A && git commit` cannot launder
 * a snapshot change, and hand-editing one fails the same way.
 *
 * Three decisions here are not the obvious implementation:
 *
 * 1. THE FILE IS A LOG, NOT A SINGLE RECEIPT. A branch with two accepting
 *    commits needs both receipts alive: after the second accept, the first
 *    batch's bytes still differ from `<base>` and nothing else vouches for
 *    them. Overwriting would turn every multi-commit branch into a wall of
 *    `unreceipted-baseline` errors, and the first person to hit that would
 *    delete the check rather than debug it.
 *
 * 2. RECEIPT IDS ARE CONTENT-DERIVED, NOT RANDOM. insta's `assertion_line`
 *    lesson: a volatile header field produces pure diff churn and gets removed
 *    later anyway. A deterministic id also makes a re-accept of unchanged
 *    content a no-op instead of a diff.
 *
 * 3. NO TIMESTAMP, NO HOSTNAME, NO ABSOLUTE PATHS. Same reason. Everything the
 *    receipt records is a claim about content, not about a machine.
 */

import type {
  ComponentId,
  Finding,
  Outcome,
  ProducerName,
  Receipt,
  ReceiptEntry,
  RepoPath,
  Severity,
  Trust,
} from '../types.js';
import { sha256 } from '../git/index.js';
import { RECEIPT_SCHEMA, targetId } from './model.js';

/**
 * Recorded so a receipt says which tool wrote it.
 *
 * Deliberately NOT read from package.json at runtime: that is an fs read in the
 * middle of the one code path that must be side-effect-free until it commits,
 * and a bundled tool has no package.json beside it. It changes at most once per
 * release, so the drift risk is a release-checklist item, not a runtime one.
 */
export const TOOL_VERSION = '0.1.0';

/* ─────────────────────────── stored shapes ───────────────────────────── */

/**
 * A baseline file the accept REMOVED.
 *
 * Deliberately not a `ReceiptEntry`: that shape requires a non-null `sha256`,
 * and a deleted file has no content to hash. A sentinel sha would be a lie the
 * honesty scan could match against. Deletions live in their own array, which
 * also makes "how many files did this accept remove" greppable.
 */
export interface ReceiptDeletion {
  readonly file: string;
  readonly previousSha256: string | null;
}

/**
 * What the diff looked like at the moment of acceptance. Feeds §5.7.
 *
 * This is evidence a later run cannot reconstruct: once the accept is
 * committed, the next run's diff is against a different base and the branch's
 * own history has to be replayed to recover what changed when. Recording it
 * costs a few path strings and makes `accept-without-source-change` checkable
 * from the receipt alone.
 */
export interface ReceiptSourceContext {
  /** Changed source matching this component's `witnesses` — the CLAIMED set. */
  readonly changedWitnessPaths: readonly RepoPath[];
  /** Changed source that is this producer's INPUT corpus. Authorises deletions. */
  readonly corpusChangedPaths: readonly RepoPath[];
  /** `ComponentResult.exercisedWitnessPaths` — a producer ran and output moved. */
  readonly exercisedWitnessPaths: readonly RepoPath[];
}

/**
 * `Receipt` from the contract, plus the fields the contract has no slot for.
 * Flagged for the integration pass: `deletions`, `sourceContext`, `reviewed`,
 * `acceptDeletionsDeclared` and the producer-trust block would all move cleanly
 * into `types.ts`.
 *
 * `counts` is widened, not replaced: the intersection stays assignable to
 * `Receipt['counts']`, so a `Receipt` consumer reads the four fields it knows
 * and ignores the two it does not.
 */
export interface StoredReceipt extends Receipt {
  readonly schema?: string;
  readonly toolVersion?: string;
  readonly counts: Receipt['counts'] & {
    readonly added?: number;
    readonly deleted?: number;
  };
  readonly deletions?: readonly ReceiptDeletion[];
  readonly sourceContext?: ReceiptSourceContext;
  /** Interactive review outcomes. Absent for `bulk`. */
  readonly reviewed?: { readonly rejected: number; readonly skipped: number };
  /** The number the operator typed into `--accept-deletions`. */
  readonly acceptDeletionsDeclared?: number;
  /** The producer's execution outcome. Refusal 2 means this is always `'ok'`
   *  at write time; it is recorded anyway so a hand-edited receipt claiming
   *  otherwise is greppable. */
  readonly producerOutcome?: Outcome;
  readonly producerTrust?: Trust;
  readonly ciJob?: string | null;
  readonly producerEverCIVerified?: boolean;
}

export interface ReceiptFile {
  readonly schema: string;
  readonly component: ComponentId;
  readonly producer: ProducerName;
  /** Append order, oldest first. */
  readonly receipts: readonly StoredReceipt[];
}

/* ────────────────────────── canonical encoding ───────────────────────── */

/**
 * Key-sorted JSON with a trailing newline.
 *
 * Every accept of the same content must produce byte-identical output, or the
 * receipt itself becomes diff noise and reviewers learn to skip it — which
 * defeats the only mechanism this module has.
 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      const v = src[k];
      if (v === undefined) continue;
      out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Content-derived id. Stable across re-runs, unique per accepted batch. */
export function receiptId(receipt: Omit<StoredReceipt, 'id'>): string {
  const body = canonicalJson(receipt);
  return `r${sha256(Buffer.from(body, 'utf8')).slice(0, 16)}`;
}

export function withId(receipt: Omit<StoredReceipt, 'id'>): StoredReceipt {
  return { ...receipt, id: receiptId(receipt) } as StoredReceipt;
}

/* ─────────────────────────────── parsing ─────────────────────────────── */

export interface ParsedReceiptFile {
  readonly file: ReceiptFile | null;
  readonly errors: readonly string[];
}

/**
 * Defensive by construction: this file is committed, so a human or an agent
 * may have hand-edited it into anything. A malformed receipt file must not
 * crash accept — but it must not silently read as "no receipts" either, or
 * corrupting it would become the cheapest way to erase the audit trail. The
 * caller treats a non-empty `errors` as a hard stop.
 */
export function parseReceiptFile(text: string): ParsedReceiptFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    return { file: null, errors: [`not valid JSON: ${(err as Error).message}`] };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { file: null, errors: ['expected a JSON object at the top level'] };
  }
  const o = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (o['schema'] !== RECEIPT_SCHEMA) {
    errors.push(`expected "schema": ${JSON.stringify(RECEIPT_SCHEMA)}, got ${JSON.stringify(o['schema'])}`);
  }
  const component = typeof o['component'] === 'string' ? o['component'] : '';
  const producer = typeof o['producer'] === 'string' ? o['producer'] : '';
  if (component === '') errors.push('missing "component"');
  if (producer === '') errors.push('missing "producer"');

  const rawReceipts = o['receipts'];
  const receipts: StoredReceipt[] = [];
  if (!Array.isArray(rawReceipts)) {
    errors.push('missing "receipts" array');
  } else {
    rawReceipts.forEach((r, i) => {
      const parsed = parseOne(r, i, errors);
      if (parsed !== null) receipts.push(parsed);
    });
  }
  if (errors.length > 0) return { file: null, errors };
  return { file: { schema: RECEIPT_SCHEMA, component, producer, receipts }, errors: [] };
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const MODES: ReadonlySet<string> = new Set(['reviewed', 'bulk', 'bootstrap']);

/**
 * Validated exactly as strictly as the honesty check validates it.
 *
 * Any receipt this parser accepts but the honesty check rejects would land in
 * the PR as an `invalid-receipt` error the operator has no way to have seen
 * coming, and any receipt this parser rejects but honesty accepts would make
 * accept unusable on a tree that is in fact fine. Two validators that disagree
 * about the same file are worse than either one alone.
 */
function parseOne(raw: unknown, index: number, errors: string[]): StoredReceipt | null {
  const at = `receipts[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${at} is not an object`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const str = (k: string): string | null => (typeof r[k] === 'string' ? (r[k] as string) : null);

  const id = str('id');
  const mode = str('mode');
  const reason = str('reason');
  if (id === null || id === '') errors.push(`${at}.id is missing`);
  if (r['version'] !== 1) errors.push(`${at}.version must be 1`);
  if (str('component') === null) errors.push(`${at}.component is missing`);
  if (str('producer') === null) errors.push(`${at}.producer is missing`);
  if (str('acceptedBy') === null) errors.push(`${at}.acceptedBy is missing`);
  if (str('baseSha') === null) errors.push(`${at}.baseSha is missing`);
  if (str('headSha') === null) errors.push(`${at}.headSha is missing`);
  if (mode === null || !MODES.has(mode)) {
    errors.push(`${at}.mode must be reviewed | bulk | bootstrap`);
  } else if (mode !== 'reviewed' && (reason === null || reason.trim() === '')) {
    // The one field the whole guardrail rests on. An unreviewed accept with no
    // stated cause is unattributable, so it is rejected rather than recorded.
    errors.push(`${at}.mode is "${mode}" and requires a non-empty reason`);
  }

  const entriesRaw = r['entries'];
  const entries: ReceiptEntry[] = [];
  if (!Array.isArray(entriesRaw)) {
    errors.push(`${at}.entries is missing`);
    return null;
  }
  for (const [j, e] of entriesRaw.entries()) {
    const eat = `${at}.entries[${j}]`;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      errors.push(`${eat} is not an object`);
      continue;
    }
    const eo = e as Record<string, unknown>;
    const file = typeof eo['file'] === 'string' ? eo['file'] : null;
    const sha = typeof eo['sha256'] === 'string' ? eo['sha256'] : null;
    const prev = typeof eo['previousSha256'] === 'string' ? eo['previousSha256'] : null;
    const verdict = typeof eo['verdict'] === 'string' ? eo['verdict'] : null;
    if (file === null || file === '') {
      errors.push(`${eat}.file is missing`);
      continue;
    }
    // A digest that is not 64 hex characters vouches for nothing but would be
    // compared against a real sha256 forever, silently never matching.
    if (sha === null || !SHA256_RE.test(sha)) {
      errors.push(`${eat}.sha256 is not a 64-hex digest`);
      continue;
    }
    if (prev !== null && prev !== '' && !SHA256_RE.test(prev)) {
      errors.push(`${eat}.previousSha256 is not a 64-hex digest`);
      continue;
    }
    entries.push({
      file,
      sha256: sha,
      previousSha256: prev === '' ? null : prev,
      verdict: (verdict ?? 'different') as ReceiptEntry['verdict'],
    });
  }
  // The rest is carried through verbatim: a receipt written by a newer Vibes
  // must survive a round trip through an older one unchanged, or upgrading the
  // tool would silently drop other people's audit records.
  return { ...(r as unknown as StoredReceipt), entries };
}

export function emptyReceiptFile(component: ComponentId, producer: ProducerName): ReceiptFile {
  return { schema: RECEIPT_SCHEMA, component, producer, receipts: [] };
}

export function serializeReceiptFile(file: ReceiptFile): string {
  return canonicalJson({
    schema: file.schema,
    component: file.component,
    producer: file.producer,
    receipts: file.receipts.map((r) => ({
      ...r,
      entries: [...r.entries].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
    })),
  });
}

/* ─────────────────────────────── vouching ────────────────────────────── */

/** The receipt id vouching for this content, or null. Used by the honesty check. */
export function vouchesFor(
  receipts: readonly StoredReceipt[],
  file: string,
  sha256Hex: string,
): string | null {
  // Newest first: the most recent statement about a file is the operative one.
  for (let i = receipts.length - 1; i >= 0; i -= 1) {
    const r = receipts[i];
    if (r === undefined) continue;
    for (const e of r.entries) {
      if (e.file === file && e.sha256 === sha256Hex) return r.id;
    }
  }
  return null;
}

export interface PruneProbe {
  /** sha256 of this file's content at `<base>`, or null when absent there. */
  baseSha256(file: string): string | null;
  /** sha256 of the file in the baseline dir RIGHT NOW, or null if absent.
   *  Evaluated lazily, because pruning runs after this accept's own writes. */
  currentSha256(file: string): string | null;
}

/**
 * Drop receipts that have stopped doing work.
 *
 * An entry is LOAD-BEARING when it vouches for bytes that are actually on disk
 * and that `<base>` does not already carry. A receipt with no load-bearing
 * entry cannot possibly be the thing standing between a baseline file and an
 * `unreceipted-baseline` error, because nothing it names both exists and needs
 * vouching for.
 *
 * Both halves of that predicate matter, and the obvious one-sided versions are
 * wrong in opposite directions:
 *
 * - Dropping on "base carries these bytes" alone keeps a receipt whose files
 *   were long ago superseded by a later accept, so the log grows forever and
 *   the audit trail becomes a wall nobody reads.
 * - Dropping on "the file exists" alone drops a receipt still vouching for
 *   content the base does not have, which MANUFACTURES an `unreceipted-baseline`
 *   error out of nothing. That is precisely the false positive that gets a
 *   check disabled.
 *
 * A file that reads as absent drops its entry rather than keeping it: the
 * content scan enumerates files that EXIST, so no receipt about a missing one
 * can be standing between anything and an error. (A deletion is vouched for by
 * the `deletions` array, which pruning never consults.)
 */
export function pruneReceipts(
  receipts: readonly StoredReceipt[],
  probe: PruneProbe,
): { kept: readonly StoredReceipt[]; dropped: readonly string[] } {
  const kept: StoredReceipt[] = [];
  const dropped: string[] = [];
  for (const r of receipts) {
    const stillWorking = r.entries.some((e) => {
      const now = probe.currentSha256(e.file);
      if (now === null) return false; // the file is gone; nothing can match it
      if (now !== e.sha256) return false; // superseded by later content
      return probe.baseSha256(e.file) !== e.sha256; // base already vouches?
    });
    if (stillWorking) kept.push(r);
    else dropped.push(r.id);
  }
  return { kept, dropped };
}

/* ─────────────────────────────── findings ────────────────────────────── */

export interface ReceiptFindingOptions {
  /** Under `strict` (i.e. CI) the soft findings become errors. */
  readonly strict?: boolean;
}

/**
 * The report-side consequences of a receipt.
 *
 * `bulk-accept` is `alwaysExpanded` on purpose: a blind `--all --yes` is
 * allowed, and the entire deal is that it is impossible to miss. Collapsing it
 * into a `<details>` would quietly reverse that trade.
 *
 * These are the TERMINAL echo, printed the moment an accept lands so the
 * operator sees what they just signed. The honesty check re-derives the same
 * findings from the COMMITTED receipt and the real diff, which is the version
 * that reaches the report — it must, because a receipt an agent hand-wrote
 * never passes through this function at all. Do not feed these into the report
 * as well or every signal renders twice.
 */
export function findingsForReceipt(
  r: StoredReceipt,
  options: ReceiptFindingOptions = {},
): readonly Finding[] {
  const strict = options.strict ?? false;
  const hard: Severity = strict ? 'error' : 'warn';
  const id = targetId({ component: r.component, producer: r.producer });
  const out: Finding[] = [];
  const ratio = r.counts.acceptRatio;

  if (r.mode === 'bulk') {
    out.push({
      id: `bulk-accept:${id}:${r.id}`,
      severity: hard,
      title: `Bulk-accepted ${r.counts.accepted} of ${r.counts.changed} moved snapshots in ${id}`,
      detail:
        `Accepted non-interactively (\`acceptedBy: ${r.acceptedBy}\`, acceptRatio ` +
        `${ratio.toFixed(2)}). No file was reviewed individually. Stated reason: ` +
        `${r.reason.trim() === '' ? '(none)' : JSON.stringify(r.reason)}.`,
      component: r.component,
      alwaysExpanded: true,
    });
  }

  if (r.mode === 'bootstrap') {
    out.push({
      id: `bootstrap:${id}:${r.id}`,
      severity: 'info',
      title: `Bootstrapped ${r.counts.accepted} baseline files for ${id}`,
      detail:
        `First baselines for this producer. They were not compared against ` +
        `anything — they ARE the comparison from now on. Determinism was ` +
        `attested by ${r.doctorRuns?.length ?? 0} agreeing doctor runs. ` +
        `Stated reason: ${JSON.stringify(r.reason)}.`,
      component: r.component,
      alwaysExpanded: true,
    });
  }

  // §5.7 — the cheapest real defence in the design: a lot of behaviour was
  // accepted while nothing this producer claims to cover changed. That is the
  // signature of "regenerate until green", and it needs no coverage data.
  //
  // ABSENT `sourceContext` is not the same as an EMPTY one, and collapsing the
  // two would make every receipt written before this field existed — or by a
  // different tool — read as an accusation. Unknown means silent.
  const witnessed = r.sourceContext?.changedWitnessPaths ?? null;
  if (ratio > 0.5 && witnessed !== null && witnessed.length === 0 && r.mode !== 'bootstrap') {
    out.push({
      id: `accept-without-source-change:${id}:${r.id}`,
      severity: hard,
      title: `${id}: ${r.counts.accepted} snapshots accepted with no witnessed source change`,
      detail:
        `acceptRatio ${ratio.toFixed(2)} while no path matching this component's ` +
        `\`witnesses\` changed in this diff. Either the producer is ` +
        `nondeterministic, or the behaviour moved for a reason nothing in the ` +
        `manifest claims to cover.`,
      component: r.component,
      alwaysExpanded: true,
    });
  }

  if (r.unverifiedProducer === true) {
    out.push({
      id: `never-ci-verified:${id}:${r.id}`,
      severity: 'warn',
      title: `${id} has never completed in CI, and its baselines were accepted anyway`,
      detail:
        `Accepted with \`--unverified-producer\`. These baselines are ` +
        `locally-accepted and never CI-verified: nothing has demonstrated that ` +
        `this producer reproduces them on another machine.`,
      component: r.component,
      alwaysExpanded: true,
    });
  }

  const deletions = r.deletions ?? [];
  if (deletions.length > 0) {
    // The `corpus-shr` id prefix is load-bearing: `emit/` routes findings whose
    // id starts with governance|policy|weaken|corpus-shr|unreceipted into the
    // policy section, which renders ABOVE behaviour. A shrinking corpus
    // explains away every "verified-unchanged" below it, so that is where it
    // belongs.
    out.push({
      id: `corpus-shrank:${id}:${r.id}`,
      severity: 'warn',
      title: `${id}: ${deletions.length} baseline files were deleted by accept`,
      detail:
        `Authorised with \`--accept-deletions=${r.acceptDeletionsDeclared ?? deletions.length}\`. ` +
        `Stated reason: ${JSON.stringify(r.reason)}.`,
      component: r.component,
      paths: deletions.map((d) => d.file),
      alwaysExpanded: true,
    });
  }

  return out;
}
