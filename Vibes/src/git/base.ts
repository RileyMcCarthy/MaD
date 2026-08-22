/**
 * Base resolution.
 *
 * THE RULE THAT DEFINES THIS FILE: there is no fallback to HEAD. A ladder that
 * ends in "well, use HEAD" certifies a fully-changed PR as unchanged, which is
 * the single worst output this tool can produce. When the ladder runs out,
 * `resolveBase` THROWS, and it throws before the first producer is spawned — a
 * run that cannot be compared should not be run at all.
 *
 * Second rule: `base === HEAD` is not an error but it is not a green run
 * either. Pushing to main resolves `merge-base main main` to the tip, which
 * yields a zero-diff, all-verified report about nothing. `sameAsHead` is
 * reported so the caller can force `fullyVerified` false; it is defence in
 * depth against every future bug in the ladder above it, not just this one.
 */

import { readFile } from 'node:fs/promises';

import type { Sha } from '../types.js';
import type { GitCommandRecord } from './exec.js';
import type { GitRepo } from './repo.js';
import { EMPTY_TREE_SHA } from './repo.js';

export type BaseSource =
  | 'explicit-sha'
  | 'explicit-ref'
  /** `HEAD^1` of the synthetic `refs/pull/N/merge` ref. */
  | 'pr-merge-parent'
  /** `github.event.pull_request.base.sha`. */
  | 'pr-base-sha'
  /** `github.event.before`. */
  | 'push-before'
  /** `HEAD^` — a push where `before` is all-zeros, or a tag build. */
  | 'first-parent'
  | 'merge-base'
  /** Unborn HEAD only. Every path reads as added. */
  | 'empty-tree';

/** Deliberately no `degraded` member: see the file header. */
export type BaseConfidence = 'exact' | 'approximate';

export type FetchPolicy = 'always' | 'ci' | 'never';

export interface BaseWarning {
  readonly code: string;
  readonly message: string;
}

export interface LadderStep {
  readonly rung: BaseSource | 'ci-event' | 'ref-candidates' | 'shallow-repair';
  readonly detail: string;
  readonly ok: boolean;
}

export interface BaseResolution {
  readonly sha: Sha;
  readonly source: BaseSource;
  readonly confidence: BaseConfidence;
  readonly requestedRef: string | null;
  readonly resolvedRef: string | null;
  readonly headSha: Sha | null;
  /**
   * HARD GATE. True when the base and HEAD are the same commit — a push to
   * main, a tag build, a re-run on a merged branch. The caller MUST force
   * `fullyVerified: false` and render `no-baseline-range`; there is nothing to
   * compare and "243 verified-unchanged" would be a lie.
   */
  readonly sameAsHead: boolean;
  readonly wasShallow: boolean;
  readonly stillShallow: boolean;
  readonly deepenSteps: readonly number[];
  readonly fetchPerformed: boolean;
  /** The base sits on the graft boundary, so its history is not all present. */
  readonly shallowBoundarySuspect: boolean;
  readonly warnings: readonly BaseWarning[];
  readonly ladder: readonly LadderStep[];
  readonly commands: readonly GitCommandRecord[];
}

export class BaseUnresolvableError extends Error {
  readonly remediation: string;
  readonly ladder: readonly LadderStep[];
  constructor(message: string, ladder: readonly LadderStep[]) {
    super(message);
    this.name = 'BaseUnresolvableError';
    this.ladder = ladder;
    this.remediation =
      'Set `fetch-depth: 0` on the checkout step, or pass an explicit base ' +
      '(`vibes run --base <sha>`, or VIBES_BASE_SHA=${{ github.event.pull_request.base.sha }}). ' +
      'actions/checkout clones at depth 1 by default, so `origin/main` does not exist on the runner.';
  }
}

