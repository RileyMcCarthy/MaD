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
  /** The TEST's stable id. Its expectations hang off it. */
  readonly id: string;
  // Write `given` and `then` for a reader who has NEVER seen the code: no
  // internal type names, no parameter letters. "exactly one pause is produced,
  // its duration kept in milliseconds" — not "one op is emitted and P
  // survives". See ../SCHEMA.md, "Writing the claim".
  /** `path#symbol`, repo-relative, so a reader can find the code this claim is about. */
  readonly covers?: string;
  /** The condition this test sets up. Shared by every expectation below. */
  readonly given: string;
  /** What the machine does, one entry per expectation, keyed by a short id
   *  that is stable across rewording. Identity is the KEY, never the text and
   *  never the position — so rewording one expectation is a change to that
   *  expectation and leaves its siblings alone. */
  readonly expect: Readonly<Record<string, string>>;
  /** The standing requirement an expectation serves, keyed by the same id.
   *  Only for expectations whose claim does not already carry it. */
  readonly why?: Readonly<Record<string, string>>;
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

  // One line per expectation. They share the test's condition and coverage;
  // what differs is the expectation's own id and text.
  for (const [expect, then] of Object.entries(b.expect)) {
    const record: Record<string, string | number> = {
      v: 2,
      id: b.id,
      expect,
      lang: 'ts',
      file,
      test: testName,
      given: b.given,
      then,
    };
    if (b.covers !== undefined) record['covers'] = b.covers;
    const why = b.why?.[expect];
    if (why !== undefined) record['why'] = why;

    let line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE) {
      line = `${JSON.stringify({ ...record, given: '', then: '', truncated: 1 })}\n`;
    }
    try {
      appendFileSync(out, line);
    } catch {
      // A ledger that cannot be written must not fail the suite: the test's own
      // verdict is the thing that matters and it is unaffected.
    }
  }
}

/** The test name Vibes joins pass/fail on. Derived from the CONDITION, since a
 *  test now carries several expectations and no single one of them names it. */
export function behaviourTestName(b: Behaviour): string {
  return `${b.given} [${b.id}]`;
}

export function behaviour(b: Behaviour, fn: () => void | Promise<void>): void {
  const name = behaviourTestName(b);
  const file = callerFile();
  // ENTRY, not exit. A test that throws must still have been recorded, or the
  // report says the behaviour was removed when a test merely crashed.
  emit(b, name, file);
  it(name, fn);
}
