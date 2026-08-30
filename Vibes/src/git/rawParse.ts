/**
 * Parsers for git's byte-framed plumbing output.
 *
 * These are separated from the commands that produce them so every format can
 * be unit-tested against captured bytes, without a repo. Each parser is strict:
 * a shape it does not recognise throws rather than yielding a plausible-looking
 * empty result, because "no changes" is exactly the lie this tool exists to
 * prevent.
 */

import type { DiffEntry, RepoPath, Sha } from '../types.js';

/** Tree entry mode for a submodule pin. */
export const GITLINK_MODE = '160000';
/** git prints this for "no object" on either side of a raw diff record. */
export const NULL_OID = '0000000000000000000000000000000000000000';

export interface RawDiffEntry extends DiffEntry {
  readonly srcMode: string;
  readonly dstMode: string;
  readonly srcOid: Sha;
  readonly dstOid: Sha;
  /** Rename/copy similarity 0..100, or null for every other status. */
  readonly score: number | null;
}

export interface RawDiffParse {
  readonly entries: readonly RawDiffEntry[];
  /**
   * Status `U` rows. A tree mid-conflict cannot be measured; callers surface
   * this rather than quietly diffing half a merge.
   */
  readonly unmerged: readonly RepoPath[];
  /** Status `X` rows — "unknown", a git bug marker. Never silently dropped. */
  readonly unknown: readonly RepoPath[];
}

const RAW_META_RE =
  /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d{1,3})?$/;

/**
 * Parse `git diff --raw -z --abbrev=40` output.
 *
 * Framing (VERIFIED, git 2.49): `:<srcmode> <dstmode> <srcsha> <dstsha> <status>`
 * NUL `<path>` NUL — and for R/C, NUL `<src>` NUL `<dst>` NUL. In non-`-z` mode
 * the meta record is TAB-separated from the path; with `-z` it is NUL. Mixing
 * the two up yields paths with a leading tab that match nothing.
 */
export function parseRawDiffZ(buf: Buffer): RawDiffParse {
  const fields = buf.toString('utf8').split('\0');
  // The stream ends with a NUL, producing one trailing empty field.
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();

  const entries: RawDiffEntry[] = [];
  const unmerged: RepoPath[] = [];
  const unknown: RepoPath[] = [];

  let i = 0;
  while (i < fields.length) {
    const meta = fields[i];
    if (meta === undefined) break;
    if (meta.startsWith('::')) {
      // Combined diff (a merge commit diffed against both parents). Vibes
      // always diffs against exactly one base, so this means the caller built
      // the wrong command; reading it as a normal record would misassign paths.
      throw new Error(
        'combined diff output encountered; Vibes always diffs against a single base',
      );
    }
    const m = RAW_META_RE.exec(meta);
    if (m === null) {
      throw new Error(`unparseable raw diff record: ${JSON.stringify(meta)}`);
    }
    const srcMode = m[1] as string;
    const dstMode = m[2] as string;
    const srcOid = m[3] as string;
    const dstOid = m[4] as string;
    const status = m[5] as string;
    const scoreRaw = m[6];
    const score = scoreRaw === undefined ? null : Number(scoreRaw);

    const takesTwoPaths = status === 'R' || status === 'C';
    const need = takesTwoPaths ? 2 : 1;
    const p1 = fields[i + 1];
    const p2 = takesTwoPaths ? fields[i + 2] : undefined;
    if (p1 === undefined || (takesTwoPaths && p2 === undefined)) {
      throw new Error(
        `truncated raw diff: status ${status} needs ${String(need)} path field(s)`,
      );
    }
    i += 1 + need;

    if (status === 'U') {
      unmerged.push(takesTwoPaths ? (p2 as string) : p1);
      continue;
    }
    if (status === 'X') {
      unknown.push(takesTwoPaths ? (p2 as string) : p1);
      continue;
    }
    if (
      status !== 'A' &&
      status !== 'M' &&
      status !== 'D' &&
      status !== 'R' &&
      status !== 'C' &&
      status !== 'T'
    ) {
      throw new Error(`unsupported raw diff status ${JSON.stringify(status)}`);
    }

    const path = takesTwoPaths ? (p2 as string) : p1;
    const from = takesTwoPaths ? p1 : undefined;
    const isGitlink = srcMode === GITLINK_MODE || dstMode === GITLINK_MODE;

    entries.push({
      status,
      path,
      ...(from !== undefined ? { from } : {}),
      // A gitlink row carries the two pinned commits and no in-repo content.
      // Enrichment happens in submodule.ts; the sha pair is captured here so a
      // pin bump can never render as an opaque one-line blob change.
      ...(isGitlink ? { submodule: { base: srcOid, head: dstOid } } : {}),
      srcMode,
      dstMode,
      srcOid,
      dstOid,
      score,
    });
  }

  return { entries, unmerged, unknown };
}

export interface LsTreeEntry {
  readonly mode: string;
  readonly type: 'blob' | 'tree' | 'commit' | 'tag';
  readonly oid: Sha;
  readonly path: RepoPath;
}

/**
 * Parse `git ls-tree -r -z <rev>` default output.
 *
 * Framing (VERIFIED): `<mode> SP <type> SP <oid> TAB <path>` NUL. The default
 * format is used rather than `--format=`, which needs git >= 2.36, and rather
 * than `--name-only`, which throws away the mode — and the mode is how a
 * gitlink is recognised.
 */
