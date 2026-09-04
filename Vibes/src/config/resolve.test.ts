import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import type { DiffEntry, GitPort, RepoPath, Sha } from '../types.js';
import type { Diagnostic, DiagnosticCode } from './diagnostics.js';
import { resolveConfig, validateAll } from './resolve.js';

const exec = promisify(execFile);

/* ───────────────────── real repos, real git, no mocks ─────────────────── */

async function git(repo: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repo, ...args]);
  return stdout;
}

/**
 * A GitPort over real git plumbing. Only the four methods this module calls are
 * implemented; the rest throw so a future dependency shows up as a loud failure
 * rather than a quiet `null`.
 */
function makeGitPort(repo: string): GitPort {
  const unused = (name: string) => (): never => {
    throw new Error(`GitPort.${name} is not used by src/config`);
  };
  return {
    repoRoot: repo,
    revParse: async (rev: string): Promise<Sha | null> => (await git(repo, ['rev-parse', rev])).trim(),
    mergeBase: unused('mergeBase') as unknown as GitPort['mergeBase'],
    listFiles: async (): Promise<readonly RepoPath[]> =>
      (await git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
        .split('\0')
        .filter(Boolean),
    lsTree: async (rev: Sha): Promise<readonly RepoPath[]> =>
      (await git(repo, ['ls-tree', '-r', '-z', '--name-only', rev])).split('\0').filter(Boolean),
    readBlob: unused('readBlob') as unknown as GitPort['readBlob'],
    diffNameStatus: unused('diffNameStatus') as unknown as () => Promise<readonly DiffEntry[]>,
    isIgnored: async (p: RepoPath): Promise<boolean> => {
      try {
        await git(repo, ['check-ignore', '-q', '--no-index', '--', p]);
        return true;
      } catch (err) {
        // exit 1 = not ignored; anything else is a real failure.
        const code = (err as { code?: unknown }).code;
        if (code === 1) return false;
        throw err;
      }
    },
    isInSubmodule: async (): Promise<boolean> => false,
    isShallow: async (): Promise<boolean> => false,
  };
}

interface Repo {
  readonly dir: string;
  readonly port: GitPort;
  head: Sha;
  base: Sha;
}

async function makeRepo(files: Readonly<Record<string, string>>): Promise<Repo> {
  const dir = mkdtempSync(join(tmpdir(), 'vibes-resolve-'));
  await exec('git', ['init', '-q', '-b', 'main', dir]);
  await git(dir, ['config', 'user.email', 'vibes@example.invalid']);
  await git(dir, ['config', 'user.name', 'Vibes Test']);
  write(dir, files);
  await commit(dir, 'initial');
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  return { dir, port: makeGitPort(dir), head, base: head };
}

function write(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

async function commit(dir: string, message: string): Promise<Sha> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

const codes = (ds: readonly Diagnostic[]): DiagnosticCode[] => ds.map((d) => d.code);
const has = (ds: readonly Diagnostic[], c: DiagnosticCode): boolean => codes(ds).includes(c);
const errorCodes = (ds: readonly Diagnostic[]): DiagnosticCode[] =>
  ds.filter((d) => d.severity === 'error').map((d) => d.code);

/* ───────────────────────────── fixtures ──────────────────────────────── */

const rootConfig = (body: string): string => `export default ${body};`;

const BASE_FILES: Readonly<Record<string, string>> = {
  // `*.log` is ignored repo-wide here exactly as it is in MaD — the probe must
  // warn about it without blocking the run.
  '.gitignore': '.vibes/\n*.log\n',
  'vibes.config.mjs': rootConfig(`{
    version: 1,
    baseRef: 'origin/main',
    report: { out: '.vibes/report', formats: ['md', 'json'] },
    components: [
      { id: 'compa', root: 'compA', generates: ['compB/gen/**'] },
      { id: 'compb', root: 'compB', dependsOn: ['compa'] },
    ],
  }`),
  'compA/src/a.ts': 'export const a = 1;\n',
  'compA/vibes/vibes.manifest.mjs': `export default {
    component: 'compa',
    producers: [
      { name: 'p1', cmd: 'node vibes/producers/p1.mjs', out: 'snapshots/p1', ciJob: 'vibes' },
    ],
    witnesses: ['src/**'],
  };`,
  'compA/vibes/snapshots/p1/case.txt': 'baseline\n',
  'compB/src/b.ts': 'export const b = 2;\n',
  'compB/vibes/vibes.manifest.mjs': `export default {
    component: 'compb',
    producers: [],
    witnesses: ['src/**'],
    ingest: { junit: 'vibes/artifacts/*.xml', required: false },
  };`,
};

async function resolveRepo(repo: Repo, over: Record<string, unknown> = {}) {
  return resolveConfig({
    repoRoot: repo.dir,
    baseRef: 'origin/main',
    baseSha: repo.base,
    headSha: repo.head,
    git: repo.port,
    ...over,
  });
}

/* ═══════════════════════════ the happy path ═══════════════════════════ */

describe('resolveConfig — a well-formed two-component repo', () => {
  it('resolves cleanly and deterministically', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo);

    expect(errorCodes(r.diagnostics)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.components.map((c) => c.id)).toEqual(['compa', 'compb']);

    const again = await resolveRepo(repo);
    expect(again.components.map((c) => c.id)).toEqual(r.components.map((c) => c.id));
    expect(codes(again.diagnostics)).toEqual(codes(r.diagnostics));
  });

  it('anchors out at <root>/vibes, cwd at <root>, and received outside both', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo);
    const p = r.components[0]?.producers[0];

    expect(p?.resolved.baselineDir).toBe(join(repo.dir, 'compA/vibes/snapshots/p1'));
    expect(p?.resolved.absCwd).toBe(join(repo.dir, 'compA'));
    // Producers write to a gitignored received dir, NEVER onto the committed
    // baseline — that separation is what leaves room for an accept step.
    expect(p?.resolved.receivedDir).toBe(join(repo.dir, '.vibes/received/compa/p1'));
    expect(p?.outRepo).toBe('compA/vibes/snapshots/p1');
    expect(p?.hasBaseline).toBe(true);
  });

  it('applies the precedence chain into effective* fields', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo);
    const p = r.components[0]?.producers[0]?.resolved;
    expect(p?.effectiveTimeoutMs).toBe(600_000);
    expect(p?.effectiveClean).toBe(true);
    expect(p?.compareSpec).toEqual({ kind: 'exact' });
  });

  it('re-anchors witnesses to the repo root and expands them against tracked files', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo);
    const compa = r.components[0];
    expect(compa?.witnessesAuthored).toEqual(['src/**']);
    expect(compa?.resolved.witnesses).toEqual(['compA/src/**']);
    expect(compa?.witnessMatches[0]?.matched).toEqual(['compA/src/a.ts']);
    // The manifest and the snapshots are NOT witnesses of themselves.
    expect(compa?.implicitWitness).toBe('compA/vibes/**');
  });

  it('forces runWhen:always on the component whose root another component generates into', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo);
    const compa = r.components[0];
    const compb = r.components[1];
    expect(compa?.forcedAlways).toBe(false);
    expect(compb?.forcedAlways).toBe(true);
    expect(compb?.forcedAlwaysReason).toMatch(/compa:compB\/gen/);
  });

  it('computes the transitive dependsOn closure', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo);
    expect(r.components[0]?.closure).toEqual([]);
    expect(r.components[1]?.closure).toEqual(['compa']);
  });

  it('warns but does not fail when a bare extension pattern reaches into an out dir', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo);
    const d = r.diagnostics.find((x) => x.code === 'V045_OUT_IGNORED_DIR');
    expect(d?.severity).toBe('warn');
    expect(d?.evidence.join(' ')).toMatch(/\.vibes-probe\.log/);
    expect(r.ok).toBe(true);
  });

  it('stays silent about the report dir when it is gitignored', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo);
    expect(has(r.diagnostics, 'V016_REPORT_OUT_UNIGNORED')).toBe(false);
  });

  it('serialises an effective manifest with the merged values folded in', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo);
    const eff = r.components[0]?.effective;
    expect(eff?.component).toBe('compa');
    expect(eff?.producers[0]?.timeoutMs).toBe(600_000);
    expect(eff?.producers[0]?.runWhen).toBe('changed');
    // `defaults` is dropped: already applied above, and leaving it invites a
    // reader to apply it twice.
    expect(eff && 'defaults' in eff).toBe(false);
  });

  it('resolves ingest paths against the component root', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo);
    const ing = r.components[1]?.ingest;
    expect(ing?.absCwd).toBe(join(repo.dir, 'compB'));
    expect(ing?.junit).toEqual(['vibes/artifacts/*.xml']);
    expect(ing?.required).toBe(false);
  });
});

