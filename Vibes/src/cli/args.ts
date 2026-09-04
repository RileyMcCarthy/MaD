/**
 * Hand-rolled argument parsing — no dependency for this.
 *
 * Deliberately strict: an unknown flag is an error, never ignored. A silently
 * dropped `--tier pr` would run every producer including the hour-long
 * emulator tier, and the user would have no way to tell from the output.
 */

export interface ParsedCommand {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | boolean>;
  readonly positionals: readonly string[];
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Flags that take a value. Everything else is boolean. */
export type FlagSpec = Readonly<Record<string, 'string' | 'boolean'>>;

export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedCommand {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  const command = argv[0] !== undefined && !argv[0].startsWith('-') ? argv[0] : '';
  const rest = command === '' ? argv : argv.slice(1);

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (!tok.startsWith('--')) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const name = (eq === -1 ? tok.slice(2) : tok.slice(2, eq)).trim();
    if (name === '') throw new UsageError(`malformed flag: ${tok}`);

    const kind = spec[name];
    if (kind === undefined) {
      throw new UsageError(
        `unknown flag --${name}. Known flags: ${Object.keys(spec).sort().map((f) => '--' + f).join(', ')}`,
      );
    }
    if (kind === 'boolean') {
      if (eq !== -1) throw new UsageError(`--${name} does not take a value`);
      flags.set(name, true);
      continue;
    }
    // string flag
    if (eq !== -1) {
      flags.set(name, tok.slice(eq + 1));
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new UsageError(`--${name} requires a value`);
    }
    flags.set(name, next);
    i++;
  }

  return { command, flags, positionals };
}

export const str = (p: ParsedCommand, name: string): string | undefined => {
  const v = p.flags.get(name);
  return typeof v === 'string' ? v : undefined;
};

export const bool = (p: ParsedCommand, name: string): boolean => p.flags.get(name) === true;

export const list = (p: ParsedCommand, name: string): string[] => {
  const v = str(p, name);
  return v === undefined ? [] : v.split(',').map((s) => s.trim()).filter((s) => s !== '');
};