export function parseLsTreeZ(buf: Buffer): LsTreeEntry[] {
  const out: LsTreeEntry[] = [];
  const fields = buf.toString('utf8').split('\0');
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
  for (const field of fields) {
    if (field === '') continue;
    const tab = field.indexOf('\t');
    if (tab < 0) throw new Error(`unparseable ls-tree record: ${JSON.stringify(field)}`);
    const head = field.slice(0, tab);
    const path = field.slice(tab + 1);
    const bits = head.split(' ');
    const mode = bits[0];
    const type = bits[1];
    const oid = bits[2];
    if (mode === undefined || type === undefined || oid === undefined) {
      throw new Error(`unparseable ls-tree header: ${JSON.stringify(head)}`);
    }
    if (type !== 'blob' && type !== 'tree' && type !== 'commit' && type !== 'tag') {
      throw new Error(`unexpected ls-tree object type ${JSON.stringify(type)}`);
    }
    out.push({ mode, type, oid, path });
  }
  return out;
}

export interface CheckIgnoreRule {
  readonly path: RepoPath;
  readonly source: string;
  readonly line: number;
  readonly pattern: string;
  /** A `!`-prefixed pattern. `check-ignore -v` exits 0 for these too, which is
   *  why its exit status can never be the decision. */
  readonly negated: boolean;
}

/**
 * Parse `git check-ignore -v -z --stdin` output.
 *
 * Framing (VERIFIED): `<source>` NUL `<linenum>` NUL `<pattern>` NUL `<path>` NUL.
 * A path with no matching pattern is simply absent (we never pass
 * `--non-matching`).
 */
export function parseCheckIgnoreVerboseZ(buf: Buffer): CheckIgnoreRule[] {
  const fields = buf.toString('utf8').split('\0');
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
  if (fields.length % 4 !== 0) {
    throw new Error(
      `check-ignore -v -z produced ${String(fields.length)} fields, not a multiple of 4`,
    );
  }
  const out: CheckIgnoreRule[] = [];
  for (let i = 0; i < fields.length; i += 4) {
    const source = fields[i] as string;
    const lineRaw = fields[i + 1] as string;
    const pattern = fields[i + 2] as string;
    const path = fields[i + 3] as string;
    out.push({
      path,
      source,
      line: Number(lineRaw),
      pattern,
      negated: pattern.startsWith('!'),
    });
  }
  return out;
}

/**
 * Parse `git cat-file --batch` output into oid -> contents.
 *
 * Framing: `<oid> SP <type> SP <size>` LF `<contents>` LF, or `<oid> missing` LF.
 * Scanned over the raw Buffer because `<contents>` is arbitrary bytes: decoding
 * first would corrupt every binary blob and desynchronise the byte offsets the
 * `<size>` field indexes.
 */
export function parseCatFileBatch(buf: Buffer): Map<Sha, Buffer | null> {
  const out = new Map<Sha, Buffer | null>();
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) throw new Error('truncated cat-file --batch header');
    const header = buf.toString('utf8', pos, nl);
    pos = nl + 1;
    const parts = header.split(' ');
    const oid = parts[0];
    if (oid === undefined) throw new Error('empty cat-file --batch header');
    const second = parts[1];
    if (second === 'missing' || second === undefined) {
      out.set(oid, null);
      continue;
    }
    const sizeRaw = parts[2];
    if (sizeRaw === undefined) {
      throw new Error(`unparseable cat-file header: ${JSON.stringify(header)}`);
    }
    const size = Number(sizeRaw);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`bad cat-file size in ${JSON.stringify(header)}`);
    }
    if (pos + size > buf.length) throw new Error('truncated cat-file --batch body');
    out.set(oid, buf.subarray(pos, pos + size));
    // Body is followed by a single LF that is not part of the object.
    pos += size + 1;
  }
  return out;
}

export interface StatusEntry {
  readonly path: RepoPath;
  /** Index status char, ' ' when unmodified, '?' for untracked. */
  readonly index: string;
  /** Worktree status char. */
  readonly worktree: string;
  /** Set for `R`/`C` rows: the original path. */
  readonly origPath?: RepoPath;
}

/**
 * Parse `git status --porcelain=v1 -z` output.
 *
 * WHY the `-z` form needs its own parser: rename rows emit the two paths as
 * TWO NUL-terminated fields (`XY path` NUL `origpath` NUL), and in `-z` mode
 * the order is reversed relative to the human-readable `->` form. Reading it
 * as one field per entry misattributes every rename.
 */
export function parseStatusZ(buf: Buffer): StatusEntry[] {
  const fields = buf.toString('utf8').split('\0');
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
  const out: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === undefined || field === '') continue;
    if (field.length < 4) {
      throw new Error(`unparseable status record: ${JSON.stringify(field)}`);
    }
    const index = field[0] as string;
    const worktree = field[1] as string;
    const path = field.slice(3);
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      const orig = fields[i + 1];
      if (orig === undefined) throw new Error('truncated status rename record');
      i += 1;
      out.push({ path, index, worktree, origPath: orig });
    } else {
      out.push({ path, index, worktree });
    }
  }
  return out;
}

/**
 * git's own binary rule: a NUL byte within the first 8000 bytes.
 * Exposed because every other definition (extension lists, charset sniffing)
 * disagrees with what git will actually do to the file.
 */
export function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, 8000);
  return buf.indexOf(0, 0) >= 0 && buf.indexOf(0, 0) < end;
}