/* ══════════════════ existence, nesting, collisions ════════════════════ */

describe('the registry is the guarantee', () => {
  it('treats a registry root that does not exist as a HARD ERROR', async () => {
    const repo = await makeRepo(BASE_FILES);
    rmSync(join(repo.dir, 'compB'), { recursive: true, force: true });
    await commit(repo.dir, 'delete compB entirely');
    const head = (await git(repo.dir, ['rev-parse', 'HEAD'])).trim();

    const r = await resolveRepo({ ...repo, head });
    const d = r.diagnostics.find((x) => x.code === 'V022_ROOT_MISSING_DIR');
    expect(d?.severity).toBe('error');
    expect(d?.component).toBe('compb');
    expect(d?.evidence.join(' ')).toMatch(/never a skip/);
    expect(r.ok).toBe(false);
    expect(r.components[1]?.status).toBe('unusable');
  });

  it('points locators at the AUTHORED entry, not the sorted one', async () => {
    // Resolution sorts by id for determinism; the reader is looking at the file
    // they wrote, where `zeta` is entry 0.
    const repo = await makeRepo({
      ...BASE_FILES,
      'vibes.config.mjs': rootConfig(`{
        version: 1, baseRef: 'main',
        report: { out: '.vibes/report', formats: ['md'] },
        components: [
          { id: 'zeta', root: 'missing-dir' },
          { id: 'alpha', root: 'compA' },
        ],
      }`),
    });
    const r = await resolveRepo(repo);
    expect(r.components.map((c) => c.id)).toEqual(['alpha', 'zeta']);
    const d = r.diagnostics.find((x) => x.code === 'V022_ROOT_MISSING_DIR');
    expect(d?.locator).toBe('components[0].root');
  });

  it('rejects nested component roots', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'vibes.config.mjs': rootConfig(`{
        version: 1, baseRef: 'main',
        report: { out: '.vibes/report', formats: ['md'] },
        components: [
          { id: 'outer', root: 'compA' },
          { id: 'inner', root: 'compA/src' },
        ],
      }`),
      'compA/src/vibes/vibes.manifest.mjs': `export default { component: 'inner', producers: [] };`,
    });
    const r = await resolveRepo(repo);
    expect(has(r.diagnostics, 'V023_ROOT_NESTED')).toBe(true);
  });

  it('rejects a root inside a declared submodule', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      '.gitmodules': '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.invalid/lib\n',
      'vendor/lib/README.md': 'vendored\n',
      'vibes.config.mjs': rootConfig(`{
        version: 1, baseRef: 'main',
        report: { out: '.vibes/report', formats: ['md'] },
        components: [{ id: 'vendored', root: 'vendor/lib' }],
      }`),
    });
    const r = await resolveRepo(repo);
    const d = r.diagnostics.find((x) => x.code === 'V024_ROOT_IN_SUBMODULE');
    expect(d?.evidence.join(' ')).toMatch(/invisible to the superproject diff/);
  });

  it('rejects an unknown submodule declaration', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'vibes.config.mjs': rootConfig(`{
        version: 1, baseRef: 'main',
        report: { out: '.vibes/report', formats: ['md'] },
        components: [{ id: 'compa', root: 'compA', submodules: ['SIL/embsim'] }],
      }`),
    });
    const r = await resolveRepo(repo);
    expect(has(r.diagnostics, 'V02A_SUBMODULE_UNKNOWN')).toBe(true);
  });

  it('rejects colliding and nested producer out dirs', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'compA/vibes/vibes.manifest.mjs': `export default {
        component: 'compa',
        witnesses: ['src/**'],
        producers: [
          { name: 'p1', cmd: 'true', out: 'snapshots/p1', ciJob: 'v' },
          { name: 'p2', cmd: 'true', out: 'snapshots/p1/inner', ciJob: 'v' },
        ],
      };`,
    });
    const r = await resolveRepo(repo);
    const d = r.diagnostics.find((x) => x.code === 'V044_OUT_COLLISION');
    expect(d?.message).toMatch(/nested/);
    // Pre-cleaning the outer dir would wipe the inner one and report its whole
    // corpus deleted, so this is fatal rather than cosmetic.
    expect(d?.severity).toBe('error');
  });

  it('rejects an out that escapes the vibes dir at resolve time too', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'compA/vibes/vibes.manifest.mjs': `export default {
        component: 'compa',
        witnesses: ['src/**'],
        producers: [{ name: 'p1', cmd: 'true', out: 'sub/../../src', ciJob: 'v' }],
      };`,
    });
    const r = await resolveRepo(repo);
    expect(has(r.diagnostics, 'V0A1_PATH_NOT_POSIX') || has(r.diagnostics, 'V043_OUT_ESCAPES')).toBe(true);
  });

  it('reports a missing producer cwd, resolved against the component root', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'compA/vibes/vibes.manifest.mjs': `export default {
        component: 'compa',
        witnesses: ['src/**'],
        producers: [{ name: 'p1', cmd: 'true', out: 'snapshots/p1', cwd: 'nope', ciJob: 'v' }],
      };`,
    });
    const r = await resolveRepo(repo);
    const d = r.diagnostics.find((x) => x.code === 'V048_CWD_MISSING');
    expect(d?.evidence.join(' ')).toContain(join(repo.dir, 'compA/nope'));
  });

  it('detects a dependsOn cycle and names the path', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'vibes.config.mjs': rootConfig(`{
        version: 1, baseRef: 'main',
        report: { out: '.vibes/report', formats: ['md'] },
        components: [
          { id: 'compa', root: 'compA', dependsOn: ['compb'] },
          { id: 'compb', root: 'compB', dependsOn: ['compa'] },
        ],
      }`),
    });
    const r = await resolveRepo(repo);
    const d = r.diagnostics.find((x) => x.code === 'V029_DEPENDSON_CYCLE');
    expect(d?.evidence[0]).toMatch(/→/);
  });

  it('rejects an unknown dependsOn target', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'vibes.config.mjs': rootConfig(`{
        version: 1, baseRef: 'main',
        report: { out: '.vibes/report', formats: ['md'] },
        components: [{ id: 'compa', root: 'compA', dependsOn: ['ghost'] }],
      }`),
    });
    const r = await resolveRepo(repo);
    expect(has(r.diagnostics, 'V028_DEPENDSON_UNKNOWN')).toBe(true);
  });
});

