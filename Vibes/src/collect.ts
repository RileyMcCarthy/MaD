/**
 * Run every committed suite and build the behaviour ledger.
 *
 * This is the only module that knows a runner's output format, and it knows
 * them in three small functions. Everything downstream sees one schema.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Behaviour, Status } from './ledger.js';

export interface Suite {
  readonly v: 1;
  readonly name: string;
  readonly lang: string;
  readonly cmd: string;
  readonly results: string;
}

export interface CollectResult {
  readonly behaviours: readonly Behaviour[];
  /** Things that stopped this run from being complete. Never silent. */
  readonly problems: readonly string[];
  readonly suitesRun: number;
}

type Adapter = (text: string) => Map<string, Status>;

/** The ONLY place a runner's output format is understood. */
const ADAPTERS: Readonly<Record<string, Adapter>> = {
  'vitest-json': (text) => {
    const doc = JSON.parse(text) as {
      testResults?: { assertionResults?: { ancestorTitles?: string[]; title?: string; status?: string }[] }[];
    };
    const out = new Map<string, Status>();
    for (const f of doc.testResults ?? []) {
      for (const a of f.assertionResults ?? []) {
        const s: Status = a.status === 'passed' ? 'pass' : a.status === 'pending' ? 'skip' : 'fail';
        const full = [...(a.ancestorTitles ?? []), a.title ?? ''].filter(Boolean).join(' > ');
        if (full !== '') out.set(full, s);
        // Also the bare title: a binding that does not nest under describe
        // still has to join, and vitest reports both shapes.
        if (a.title !== undefined && a.title !== '') out.set(a.title, s);
      }
    }
    return out;
  },
  /* Unity has TWO output shapes and this must handle both, because which one
   * you get depends on the harness, not on Unity:
   *
   *   bare Unity   file:line:test_name:PASS
   *   PlatformIO   file:line: test_name\t[PASSED]
   *
   * Measured: `pio test -e native_test` emits the second. Matching only the
   * first silently yields no statuses at all, and every C behaviour then reads
   * `did-not-report` — a whole language reporting nothing, from a regex. */
  'unity-stdout': (text) => {
    const out = new Map<string, Status>();
    const norm = (verdict: string): Status =>
      verdict.startsWith('PASS') ? 'pass' : verdict.startsWith('IGNORE') ? 'skip' : 'fail';
    for (const line of text.split('\n')) {
      const pio = /(?:^|:)\s*(test_\w+)\s*\[(PASSED|FAILED|IGNORED)\]/.exec(line);
      if (pio?.[1] !== undefined && pio[2] !== undefined) {
        out.set(pio[1], norm(pio[2]));
        continue;
      }
      const bare = /(?:^|:)(test_\w+):(PASS|FAIL|IGNORE)/.exec(line);
      if (bare?.[1] !== undefined && bare[2] !== undefined) out.set(bare[1], norm(bare[2]));
    }
    return out;
  },
  // libtest prints `test path::name ... ok|FAILED|ignored`.
  'cargo-stdout': (text) => {
    const out = new Map<string, Status>();
    for (const line of text.split('\n')) {
      const m = /^test ([\w:]+) \.\.\. (ok|FAILED|ignored)/.exec(line);
      if (m?.[1] !== undefined) {
        out.set(m[1], m[2] === 'ok' ? 'pass' : m[2] === 'ignored' ? 'skip' : 'fail');
      }
    }
    return out;
  },
};

export function findSuites(repoRoot: string): readonly string[] {
  /* `git ls-files`, never a filesystem walk. This repo carries 18 worktrees,
   * several nested under .claude/worktrees/, each a full checkout; a glob would
   * find every stale copy and run their suites. git sees only tracked files.
   * It also means an uncommitted suite is invisible, deliberately. */
  return execFileSync('git', ['ls-files', '-z', '*vibes.suite.json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((p) => p !== '');
}

export function collect(repoRoot: string, log: (s: string) => void): CollectResult {
  const problems: string[] = [];
  const behaviours: Behaviour[] = [];
  const suiteFiles = findSuites(repoRoot);

  for (const rel of suiteFiles) {
    const abs = join(repoRoot, rel);
    const dir = dirname(abs);
    let suite: Suite;
    try {
      suite = JSON.parse(readFileSync(abs, 'utf8')) as Suite;
    } catch (e) {
      problems.push(`${rel}: not valid JSON — ${(e as Error).message}`);
      continue;
    }
    if (suite.v !== 1) {
      problems.push(`${rel}: schema v${String(suite.v)} unsupported (expects v1)`);
      continue;
    }
    const adapter = ADAPTERS[suite.results];
    if (adapter === undefined) {
      problems.push(
        `${rel}: unknown results format ${JSON.stringify(suite.results)} — known: ${Object.keys(ADAPTERS).join(', ')}`,
      );
      continue;
    }

    const scratch = mkdtempSync(join(tmpdir(), 'vibes-'));
    const ledgerPath = join(scratch, 'behaviours.jsonl');
    const resultsPath = join(scratch, 'results.out');
    writeFileSync(ledgerPath, '');

    log(`vibes: ${suite.name}: ${suite.cmd}`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env['VIBES_BEHAVIOURS'] = ledgerPath;
    env['VIBES_RESULTS'] = resultsPath;
    env['NO_COLOR'] = '1';

    const run = spawnSync('/bin/sh', ['-c', suite.cmd], {
      cwd: dir,
      env,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });

    // A non-zero exit is EXPECTED when a test fails, and those failures are the
    // finding. Only an unreadable suite is an error.
    const declared = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, 'utf8').trim().split('\n').filter((l) => l !== '')
      : [];

    const resultText = existsSync(resultsPath)
      ? readFileSync(resultsPath, 'utf8')
      : `${run.stdout ?? ''}\n${run.stderr ?? ''}`;

    let status: Map<string, Status>;
    try {
      status = adapter(resultText);
    } catch (e) {
      problems.push(`${rel}: could not read results as ${suite.results} — ${(e as Error).message}`);
      status = new Map();
    }

    if (declared.length === 0) {
      problems.push(
        `${rel}: ran, but declared no behaviours — either nothing uses the binding yet, ` +
          'or the suite did not pick up $VIBES_BEHAVIOURS',
      );
    }

    for (const line of declared) {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch (e) {
        problems.push(`${rel}: unparseable ledger line — ${(e as Error).message}`);
        continue;
      }
      // Paths arrive in three shapes: repo-relative (ts), crate-relative
      // (rust), absolute (__FILE__ in c). One universe from here on.
      const declaredFile = typeof raw['file'] === 'string' ? raw['file'] : '';
      const file =
        declaredFile === ''
          ? ''
          : relative(repoRoot, declaredFile.startsWith('/') ? declaredFile : resolve(dir, declaredFile))
              .split(sep)
              .join('/');
      const test = typeof raw['test'] === 'string' ? raw['test'] : '';
      behaviours.push({
        ...(raw as unknown as Behaviour),
        file,
        suite: suite.name,
        // A behaviour whose test reported nothing is `did-not-report`, NEVER
        // pass. The binding ran, so it was declared; nothing said it held.
        status: status.get(test) ?? 'did-not-report',
      });
    }
    rmSync(scratch, { recursive: true, force: true });
  }

  return { behaviours, problems, suitesRun: suiteFiles.length };
}