export interface ResolveBaseOptions {
  readonly repo: GitRepo;
  /** From config. Typically `origin/main`. */
  readonly baseRef: string;
  /** `--base`. Highest precedence; if it does not resolve, that is a hard error. */
  readonly explicit?: string | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Default `'ci'`: deepen/fetch only where the checkout is disposable. */
  readonly allowFetch?: FetchPolicy;
  readonly deepenLadder?: readonly number[];
  readonly allowUnshallow?: boolean;
  /** Abort when the result is not `exact`. Config default is true; the CLI passes it. */
  readonly requireExact?: boolean;
  readonly remote?: string;
  /** Injected for tests; defaults to reading `$GITHUB_EVENT_PATH` as JSON. */
  readonly readEventPayload?: (path: string) => Promise<unknown>;
  readonly recorder?: (record: GitCommandRecord) => void;
}

const ALL_ZEROS = /^0{40}$/;

export async function resolveBase(opts: ResolveBaseOptions): Promise<BaseResolution> {
  const { repo } = opts;
  const env = opts.env ?? process.env;
  const remote = opts.remote ?? 'origin';
  const deepenLadder = opts.deepenLadder ?? [50, 250, 1000];
  const allowUnshallow = opts.allowUnshallow ?? true;
  const fetchPolicy = opts.allowFetch ?? 'ci';

  const warnings: BaseWarning[] = [];
  const ladder: LadderStep[] = [];
  const commands: GitCommandRecord[] = [];
  const deepenSteps: number[] = [];
  let fetchPerformed = false;

  const record = (r: GitCommandRecord): void => {
    commands.push(r);
    opts.recorder?.(r);
  };

  const isCI = truthy(env['CI']) || truthy(env['GITHUB_ACTIONS']);
  const mayFetch = fetchPolicy === 'always' || (fetchPolicy === 'ci' && isCI);

  const headSha = await repo.headSha();
  const wasShallow = await repo.isShallow();

  const finish = async (
    sha: Sha,
    source: BaseSource,
    confidence: BaseConfidence,
    resolvedRef: string | null,
  ): Promise<BaseResolution> => {
    const boundary = await repo.shallowBoundary();
    const suspect = boundary.has(sha);
    if (suspect) {
      warnings.push({
        code: 'base-on-shallow-boundary',
        message:
          `base ${sha.slice(0, 12)} sits on the shallow graft boundary; its own history is ` +
          `absent, so rename and merge-base results below it are unreliable`,
      });
    }
    const effective: BaseConfidence = suspect ? 'approximate' : confidence;
    const sameAsHead = headSha !== null && sha === headSha;
    if (sameAsHead) {
      warnings.push({
        code: 'base-same-as-head',
        message:
          'base and HEAD are the same commit: there is no range to compare, so no ' +
          'snapshot can be reported as verified-unchanged by this run',
      });
    }
    if (opts.requireExact === true && effective !== 'exact') {
      throw new BaseUnresolvableError(
        `base ${sha.slice(0, 12)} resolved only approximately (via ${source}) and ` +
          `base.requireExact is set`,
        ladder,
      );
    }
    return {
      sha,
      source,
      confidence: effective,
      requestedRef: opts.explicit ?? opts.baseRef,
      resolvedRef,
      headSha,
      sameAsHead,
      wasShallow,
      stillShallow: await repo.isShallow(),
      deepenSteps,
      fetchPerformed,
      shallowBoundarySuspect: suspect,
      warnings,
      ladder,
      commands,
    };
  };

  /* ── rung 0: unborn HEAD ───────────────────────────────────────────────── */
  if (headSha === null) {
    ladder.push({
      rung: 'empty-tree',
      detail: 'HEAD is unborn; every path reads as added',
      ok: true,
    });
    return finish(EMPTY_TREE_SHA, 'empty-tree', 'exact', null);
  }

  /* ── rung 1: explicit ──────────────────────────────────────────────────── */
  const explicit =
    opts.explicit ?? env['VIBES_BASE_SHA'] ?? env['VIBES_BASE_REF'] ?? null;
  if (explicit !== null && explicit !== '') {
    const sha = await repo.revParse(`${explicit}^{commit}`);
    if (sha === null) {
      ladder.push({ rung: 'explicit-ref', detail: `${explicit} does not resolve`, ok: false });
      throw new BaseUnresolvableError(
        `explicit base ${JSON.stringify(explicit)} does not resolve to a commit in this ` +
          `clone. Vibes will not silently substitute another base.`,
        ladder,
      );
    }
    const source: BaseSource = /^[0-9a-f]{40}$/.test(explicit)
      ? 'explicit-sha'
      : 'explicit-ref';
    ladder.push({ rung: source, detail: `${explicit} -> ${sha}`, ok: true });
    return finish(sha, source, 'exact', explicit);
  }

  /* ── rung 2/3: the CI event ────────────────────────────────────────────── */
  const eventName = env['GITHUB_EVENT_NAME'] ?? '';
  const eventPath = env['GITHUB_EVENT_PATH'];
  const readEvent =
    opts.readEventPayload ??
    (async (p: string): Promise<unknown> => JSON.parse(await readFile(p, 'utf8')));
  const payload =
    eventPath !== undefined && eventPath !== ''
      ? await readEvent(eventPath).catch((e: unknown) => {
          warnings.push({
            code: 'event-payload-unreadable',
            message: `could not read GITHUB_EVENT_PATH: ${String(e)}`,
          });
          return null;
        })
      : null;

  if (eventName.startsWith('pull_request')) {
    if (wasShallow && mayFetch) {
      await deepen(1);
    }
    const p1 = await repo.revParse('HEAD^1^{commit}');
    const p2 = await repo.revParse('HEAD^2^{commit}');
    // BOTH parents must exist. `HEAD^1` on an ordinary commit is just its
    // parent, so without the `HEAD^2` guard a workflow checking out
    // `pull_request.head.sha` would silently diff against the branch's own
    // previous commit and report one commit's worth of change as the PR.
    if (p1 !== null && p2 !== null) {
      ladder.push({ rung: 'pr-merge-parent', detail: `HEAD^1 = ${p1}`, ok: true });
      return finish(p1, 'pr-merge-parent', 'exact', 'HEAD^1');
    }
    ladder.push({
      rung: 'pr-merge-parent',
      detail:
        p1 === null
          ? 'HEAD has no first parent'
          : 'HEAD^2 missing, so HEAD is not the synthetic merge ref',
      ok: false,
    });

    const baseSha = pickString(payload, ['pull_request', 'base', 'sha']);
    if (baseSha !== null) {
      let resolved = await repo.revParse(`${baseSha}^{commit}`);
      if (resolved === null && mayFetch) {
        await fetchObject(baseSha);
        resolved = await repo.revParse(`${baseSha}^{commit}`);
      }
      if (resolved !== null) {
        ladder.push({ rung: 'pr-base-sha', detail: `event base.sha = ${resolved}`, ok: true });
        warnings.push({
          code: 'base-pr-base-sha',
          message:
            'the merge ref was unavailable, so the PR base tip was used; commits landed on ' +
            'the base branch since the PR forked will appear in this diff',
        });
        return finish(resolved, 'pr-base-sha', 'approximate', 'pull_request.base.sha');
      }
      ladder.push({
        rung: 'pr-base-sha',
        detail: `event base.sha ${baseSha} is not present in this clone`,
        ok: false,
      });
    } else {
      ladder.push({
        rung: 'pr-base-sha',
        detail: 'no pull_request.base.sha in the event payload',
        ok: false,
      });
    }
    // Deliberately NOT falling through to merge-base: against a merge commit,
    // merge-base yields the fork point, so a branch three commits behind main
    // would show the reviewer other people's changes.
    throw new BaseUnresolvableError(
      `pull_request event, but neither the merge ref nor the base sha is present in this clone`,
      ladder,
    );
  }

  if (eventName === 'push' || env['GITHUB_REF_TYPE'] === 'tag') {
    const before = pickString(payload, ['before']);
    if (before !== null && !ALL_ZEROS.test(before)) {
      const sha = await repo.revParse(`${before}^{commit}`);
      if (sha !== null) {
        ladder.push({ rung: 'push-before', detail: `event.before = ${sha}`, ok: true });
        return finish(sha, 'push-before', 'exact', 'github.event.before');
      }
      ladder.push({
        rung: 'push-before',
        detail: `event.before ${before} not present (force-push or shallow clone)`,
        ok: false,
      });
    }
    const parent = await repo.revParse('HEAD^{commit}^');
    if (parent !== null) {
      ladder.push({ rung: 'first-parent', detail: `HEAD^ = ${parent}`, ok: true });
      return finish(parent, 'first-parent', 'exact', 'HEAD^');
    }
    ladder.push({ rung: 'first-parent', detail: 'HEAD has no parent', ok: false });
    return finish(EMPTY_TREE_SHA, 'empty-tree', 'exact', null);
  }

  /* ── rung 4: baseRef -> merge-base ─────────────────────────────────────── */
  const candidates = refCandidates(opts.baseRef, env, remote);
  let refName: string | null = null;
  let refSha: Sha | null = null;
  for (const c of candidates) {
    const sha = await repo.revParse(`${c}^{commit}`);
    if (sha !== null) {
      refName = c;
      refSha = sha;
      break;
    }
  }
  if (refSha === null && mayFetch) {
    const branch = branchOf(opts.baseRef, remote);
    await fetchBranch(remote, branch);
    for (const c of candidates) {
      const sha = await repo.revParse(`${c}^{commit}`);
      if (sha !== null) {
        refName = c;
        refSha = sha;
        break;
      }
    }
  }
  ladder.push({
    rung: 'ref-candidates',
    detail:
      refSha === null
        ? `none of [${candidates.join(', ')}] resolve`
        : `${refName ?? '?'} -> ${refSha}`,
    ok: refSha !== null,
  });
  if (refSha === null) {
    throw new BaseUnresolvableError(
      `base ref ${JSON.stringify(opts.baseRef)} does not resolve in this clone ` +
        `(tried ${candidates.join(', ')})`,
      ladder,
    );
  }

  let mb = await repo.mergeBase(refSha, headSha);
  if (mb === null && (await repo.isShallow())) {
    for (const step of deepenLadder) {
      if (!mayFetch) break;
      await deepen(step);
      mb = await repo.mergeBase(refSha, headSha);
      if (mb !== null) break;
    }
    if (mb === null && allowUnshallow && mayFetch) {
      await unshallow();
      mb = await repo.mergeBase(refSha, headSha);
    }
    ladder.push({
      rung: 'shallow-repair',
      detail: `deepened ${deepenSteps.join(', ')}${allowUnshallow ? ' then --unshallow' : ''}`,
      ok: mb !== null,
    });
  }
  if (mb === null) {
    const shallowNote = (await repo.isShallow())
      ? ' The clone is still shallow.'
      : ' The histories share no common ancestor.';
    throw new BaseUnresolvableError(
      `no merge base between ${refName ?? opts.baseRef} and HEAD.${shallowNote}`,
      ladder,
    );
  }
  ladder.push({ rung: 'merge-base', detail: `merge-base -> ${mb}`, ok: true });
  return finish(mb, 'merge-base', 'exact', refName);

  /* ── helpers that need the closure ─────────────────────────────────────── */

  async function deepen(n: number): Promise<void> {
    const r = await repo.exec(
      ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', `--deepen=${String(n)}`, remote],
      { allowCodes: [0, 1, 128], strictFatal: false, timeoutMs: 300_000 },
    );
    record(recordOf(r.argv, r.code, r.durationMs, r.stderr, repo.repoRoot));
    deepenSteps.push(n);
    fetchPerformed = true;
    if (r.code !== 0) {
      warnings.push({
        code: 'deepen-failed',
        message: `git fetch --deepen=${String(n)} failed: ${firstLine(r.stderr)}`,
      });
    }
  }

  async function unshallow(): Promise<void> {
    const r = await repo.exec(
      ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--unshallow', remote],
      { allowCodes: [0, 1, 128], strictFatal: false, timeoutMs: 900_000 },
    );
    record(recordOf(r.argv, r.code, r.durationMs, r.stderr, repo.repoRoot));
    fetchPerformed = true;
    if (r.code !== 0) {
      warnings.push({
        code: 'unshallow-failed',
        message: `git fetch --unshallow failed: ${firstLine(r.stderr)}`,
      });
    }
  }

  async function fetchBranch(rem: string, branch: string): Promise<void> {
    // No `--depth` here: passing a depth to a COMPLETE clone makes it shallow,
    // which would break every later merge-base. Deepening is a separate step
    // and only runs when the clone is already shallow.
    const r = await repo.exec(
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-recurse-submodules',
        rem,
        `+refs/heads/${branch}:refs/remotes/${rem}/${branch}`,
      ],
      { allowCodes: [0, 1, 128], strictFatal: false, timeoutMs: 300_000 },
    );
    record(recordOf(r.argv, r.code, r.durationMs, r.stderr, repo.repoRoot));
    fetchPerformed = true;
    if (r.code !== 0) {
      warnings.push({
        code: 'fetch-failed',
        message: `git fetch ${rem} ${branch} failed: ${firstLine(r.stderr)}`,
      });
    }
  }

  async function fetchObject(sha: string): Promise<void> {
    const r = await repo.exec(
      ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', remote, sha],
      { allowCodes: [0, 1, 128], strictFatal: false, timeoutMs: 300_000 },
    );
    record(recordOf(r.argv, r.code, r.durationMs, r.stderr, repo.repoRoot));
    fetchPerformed = true;
  }
}