/* ═══════════════════════════ witnesses ════════════════════════════════ */

describe('witness expansion', () => {
  it('errors on a witness that never matched anything, at base or at HEAD', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'compA/vibes/vibes.manifest.mjs': `export default {
        component: 'compa',
        witnesses: ['src/domain/**'],
        producers: [{ name: 'p1', cmd: 'true', out: 'snapshots/p1', ciJob: 'v' }],
      };`,
    });
    const r = await resolveRepo(repo);
    const d = r.diagnostics.find((x) => x.code === 'V053_WITNESS_ZERO_ALWAYS');
    expect(d?.severity).toBe('error');
    expect(d?.evidence.join(' ')).toMatch(/compA\/src\/domain/);
  });

  it('warns — not errors — when a witness matched at base and the source is now gone', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'compA/src/legacy/old.ts': 'export const old = 1;\n',
      'compA/vibes/vibes.manifest.mjs': `export default {
        component: 'compa',
        witnesses: ['src/legacy/**'],
        producers: [{ name: 'p1', cmd: 'true', out: 'snapshots/p1', ciJob: 'v' }],
      };`,
    });
    const base = repo.head;
    rmSync(join(repo.dir, 'compA/src/legacy'), { recursive: true, force: true });
    const head = await commit(repo.dir, 'retire legacy');

    const r = await resolveRepo({ ...repo, base, head });
    const d = r.diagnostics.find((x) => x.code === 'V054_WITNESS_RETIRED');
    expect(d?.severity).toBe('warn');
    expect(d?.message).toMatch(/1 file\(s\) at base/);
    expect(has(r.diagnostics, 'V053_WITNESS_ZERO_ALWAYS')).toBe(false);
  });

  it('refuses a witness that reaches outside the component root', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'compA/vibes/vibes.manifest.mjs': `export default {
        component: 'compa',
        witnesses: ['../compB/src/**'],
        producers: [{ name: 'p1', cmd: 'true', out: 'snapshots/p1', ciJob: 'v' }],
      };`,
    });
    const r = await resolveRepo(repo);
    // Caught at shape-validation time as a '..' segment; either way the claim
    // never reaches another component's tree.
    expect(has(r.diagnostics, 'V0A1_PATH_NOT_POSIX') || has(r.diagnostics, 'V051_WITNESS_ESCAPES_ROOT')).toBe(true);
  });

  it('refuses a witness that would match inside a producer out dir', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'compA/vibes/vibes.manifest.mjs': `export default {
        component: 'compa',
        witnesses: ['**'],
        producers: [{ name: 'p1', cmd: 'true', out: 'snapshots/p1', ciJob: 'v' }],
      };`,
    });
    const r = await resolveRepo(repo);
    expect(has(r.diagnostics, 'V055_WITNESS_IN_OUT')).toBe(true);
  });

  it('honours a leading ! as a filter that claims nothing itself', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'compA/src/a.test.ts': 'test\n',
      'compA/vibes/vibes.manifest.mjs': `export default {
        component: 'compa',
        witnesses: ['src/**', '!src/**/*.test.ts'],
        producers: [{ name: 'p1', cmd: 'true', out: 'snapshots/p1', ciJob: 'v' }],
      };`,
    });
    const r = await resolveRepo(repo);
    expect(r.components[0]?.witnessMatches[0]?.matched).toEqual(['compA/src/a.ts']);
    expect(r.components[0]?.witnessMatches[1]?.negated).toBe(true);
    expect(errorCodes(r.diagnostics)).toEqual([]);
  });
});

