import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT, type ExitCode } from './exit.js';
import { str, bool, list, type ParsedCommand } from './args.js';
import { runPipeline } from './pipeline.js';
import { emitReport } from '../emit/index.js';
import { VIBES_VERSION } from './main.js';

export async function cmdRun(p: ParsedCommand, log: (s: string) => void): Promise<ExitCode> {
  const cwd = str(p, 'cwd') ?? process.cwd();
  const only = list(p, 'only');
  const skip = list(p, 'skip');

  const outcome = await runPipeline({
    cwd,
    explicitBase: str(p, 'base') ?? null,
    ...(only.length > 0 ? { only } : {}),
    ...(skip.length > 0 ? { skip } : {}),
    all: bool(p, 'all'),
    tier: str(p, 'tier'),
    vibesVersion: VIBES_VERSION,
    log,
  });

  if (outcome.report === null) return outcome.exitCode;

  // run.json is the durable artifact: `vibes report` and `vibes status` read
  // it, so a re-emit never re-runs producers (and so never silently produces
  // a DIFFERENT answer than the one CI saw).
  const stateDir = join(cwd, '.vibes');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'run.json'), JSON.stringify(outcome.report, null, 2) + '\n', 'utf8');

  const emitted = await emitReport(outcome.report, {
    outDir: join(stateDir, 'report'),
    githubStepSummary: true,
    log,
    // Without these the report lists WHAT moved but never shows the diff —
    // which is the entire product.
    ...(outcome.content !== null ? { content: outcome.content } : {}),
    ...(outcome.repoPathFor !== null ? { repoPathFor: outcome.repoPathFor } : {}),
  });

  log('');
  log(emitted.headline);
  for (const f of emitted.files) log(`  ${f}`);
  for (const t of emitted.truncations) log(`  truncated: ${String((t as { reason?: string }).reason ?? t)}`);

  return outcome.exitCode;
}
