/**
 * `vibes accept` — the ONLY thing that writes a committed baseline.
 *
 * The composer's job here is small but load-bearing: it must compute
 * `changedWitnessPaths` explicitly. The accept module deliberately refuses to
 * default it, because during a bootstrap no pre-existing snapshot has moved, so
 * the `exercised` set is empty by construction and refusal 6 would never fire.
 * A guard that silently cannot fire is worse than no guard.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT, type ExitCode } from './exit.js';
import { str, bool, list, type ParsedCommand } from './args.js';
import { runAccept, createStdioIo, targetsFromRunReport, type AcceptOptions } from '../accept/index.js';
import { openRepo, resolveBase, categorizeChangedPaths } from '../git/index.js';
import { resolveConfig } from '../config/index.js';
import type { ComponentId, RepoPath, RunReport, Sha } from '../types.js';

export async function cmdAccept(p: ParsedCommand, log: (s: string) => void): Promise<ExitCode> {
  const cwd = str(p, 'cwd') ?? process.cwd();

  let report: RunReport;
  try {
    report = JSON.parse(await readFile(join(cwd, '.vibes', 'run.json'), 'utf8')) as RunReport;
  } catch {
    process.stderr.write('vibes accept: no run found. Run `vibes run` first — accept never produces, it only promotes.\n');
    return EXIT.USAGE;
  }

  const repo = await openRepo({ cwd });
  const headSha = (await repo.revParse('HEAD')) as Sha;
  const base = await resolveBase({
    repo,
    baseRef: report.baseRef,
    explicit: str(p, 'base') ?? null,
    requireExact: true,
  });

  const config = await resolveConfig({
    repoRoot: repo.repoRoot,
    baseRef: report.baseRef,
    baseSha: base.sha,
    headSha,
    git: repo,
  });
  if (!config.ok) {
    process.stderr.write('vibes accept: config is invalid; refusing to touch any baseline.\n');
    return EXIT.CONFIG;
  }

  /* changed source ∩ this component's witness matches */
  const changed = await categorizeChangedPaths(repo, {
    base: base.sha,
    excludeDirs: config.components.flatMap((c) => c.producers.map((pp) => pp.outRepo)),
  });
  const changedSet = new Set<RepoPath>(changed.paths.map((c) => c.path));
  const changedWitnessPaths = new Map<ComponentId, readonly RepoPath[]>();
  for (const c of config.components) {
    const claimed = new Set<RepoPath>();
    for (const w of c.witnessMatches) {
      if (w.negated) continue;
      for (const m of w.matched) if (changedSet.has(m)) claimed.add(m);
    }
    changedWitnessPaths.set(c.id, [...claimed].sort());
  }

  const { targets, warnings } = targetsFromRunReport({ report, config, changedWitnessPaths });
  for (const w of warnings) log(`vibes accept: ${w}`);

  const deletions = str(p, 'accept-deletions');
  const options: AcceptOptions = {
    components: list(p, 'only'),
    producers: list(p, 'producer'),
    yes: bool(p, 'yes'),
    all: bool(p, 'all'),
    bootstrap: bool(p, 'bootstrap'),
    reason: str(p, 'reason') ?? null,
    acceptDeletions: deletions === undefined ? null : Number(deletions),
    unverifiedProducer: bool(p, 'unverified-producer'),
    dryRun: false,
    doctorAttestation: null,
    baseRef: str(p, 'base') ?? null,
  };

  const io = createStdioIo();
  const outcome = await runAccept({
    repoRoot: repo.repoRoot,
    targets,
    base: { sha: base.sha, source: base.source, confidence: base.confidence, sameAsHead: base.sameAsHead },
    headSha,
    reportBaseSha: report.baseSha,
    reportHeadSha: report.headSha,
    options,
    git: repo,
    io,
  });

  log(outcome.summary);
  for (const r of outcome.refusals) log(`  REFUSED: ${String((r as { message?: string }).message ?? r)}`);
  for (const rp of outcome.receiptsWritten) log(`  receipt: ${rp}`);

  if (outcome.refusals.length > 0) return EXIT.REFUSED;
  return outcome.exitCode === 0 ? EXIT.OK : EXIT.FINDINGS;
}