/* ═══════════════════ suppression and selection ════════════════════════ */

describe('suppression decays', () => {
  const disabled = (until: string) => ({
    ...BASE_FILES,
    'vibes.config.mjs': rootConfig(`{
      version: 1, baseRef: 'main',
      report: { out: '.vibes/report', formats: ['md'] },
      components: [
        { id: 'compa', root: 'compA' },
        { id: 'compb', root: 'compB', enabled: false,
          disabledReason: 'KiBot only runs in the CI container; board behaviour is NOT measured',
          disabledUntil: '${until}' },
      ],
    }`),
  });

  it('accepts a live suppression, and does not demand a manifest for it', async () => {
    const files = disabled('2999-12-31');
    delete (files as Record<string, string>)['compB/vibes/vibes.manifest.mjs'];
    const repo = await makeRepo(files);
    const r = await resolveRepo(repo);
    expect(errorCodes(r.diagnostics)).toEqual([]);
    expect(r.components[1]?.status).toBe('disabled');
    expect(r.components[1]?.statusReason).toMatch(/KiBot/);
    expect(has(r.diagnostics, 'V030_MANIFEST_MISSING')).toBe(false);
  });

  it('turns an expired suppression into the finding', async () => {
    const repo = await makeRepo(disabled('2020-01-01'));
    const r = await resolveRepo(repo);
    const d = r.diagnostics.find((x) => x.code === 'V027_DISABLED_EXPIRED');
    expect(d?.severity).toBe('error');
    expect(d?.evidence.join(' ')).toMatch(/KiBot/);
  });

  it('respects the clock injected for the expiry check', async () => {
    const repo = await makeRepo(disabled('2026-12-31'));
    const before = await resolveRepo(repo, { now: new Date('2026-06-01T00:00:00Z') });
    expect(has(before.diagnostics, 'V027_DISABLED_EXPIRED')).toBe(false);
    const after = await resolveRepo(repo, { now: new Date('2027-01-01T12:00:00Z') });
    expect(has(after.diagnostics, 'V027_DISABLED_EXPIRED')).toBe(true);
  });
});

