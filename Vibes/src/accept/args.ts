/**
 * `vibes accept` argument parsing.
 *
 * Hand-rolled: the runtime dependency list is exactly three packages, and an
 * arg parser is the classic fourth. It is also the one place where a
 * "helpful" library is actively harmful — `--yes` must never be inferred from
 * a bare `-y` bundled into `-ay`, and an unknown flag must be an ERROR rather
 * than a positional, because `--acceptdeletions=3` silently becoming a producer
 * name is how an unauthorised deletion gets authorised.
 */

import type { AcceptOptions } from './model.js';
import { DEFAULT_ACCEPT_OPTIONS } from './model.js';

export interface ParsedArgs {
  readonly options: AcceptOptions;
  readonly errors: readonly string[];
  readonly help: boolean;
}

const VALUE_FLAGS = new Set([
  '--component',
  '--producer',
  '--reason',
  '--accept-deletions',
  '--doctor-attestation',
  '--base',
]);

const BOOL_FLAGS = new Set([
  '--yes',
  '-y',
  '--all',
  '--bootstrap',
  '--unverified-producer',
  '--dry-run',
  '--help',
  '-h',
]);

export const ACCEPT_USAGE = `vibes accept [<component/producer>…] [options]

  Copies received snapshots over their committed baselines and writes a receipt
  that says who accepted what, how, and why.

  --component <id>          restrict to a component (repeatable)
  --producer <c/p|name>     restrict to a producer (repeatable)
  --yes, -y                 do not review each file; records mode "bulk"
  --all                     implies --yes; records acceptedBy "--all"
  --bootstrap               first-ever baselines; needs a doctor attestation
  --reason <text>           required whenever the mode is not "reviewed"
  --accept-deletions <n>    authorise exactly n baseline deletions
  --unverified-producer     accept from a producer CI has never run
  --doctor-attestation <p>  override .vibes/doctor.json
  --base <rev>              explicit comparison point
  --dry-run                 print the plan and write nothing
  -h, --help

  Refuses outright, writing nothing, when CI is set. There is no override.`;

export function parseAcceptArgs(argv: readonly string[]): ParsedArgs {
  const errors: string[] = [];
  const components: string[] = [];
  const producers: string[] = [];
  let yes = false;
  let all = false;
  let bootstrap = false;
  let unverifiedProducer = false;
  let dryRun = false;
  let help = false;
  let reason: string | null = null;
  let acceptDeletions: number | null = null;
  let doctorAttestation: string | null = null;
  let baseRef: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--') {
      for (const rest of argv.slice(i + 1)) producers.push(rest);
      break;
    }

    let name = arg;
    let inline: string | null = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      name = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }

    if (VALUE_FLAGS.has(name)) {
      let value = inline;
      if (value === null) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          errors.push(`${name} requires a value`);
          continue;
        }
        value = next;
        i += 1;
      }
      switch (name) {
        case '--component':
          components.push(value);
          break;
        case '--producer':
          producers.push(value);
          break;
        case '--reason':
          reason = reason === null ? value : `${reason} ${value}`;
          break;
        case '--doctor-attestation':
          doctorAttestation = value;
          break;
        case '--base':
          baseRef = value;
          break;
        case '--accept-deletions': {
          // Strict: `--accept-deletions=3x` must not silently mean 3. The
          // number is a claim that the operator counted the deletions.
          if (!/^\d+$/.test(value)) {
            errors.push(`--accept-deletions expects a non-negative integer, got ${JSON.stringify(value)}`);
            break;
          }
          acceptDeletions = Number.parseInt(value, 10);
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (BOOL_FLAGS.has(name)) {
      if (inline !== null) errors.push(`${name} takes no value`);
      switch (name) {
        case '--yes':
        case '-y':
          yes = true;
          break;
        case '--all':
          all = true;
          break;
        case '--bootstrap':
          bootstrap = true;
          break;
        case '--unverified-producer':
          unverifiedProducer = true;
          break;
        case '--dry-run':
          dryRun = true;
          break;
        default:
          help = true;
          break;
      }
      continue;
    }

    if (arg.startsWith('-')) {
      errors.push(`unknown flag ${arg}`);
      continue;
    }
    producers.push(arg);
  }

  // `--all` bypasses the per-file offer, so it necessarily implies --yes.
  // Keeping them independent would leave `--all` on a TTY prompting per file
  // while stamping the receipt "--all", which would be a false statement.
  if (all) yes = true;

  const options: AcceptOptions = {
    ...DEFAULT_ACCEPT_OPTIONS,
    components,
    producers,
    yes,
    all,
    bootstrap,
    reason,
    acceptDeletions,
    unverifiedProducer,
    dryRun,
    doctorAttestation,
    baseRef,
  };
  return { options, errors, help };
}
