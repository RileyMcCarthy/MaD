/**
 * `vibes` — command dispatch.
 *
 * Every command returns an exit code rather than calling process.exit, so the
 * whole CLI is testable in-process and a partially-written report is never
 * abandoned by an exit in the middle of an await.
 */
import { EXIT, type ExitCode } from './exit.js';
import { parseArgs, UsageError, type FlagSpec } from './args.js';
import { cmdRun } from './run.js';
import { cmdReport } from './report.js';
import { cmdStatus } from './status.js';
import { cmdDoctor } from './doctor.js';
import { cmdInit } from './init.js';
import { cmdAccept } from './accept.js';

export const VIBES_VERSION = '0.1.0';

const USAGE = `vibes ${VIBES_VERSION} — behaviour snapshots + test reporting

  vibes run        run producers, compare against the base, write a report
  vibes report     re-emit the report from the last run, without re-running
  vibes accept     review changed snapshots and update the committed baseline
  vibes status     one-line summary of the last run (--json for machine use)
  vibes doctor     validate config and prove producers are deterministic
  vibes init       scaffold a registry entry and a component manifest

Common flags
  --base <ref>     override the comparison base (highest precedence)
  --only a,b       restrict to these component ids
  --skip a,b       exclude these component ids
  --all            force every producer to run regardless of runWhen
  --tier <t>       select a producer tier (pr | nightly | manual)
  --json           machine-readable output where supported

Exit codes
  0 ok   1 findings   2 usage   3 config   4 base   5 producer   6 refused   70 internal
`;

const COMMON: FlagSpec = {
  base: 'string', only: 'string', skip: 'string', all: 'boolean',
  tier: 'string', json: 'boolean', help: 'boolean', version: 'boolean',
  cwd: 'string',
};

const SPECS: Readonly<Record<string, FlagSpec>> = {
  run: COMMON,
  report: { ...COMMON, out: 'string' },
  status: COMMON,
  init: { ...COMMON, component: 'string', root: 'string' },
  doctor: { ...COMMON, repeat: 'string', producer: 'string' },
  accept: {
    ...COMMON,
    yes: 'boolean', reason: 'string', bootstrap: 'boolean',
    'accept-deletions': 'string', 'unverified-producer': 'boolean',
    producer: 'string',
  },
};

export async function main(argv: readonly string[]): Promise<ExitCode> {
  const log = (line: string): void => { process.stdout.write(line + '\n'); };

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') {
    log(USAGE);
    return EXIT.OK;
  }
  if (argv[0] === '--version') { log(VIBES_VERSION); return EXIT.OK; }

  const command = argv[0]!;
  const spec = SPECS[command];
  if (spec === undefined) {
    process.stderr.write(`vibes: unknown command "${command}"\n\n${USAGE}`);
    return EXIT.USAGE;
  }

  let parsed;
  try {
    parsed = parseArgs(argv, spec);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`vibes ${command}: ${err.message}\n`);
      return EXIT.USAGE;
    }
    throw err;
  }

  if (parsed.flags.get('help') === true) { log(USAGE); return EXIT.OK; }

  switch (command) {
    case 'run': return cmdRun(parsed, log);
    case 'report': return cmdReport(parsed, log);
    case 'accept': return cmdAccept(parsed, log);
    case 'status': return cmdStatus(parsed, log);
    case 'doctor': return cmdDoctor(parsed, log);
    case 'init': return cmdInit(parsed, log);
    default:
      process.stderr.write(`vibes: unhandled command "${command}"\n`);
      return EXIT.USAGE;
  }
}