describe('cli selection', () => {
  it('marks unselected components skipped-cli without pretending they are clean', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo, { only: ['compa'] });
    expect(r.components[0]?.status).toBe('active');
    expect(r.components[1]?.status).toBe('skipped-cli');
    expect(r.components[1]?.statusReason).toMatch(/--only/);
  });

  it('hard-errors on an unknown --only id instead of silently running nothing', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo, { only: ['ghost'] });
    expect(has(r.diagnostics, 'V0A4_SELECTION_UNKNOWN')).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('rejects --only together with --skip', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo, { only: ['compa'], skip: ['compb'] });
    expect(r.diagnostics.filter((d) => d.code === 'V0A4_SELECTION_UNKNOWN').length).toBeGreaterThan(0);
  });

  it('--all forces every producer to always', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo, { all: true });
    expect(r.components[0]?.producers[0]?.resolved.effectiveRunWhen).toBe('always');
    expect(r.components[0]?.forcedAlwaysReason).toBe('--all');
  });
});

/* ═══════════════════════ environment guards ═══════════════════════════ */

describe('environment', () => {
  it('warns when the report dir is not gitignored', async () => {
    const repo = await makeRepo({ ...BASE_FILES, '.gitignore': '*.log\n' });
    const r = await resolveRepo(repo);
    const d = r.diagnostics.find((x) => x.code === 'V016_REPORT_OUT_UNIGNORED');
    expect(d?.severity).toBe('warn');
    expect(d?.fix).toMatch(/\.vibes\/report/);
  });

  it('errors when the whole out dir is gitignored, not just some extensions', async () => {
    const repo = await makeRepo({ ...BASE_FILES, '.gitignore': '.vibes/\nsnapshots/\n' });
    const r = await resolveRepo(repo);
    const d = r.diagnostics.find((x) => x.code === 'V045_OUT_IGNORED_DIR');
    expect(d?.severity).toBe('error');
    expect(d?.fix).toMatch(/rename/);
  });

  it('records a producer with no committed baseline as info, not as a failure', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'compA/vibes/vibes.manifest.mjs': `export default {
        component: 'compa',
        witnesses: ['src/**'],
        producers: [{ name: 'fresh', cmd: 'true', out: 'snapshots/fresh', ciJob: 'v' }],
      };`,
    });
    const r = await resolveRepo(repo);
    const d = r.diagnostics.find((x) => x.code === 'V04D_NO_BASELINE');
    expect(d?.severity).toBe('info');
    expect(d?.fix).toMatch(/bootstrap/);
    expect(r.components[0]?.producers[0]?.hasBaseline).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('warns when a manifest exists but was never staged', async () => {
    const repo = await makeRepo(BASE_FILES);
    // A brand-new component, written but not committed: it still gets a report
    // — silence would be worse — but the report says the manifest is invisible
    // to the baseline diff.
    write(repo.dir, {
      'compC/src/c.ts': 'export const c = 3;\n',
      'compC/vibes/vibes.manifest.mjs': `export default { component: 'compc', producers: [], witnesses: ['src/**'] };`,
      'vibes.config.mjs': rootConfig(`{
        version: 1, baseRef: 'main',
        report: { out: '.vibes/report', formats: ['md'] },
        components: [{ id: 'compc', root: 'compC' }],
      }`),
    });
    const r = await resolveRepo(repo);
    const d = r.diagnostics.find((x) => x.code === 'V035_MANIFEST_UNTRACKED');
    expect(d?.severity).toBe('warn');
    expect(d?.fix).toBe('git add compC/vibes/vibes.manifest.mjs');
  });

  it('refuses to resolve a base sha that is not a real object id', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveRepo(repo, { baseSha: 'origin/main' });
    const d = r.diagnostics.find((x) => x.code === 'V014_BASEREF_UNRESOLVED');
    expect(d?.fix).toMatch(/fetch-depth: 0|VIBES_BASE_SHA/);
  });

  it('works without a GitPort at all, skipping only the git-backed checks', async () => {
    const repo = await makeRepo(BASE_FILES);
    const r = await resolveConfig({
      repoRoot: repo.dir,
      baseRef: 'origin/main',
      baseSha: repo.base,
      headSha: repo.head,
    });
    expect(errorCodes(r.diagnostics)).toEqual([]);
    expect(r.components[0]?.producers[0]?.resolved.baselineDir).toContain('compA/vibes/snapshots/p1');
    expect(r.components[0]?.witnessMatches[0]?.matched).toEqual([]);
  });

  it('reports a missing registry as a fatal, componentless result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibes-empty-'));
    const r = await resolveConfig({
      repoRoot: dir,
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    });
    expect(r.ok).toBe(false);
    expect(r.components).toEqual([]);
    expect(r.diagnostics[0]?.code).toBe('V010_ROOT_MISSING');
  });
});

