/**
 * vibes — what behaviour does this change add, and what stopped holding?
 *
 *   vibes collect            run every suite, print the ledger
 *   vibes collect --write    ... and update the committed ledger
 *   vibes report --base REF  diff the ledger against REF and render
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { collect } from './collect.js';
import { diffLedgers, hasRegression } from './diff.js';
import { parseLedger, serializeLedger, type Behaviour } from './ledger.js';
import { patchCoverage, type LcovSource } from './coverage.js';
import { renderMarkdown } from './report.js';

export const LEDGER = 'behaviours.jsonl';

const EXIT = { OK: 0, REGRESSION: 1, USAGE: 2, COLLECT: 3 } as const;

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

/** Committed ledger at a ref. Absent is not an error: the first run has no
 *  baseline, and everything is legitimately new. */
function ledgerAt(root: string, ref: string): Behaviour[] {
  try {
    const text = execFileSync('git', ['show', `${ref}:${LEDGER}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      // Absent-at-base is handled below; git's "fatal: path ... not in" line
      // would otherwise leak into every first-adoption log.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseLedger(text).ok;
  } catch {
    return [];
  }
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? '' : v;
}

/** Test files and generated code are not authored behaviour: counting a test's
 *  own added lines as "unspecified" is noise, and nobody writes the generated
 *  codecs by hand. */
function interesting(file: string): boolean {
  if (/\.(test|spec)\.[cm]?tsx?$/.test(file)) return false;
  if (/(^|\/)(generated|Generated)\//.test(file)) return false;
  if (/(^|\/)vibes\//.test(file)) return false;
  return /\.(ts|tsx|c|h|rs)$/.test(file);
}

export async function main(argv: readonly string[]): Promise<number> {
  const cmd = argv[0] ?? 'report';
  const root = repoRoot();
  const log = (s: string): void => { process.stderr.write(`${s}\n`); };

  if (cmd === '--help' || cmd === 'help') {
    process.stdout.write(
      'vibes — what behaviour does this change add, and what stopped holding?\n\n' +
        '  vibes collect [--write]     run every suite; --write updates ' + LEDGER + '\n' +
        '  vibes report --base REF     diff against REF and render markdown\n\n' +
        'Exit: 0 ok · 1 a behaviour broke or was removed · 2 usage · 3 a suite could not run\n',
    );
    return EXIT.OK;
  }

  if (cmd === 'collect') {
    const r = collect(root, log);
    for (const p of r.problems) log(`vibes: ${p}`);
    if (r.behaviours.length === 0 && r.problems.length > 0) return EXIT.COLLECT;
    const text = serializeLedger(r.behaviours);
    if (argv.includes('--write')) {
      writeFileSync(join(root, LEDGER), text);
      log(`vibes: wrote ${LEDGER} — ${r.behaviours.length} behaviour(s)`);
    } else {
      process.stdout.write(text);
    }
    return EXIT.OK;
  }

  if (cmd !== 'report') {
    process.stderr.write(`vibes: unknown command "${cmd}"\n`);
    return EXIT.USAGE;
  }

  const base = flag(argv, 'base');
  if (base === undefined || base === '') {
    process.stderr.write('vibes report: --base REF is required\n');
    return EXIT.USAGE;
  }

  const r = collect(root, log);
  for (const p of r.problems) log(`vibes: ${p}`);
  if (r.behaviours.length === 0 && r.problems.length > 0) return EXIT.COLLECT;

  const d = diffLedgers(ledgerAt(root, base), r.behaviours, r.silentSuites);

  // Coverage is optional. Absent, the report says so by name rather than
  // rendering 0% — "not measured" and "nothing ran" are different claims.
  const sources: LcovSource[] = [
    { path: join(root, 'Software/Control/vibes/artifacts/coverage/lcov.info'), prefix: 'Software/Control/' },
  ];
  let cov = null;
  try {
    cov = patchCoverage(root, base, sources, interesting);
  } catch (e) {
    log(`vibes: coverage unavailable — ${(e as Error).message}`);
  }

  const md = renderMarkdown(d, cov);
  process.stdout.write(md);

  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') appendFileSync(summary, md);

  // The committed ledger drifting from reality makes every future diff wrong,
  // so say so — but do not fail on it, because a PR that adds behaviour will
  // legitimately differ until the author runs `collect --write`.
  const committed = join(root, LEDGER);
  if (existsSync(committed) && readFileSync(committed, 'utf8') !== serializeLedger(r.behaviours)) {
    log(`vibes: ${LEDGER} is out of date — run \`vibes collect --write\` and commit it`);
  }

  // A suite that failed to report is a collection failure even when every
  // OTHER suite is green — silence must not be able to hide inside a pass.
  if (d.unreported.length > 0) return EXIT.COLLECT;
  return hasRegression(d) ? EXIT.REGRESSION : EXIT.OK;
}
