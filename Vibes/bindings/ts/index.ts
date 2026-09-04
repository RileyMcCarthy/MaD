/**
 * Vibes binding for vitest / jest.
 *
 * Declares a behaviour and runs it as an ordinary test:
 *
 *   behaviour({
 *     id: 'gcode.trailing-comment',
 *     covers: 'src/domain/gcode.ts#parseGcodeToMove',
 *     given: 'a G-code line with a trailing comment containing a coordinate token',
 *     then: 'the comment is ignored and the authored X survives',
 *   }, () => {
 *     expect(parseGcodeToMove('G1 X10 F5 ; X50 fast')).toMatchObject({ x: 10 });
 *   });
 *
 * See ../SCHEMA.md for the wire contract. Two rules from it are enforced here:
 * the line is written on ENTRY (a crashing test must still be recorded, or the
 * behaviour reads as deleted), and status is NOT written (it has not happened
 * yet — Vibes joins it from the runner's own output).
 */
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
// Imported, not taken from globalThis. `globals: true` is off by default in
// vitest, so a globalThis lookup throws on the first call — and because emit()
// runs before it, the ledger ends up with exactly one line and the suite dies.
// That failure is silent in the ledger and loud only in the runner.
import { it } from 'vitest';

export interface Behaviour {
  /** Stable across rewording. This is what makes a reworded test a metadata
   *  change rather than one behaviour deleted and another added. */
  readonly id: string;
  /** `path#symbol`, repo-relative. Joins this behaviour to patch coverage. */
  readonly covers?: string;
  readonly given: string;
  readonly then: string;
  /** Why it matters — a pinned defect, a requirement. */
  readonly why?: string;
}

/** Longest line we will append. POSIX guarantees an O_APPEND write below
 *  PIPE_BUF is atomic, so parallel vitest workers interleave without a lock.
 *  A longer line is truncated here rather than left to corrupt a neighbour. */
const MAX_LINE = 4000;

function callerFile(): string {
  // Frame 0 is Error, 1 is callerFile, 2 is behaviour(), 3 is the test file.
  const stack = new Error().stack?.split('\n') ?? [];
  const frame = stack[3] ?? '';
  const m = /\(?(\/[^):]+):\d+:\d+\)?$/.exec(frame.trim());
  const abs = m?.[1];
  if (abs === undefined) return '';
  return relative(process.cwd(), abs).split('\\').join('/');
}

export function emit(b: Behaviour, testName: string, file: string): void {
  const out = process.env['VIBES_BEHAVIOURS'];
  // Inert unless Vibes asked for it, so the suite runs normally on its own.
  if (out === undefined || out === '') return;

  const record: Record<string, string | number> = {
    v: 1,
    id: b.id,
    lang: 'ts',
    file,
    test: testName,
    given: b.given,
    then: b.then,
  };
  if (b.covers !== undefined) record['covers'] = b.covers;
  if (b.why !== undefined) record['why'] = b.why;

  let line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > MAX_LINE) {
    line = `${JSON.stringify({ ...record, given: '', then: '', truncated: 1 })}\n`;
  }
  try {
    appendFileSync(out, line);
  } catch {
    // A behaviour ledger that cannot be written must not fail the suite: the
    // test's own verdict is the thing that matters and it is unaffected.
  }
}

/** The test name Vibes joins pass/fail on. Derived, so it cannot drift. */
export function behaviourTestName(b: Behaviour): string {
  return `${b.then} [${b.id}]`;
}

export function behaviour(b: Behaviour, fn: () => void | Promise<void>): void {
  const name = behaviourTestName(b);
  const file = callerFile();
  // ENTRY, not exit. A test that throws must still have been recorded, or the
  // report says the behaviour was removed when a test merely crashed.
  emit(b, name, file);
  it(name, fn);
}