/* ══════════════ the shape this is actually aimed at ═══════════════════ */

describe("MaD's own five-component registry", () => {
  it('resolves with no errors and forces the generated-input consumer to always', async () => {
    const repo = await makeRepo({
      '.gitignore': '.vibes/\n*.log\ndist/\ntarget/\n',
      '.gitmodules':
        '[submodule "Protocol/ProtoEmb"]\n\tpath = Protocol/ProtoEmb\n\turl = https://example.invalid/protoemb\n' +
        '[submodule "SIL/embsim"]\n\tpath = SIL/embsim\n\turl = https://example.invalid/embsim\n',
      'Protocol/ProtoEmb/.keep': '',
      'SIL/embsim/.keep': '',
      'vibes.config.mjs': rootConfig(`{
        version: 1,
        baseRef: 'origin/main',
        report: { out: '.vibes/report', formats: ['md', 'html', 'json'], title: 'MaD behaviour report' },
        concurrency: 1,
        failOn: { producerError: true, ingestMissing: true, honestyViolation: true,
                  governanceWeakened: true, snapshotDrift: false },
        defaults: { compare: { kind: 'exact' }, timeoutMs: 600000, runWhen: 'changed' },
        components: [
          { id: 'control', title: 'Control', root: 'Software/Control',
            dependsOn: ['protocol'], submodules: ['Protocol/ProtoEmb'] },
          { id: 'protocol', title: 'Protocol', root: 'Protocol',
            submodules: ['Protocol/ProtoEmb'],
            generates: [
              'Software/Control/src/protocol/generated/**',
              'Firmware/MaDCore/src/Generated/**',
              'Protocol/rust/src/generated/**',
            ] },
          { id: 'firmware', title: 'Firmware', root: 'Firmware/MaDCore', dependsOn: ['protocol'] },
          { id: 'sil', title: 'SIL', root: 'SIL', dependsOn: ['firmware', 'protocol'],
            submodules: ['SIL/embsim'] },
          { id: 'hardware', title: 'Hardware', root: 'Hardware', enabled: false,
            disabledReason: 'KiBot runs only inside the CI container; board behaviour is NOT measured',
            disabledUntil: '2026-12-31' },
        ],
      }`),
      'Software/Control/src/domain/gcode.ts': 'export const g = 1;\n',
      'Software/Control/vibes/vibes.manifest.mjs': `export default {
        component: 'control',
        producers: [{ name: 'gcode-corpus', cmd: 'npx vite-node vibes/producers/gcode-corpus.mts',
                      out: 'snapshots/gcode', renderer: 'gcode', minCases: 24, ciJob: 'vibes' }],
        witnesses: ['src/domain/**'],
        ingest: { cmd: 'npx vitest run', junit: 'vibes/artifacts/vitest-junit.xml', required: true },
      };`,
      'Software/Control/vibes/snapshots/gcode/.keep': '',
      'Protocol/MaDProtocol.yaml': 'messages: []\n',
      // The factory form, exactly as the worked Protocol manifest uses it.
      'Protocol/vibes/vibes.manifest.mjs': `export default ({ component }) => ({
        component,
        producers: ['c', 'ts', 'rs'].map((t) => ({
          name: 'codegen-' + t,
          cmd: 'python3 ProtoEmb/core/generate.py --target ' + t + ' --output "$VIBES_OUT"',
          out: 'snapshots/codegen/' + t,
          minCases: 16,
          ciJob: 'vibes',
        })),
        witnesses: ['MaDProtocol.yaml'],
        ingest: { junit: 'vibes/artifacts/*.xml', required: false },
      });`,
      'Protocol/vibes/snapshots/codegen/c/.keep': '',
      'Protocol/vibes/snapshots/codegen/ts/.keep': '',
      'Protocol/vibes/snapshots/codegen/rs/.keep': '',
      'Firmware/MaDCore/src/IO/IO_gcode.c': 'int main(void){return 0;}\n',
      'Firmware/MaDCore/vibes/vibes.manifest.mjs': `export default {
        component: 'firmware',
        producers: [],
        witnesses: ['src/IO/IO_gcode.c'],
        ingest: { cmd: 'pio test -e native_test', junit: 'vibes/artifacts/native_test.xml',
                  required: true, timeoutMs: 900000 },
      };`,
      'SIL/models/src/lib.rs': 'pub fn f() {}\n',
      'SIL/vibes/vibes.manifest.mjs': `export default {
        component: 'sil',
        producers: [{ name: 'physics-trace', cmd: 'cargo run -p models --example vibes-trace -- "$VIBES_OUT"',
                      out: 'snapshots/physics', timeoutMs: 900000, resources: ['sil-emulator'],
                      compare: [{ match: '**/*.csv', use: { kind: 'tolerance', rel: 1e-9,
                                  reason: 'f64 integration differs in last-place digits across targets' } },
                                { match: '**/*', use: { kind: 'exact' } }],
                      renderer: 'table', minCases: 6, ciJob: 'vibes' }],
        witnesses: ['models/src/**'],
      };`,
      'SIL/vibes/snapshots/physics/.keep': '',
      'Hardware/EdgeBoard/.keep': '',
    });

    const r = await resolveRepo(repo, { now: new Date('2026-08-21T00:00:00Z') });

    expect(errorCodes(r.diagnostics)).toEqual([]);
    expect(r.components.map((c) => c.id)).toEqual(['control', 'firmware', 'hardware', 'protocol', 'sil']);
    expect(r.report.title).toBe('MaD behaviour report');
    expect(r.concurrency).toBe(1);
    expect(r.failOn.snapshotDrift).toBe(false);

    const byId = new Map(r.components.map((c) => [c.id, c]));

    // control, firmware and protocol all consume protocol's generated output,
    // so none of them can ever resolve to skipped-unchanged.
    expect(byId.get('control')?.forcedAlways).toBe(true);
    expect(byId.get('firmware')?.forcedAlways).toBe(true);
    expect(byId.get('protocol')?.forcedAlways).toBe(false);
    expect(byId.get('sil')?.forcedAlways).toBe(false);
    expect(byId.get('control')?.producers[0]?.resolved.effectiveRunWhen).toBe('always');

    // The factory manifest expanded into three producers with disjoint outs.
    expect(byId.get('protocol')?.producers.map((p) => p.outRepo)).toEqual([
      'Protocol/vibes/snapshots/codegen/c',
      'Protocol/vibes/snapshots/codegen/ts',
      'Protocol/vibes/snapshots/codegen/rs',
    ]);

    expect(byId.get('sil')?.closure).toEqual(['firmware', 'protocol']);
    expect(byId.get('hardware')?.status).toBe('disabled');
    expect(byId.get('firmware')?.producers).toEqual([]);
    expect(byId.get('control')?.witnessMatches[0]?.matched).toEqual([
      'Software/Control/src/domain/gcode.ts',
    ]);
  });
});

