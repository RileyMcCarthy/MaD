import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT, type ExitCode } from './exit.js';
import { str, bool, type ParsedCommand } from './args.js';
import type { RunReport, SnapState } from '../types.js';

export async function cmdStatus(p: ParsedCommand, log: (s: string) => void): Promise<ExitCode> {
  const cwd = str(p, 'cwd') ?? process.cwd();
  let report: RunReport;
  try {
    report = JSON.parse(await readFile(join(cwd, '.vibes', 'run.json'), 'utf8')) as RunReport;
  } catch {
    if (bool(p, 'json')) { log(JSON.stringify({ ok: false, reason: 'no-run' })); return EXIT.USAGE; }
    process.stderr.write('vibes status: no run found. Run `vibes run` first.\n');
    return EXIT.USAGE;
  }

  const tally: Record<string, number> = {};
  for (const c of report.components)
    for (const s of c.snapshots) tally[s.state] = (tally[s.state] ?? 0) + 1;

  if (bool(p, 'json')) {
    log(JSON.stringify({
      ok: report.exitCode === 0,
      fullyVerified: report.fullyVerified,
      baseSha: report.baseSha, headSha: report.headSha,
      exitCode: report.exitCode,
      snapshots: tally,
      findings: report.findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title })),
    }));
    return report.exitCode as ExitCode;
  }

  // Lead with the WORST state present, never a count and never a badge — a
  // skimming reader takes away "green" otherwise, and six states is more than
  // anyone holds in their head.
  const worst: SnapState | null =
    (['not-run', 'deleted', 'changed', 'added', 'not-selected', 'verified-unchanged'] as const)
      .find((s) => (tally[s] ?? 0) > 0) ?? null;

  log(report.fullyVerified
    ? `vibes: every declared producer ran. Worst state: ${worst ?? 'none'}.`
    : `vibes: NOT all declared producers ran — nothing here claims "unchanged". Worst state: ${worst ?? 'none'}.`);
  for (const [k, v] of Object.entries(tally).sort()) log(`  ${k.padEnd(20)} ${v}`);
  for (const f of report.findings) log(`  ${f.severity.toUpperCase()}: ${f.title}`);
  return report.exitCode as ExitCode;
}
