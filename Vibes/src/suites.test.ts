/**
 * Guards on the committed suite files themselves.
 *
 * A suite command is run verbatim by CI, so a command that only works on one
 * developer's machine is a silent downgrade of what CI actually checks.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function suites(): { path: string; cmd: string }[] {
  const out = execFileSync('git', ['ls-files', '-z', '*vibes.suite.json'], { cwd: root, encoding: 'utf8' });
  return out
    .split('\0')
    .filter(Boolean)
    .map((p) => ({ path: p, cmd: JSON.parse(readFileSync(join(root, p), 'utf8')).cmd as string }));
}

describe('committed suite commands', () => {
  // The firmware suite has a macOS-only twin, native_test_noasan, because
  // AddressSanitizer fails to initialise on that host. Collecting locally means
  // pointing the suite at it — and that swap has leaked into a commit twice.
  // In CI it silently drops AddressSanitizer from the run the ledger is built
  // from, so the ledger can report a behaviour passing that the sanitized gate
  // fails.
  it('never point at an environment that exists only as a local workaround', () => {
    const leaked = suites().filter((s) => /noasan/.test(s.cmd));
    expect(leaked.map((s) => `${s.path}: ${s.cmd}`)).toEqual([]);
  });

  it('are all present and non-empty', () => {
    const found = suites();
    expect(found.length).toBeGreaterThan(0);
    for (const s of found) expect(s.cmd.trim()).not.toBe('');
  });
});