/* ─────────────────────────────── helpers ─────────────────────────────────── */

function recordOf(
  argv: readonly string[],
  code: number,
  durationMs: number,
  stderr: string,
  cwd: string,
): GitCommandRecord {
  return { argv, cwd, code, durationMs, stderrHead: firstLine(stderr) };
}

function firstLine(s: string): string | null {
  if (s === '') return null;
  return s.split('\n')[0] ?? null;
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

/** Candidate spellings for a configured base ref, most specific first. */
export function refCandidates(
  baseRef: string,
  env: Readonly<Record<string, string | undefined>>,
  remote: string,
): string[] {
  const out: string[] = [baseRef, `refs/remotes/${baseRef}`];
  if (!baseRef.includes('/')) out.push(`${remote}/${baseRef}`, `refs/heads/${baseRef}`);
  const ghBase = env['GITHUB_BASE_REF'];
  if (ghBase !== undefined && ghBase !== '') {
    out.push(`${remote}/${ghBase}`, `refs/remotes/${remote}/${ghBase}`);
  }
  out.push(`refs/remotes/${remote}/HEAD`);
  return [...new Set(out)];
}

/** `origin/main` -> `main`; `main` -> `main`. */
export function branchOf(baseRef: string, remote: string): string {
  const prefixes = [`refs/remotes/${remote}/`, `${remote}/`, 'refs/heads/'];
  for (const p of prefixes) if (baseRef.startsWith(p)) return baseRef.slice(p.length);
  return baseRef;
}

function pickString(payload: unknown, path: readonly string[]): string | null {
  let cur: unknown = payload;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' && cur !== '' ? cur : null;
}

/** One-line report string. Never prints a bare sha with no provenance. */
export function describeBase(r: BaseResolution): string {
  const bits = [
    `${r.sha.slice(0, 12)} via ${r.source}`,
    r.confidence === 'approximate' ? 'APPROXIMATE' : 'exact',
  ];
  if (r.sameAsHead) bits.push('SAME AS HEAD — nothing to compare');
  if (r.stillShallow) bits.push('shallow clone');
  return bits.join(' · ');
}
