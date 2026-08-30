import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT, type ExitCode } from './exit.js';
import { str, type ParsedCommand } from './args.js';
import { emitReport } from '../emit/index.js';
import type { RunReport } from '../types.js';

/** Re-emit from the durable run.json. Deliberately does NOT re-run producers:
 *  a re-emit that re-ran could print a different answer than the one CI saw,
 *  which is the exact class of lie this tool exists to prevent. */
export async function cmdReport(p: ParsedCommand, log: (s: string) => void): Promise<ExitCode> {
  const cwd = str(p, 'cwd') ?? process.cwd();
  const runPath = join(cwd, '.vibes', 'run.json');

  let report: RunReport;
  try {
    report = JSON.parse(await readFile(runPath, 'utf8')) as RunReport;
  } catch {
    process.stderr.write(`vibes report: no run found at ${runPath}. Run \`vibes run\` first.\n`);
    return EXIT.USAGE;
  }

  const emitted = await emitReport(report, {
    outDir: str(p, 'out') ?? join(cwd, '.vibes', 'report'),
    githubStepSummary: true,
    log,
  });
  log(emitted.headline);
  for (const f of emitted.files) log(`  ${f}`);
  return report.exitCode as ExitCode;
}