describe('every resolve-time diagnostic is actionable', () => {
  it('names a file and a fix, and keeps the message to one short line', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      '.gitignore': 'snapshots/\n',
      'vibes.config.mjs': rootConfig(`{
        version: 1, baseRef: 'main',
        report: { out: '.vibes/report', formats: ['md'] },
        components: [
          { id: 'compa', root: 'compA', dependsOn: ['ghost'], submodules: ['nope'] },
          { id: 'compb', root: 'compA/src' },
          { id: 'gone', root: 'deleted-dir', enabled: false, disabledReason: 'x', disabledUntil: '2001-01-01' },
        ],
      }`),
      'compA/src/vibes/vibes.manifest.mjs': `export default {
        component: 'compb',
        witnesses: ['does/not/exist/**'],
        producers: [{ name: 'p1', cmd: 'true', out: 'snapshots/p1' }],
      };`,
    });
    const r = await resolveRepo(repo);
    expect(r.diagnostics.length).toBeGreaterThan(6);
    for (const d of r.diagnostics) {
      expect(d.file, d.code).toBeTruthy();
      expect(d.fix.length, d.code).toBeGreaterThan(0);
      expect(d.message.length, `${d.code}: ${d.message}`).toBeLessThanOrEqual(100);
      expect(d.message.endsWith('.'), d.code).toBe(false);
      expect(/^[A-Z]/.test(d.message), `${d.code}: ${d.message}`).toBe(false);
    }
  });
});

/* ═════════════════════════════ doctor ═════════════════════════════════ */

describe('validateAll', () => {
  it('splits diagnostics by severity for the doctor output', async () => {
    const repo = await makeRepo(BASE_FILES);
    const v = await validateAll({
      repoRoot: repo.dir,
      baseRef: 'origin/main',
      baseSha: repo.base,
      headSha: repo.head,
      git: repo.port,
    });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings.map((d) => d.code)).toContain('V045_OUT_IGNORED_DIR');
    expect(v.config.components).toHaveLength(2);
  });

  it('flags an unknown renderer only when the registry is supplied', async () => {
    const repo = await makeRepo({
      ...BASE_FILES,
      'compA/vibes/vibes.manifest.mjs': `export default {
        component: 'compa',
        witnesses: ['src/**'],
        producers: [{ name: 'p1', cmd: 'true', out: 'snapshots/p1', renderer: 'gcode', ciJob: 'v' }],
      };`,
    });
    const without = await resolveRepo(repo);
    expect(has(without.diagnostics, 'V04A_RENDERER_UNKNOWN')).toBe(false);

    const withRegistry = await resolveRepo(repo, { knownRenderers: ['table', 'code-c'] });
    const d = withRegistry.diagnostics.find((x) => x.code === 'V04A_RENDERER_UNKNOWN');
    expect(d?.fix).toMatch(/table, code-c/);
  });
});
