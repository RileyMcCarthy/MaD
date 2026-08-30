/**
 * Vibes producer — G-code → machine move buffers.
 *
 * CONTRACT: a producer WRITES. It never asserts. An assertion failure would
 * mark the producer `failed`, which invalidates its whole output directory —
 * so the tool would report `not-run` at exactly the moment behaviour changed.
 *
 * Output goes to $VIBES_OUT_DIR, which points at a gitignored received/ tree.
 * `vibes accept` is the only thing that ever writes a committed baseline.
 *
 * Determinism: every value here descends from integer arithmetic or from
 * round3() inside src/domain/. No transcendental math reaches this output.
 * That matters — Math.sin differs by 1 ULP between arm64 and x64 on the same
 * Node version, so a producer calling waveformSample() directly would be red
 * on CI while green on an Apple Silicon workstation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gcodeLinesToProgram } from '@/domain/gcode';
import { decodeMove, decodeWaveformMove } from '@/protocol/generated/protoemb';
import catalog from '../../e2e/matrix-catalog.json' with { type: 'json' };

const OUT = process.env.VIBES_OUT_DIR;
if (!OUT) {
  console.error('VIBES_OUT_DIR is not set — run this through `vibes run`.');
  process.exit(2);
}

/* ── the snapshot grammar ───────────────────────────────────────────────
 * `case <id>` sits at column 0 and starts with a letter, so git's default
 * xfuncname heuristic captures it as the hunk header — a diff then names the
 * case that moved. Detail lines are 2 spaces + key.padEnd(10) + value; 10 is
 * a fixed constant forever, never computed from content, because a computed
 * width would re-pad every sibling line the moment one long key appears.
 */
const KEYW = 10;
class Case {
  readonly lines: string[] = [];
  constructor(readonly id: string) {}
  put(key: string, value: unknown): void {
    this.lines.push(`  ${key.padEnd(KEYW)}${String(value)}`);
  }
  note(text: string): void { this.put('note', text); }
}

function render(header: string[], cases: Case[]): string {
  const head = header.map((h) => `# ${h}`).join('\n');
  const body = cases.map((c) => [`case ${c.id}`, ...c.lines].join('\n')).join('\n\n');
  return `${head}\n\n${body}\n`;
}

function write(rel: string, text: string): void {
  const p = join(OUT!, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, 'utf8');
  console.log(`wrote ${rel} (${text.split('\n').length} lines)`);
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

/* ── corpus ─────────────────────────────────────────────────────────────
 * Hand-authored programs pin the contract and its known quirks; the M8/M10
 * matrices are derived from e2e/matrix-catalog.json so the corpus grows
 * whenever whoever owns e2e adds a cell — zero authoring here.
 */
interface Prog { id: string; lines: string[]; gauge: number; note?: string[] }

const CANONICAL = [
  'G90 ; Set absolute positioning',
  'G1 X5 F2',
  'G4 P500',
  'G91 ; Set relative positioning',
  'G1 X-3 F4',
  'G90 ; Set absolute positioning',
  'G122 ; Stop - signal test complete',
];

const programs: Prog[] = [
  { id: 'base/canonical @gauge=0', lines: CANONICAL, gauge: 0 },
  { id: 'base/canonical @gauge=15', lines: CANONICAL, gauge: 15 },
  { id: 'base/empty', lines: [], gauge: 15 },
  { id: 'base/comments-only', lines: ['; just a comment', '  ; indented'], gauge: 15,
    note: ['gcodeLinesToProgram:255 skips lines starting with ";", so a standalone',
           'comment never reaches parseGcodeToMove and emits no op.'] },
  { id: 'frame/relative-not-offset', lines: ['G91', 'G1 X10 F5'], gauge: 15,
    note: ['gauge is added only in ABSOLUTE mode (GCODE_GAUGE_FRAME_MOVE, gcode.ts:275).'] },
  { id: 'frame/dwell-not-offset', lines: ['G90', 'G4 P250'], gauge: 15,
    note: ['G4 is not a positioning move, so no gauge offset.'] },
  { id: 'waveform/sine', lines: ['G90', 'G1 X6 F31.416', 'G123 A5 F2 C3 W0'], gauge: 12,
    note: ['G123 amplitude is a RELATIVE excursion — no gauge offset. The preceding',
           'G1 to the mean carries the frame conversion (gcode.ts:257-259).'] },
  { id: 'quirk/comment-leak', lines: ['G1 X10 F5 ; X50 fast'], gauge: 15,
    note: ['LIVE DEFECT, pinned deliberately. parseGcodeToMove has no comment',
           'handling, so "X50" inside the trailing comment overwrites the real X10.',
           'parseGcodeWaveform DOES break on ";" (gcode.ts:123) — the two parsers',
           'disagree. Currently unreachable in the app because standalone comments',
           'are skipped and no emitted trailing comment carries a letter+digit',
           'token. Fixing it should change this snapshot from x=50 to x=10.'] },
  { id: 'quirk/comment-changes-command', lines: ['G0 X0 ; G1 X999'], gauge: 0,
    note: ['Same defect, worse shape: the comment changes both the COMMAND and the',
           'target. A rapid to X0 becomes a linear move to X999.'] },
  { id: 'error/x-out-of-range', lines: ['G90', 'G1 X4000 F5'], gauge: 15,
    note: ['Validation runs AFTER the gauge offset, so the message reports the',
           'machine-frame target (4015), not the authored sample-frame 4000.'] },
];

for (const cell of catalog.M8_jog as Array<{ id: string; mm: number; speed: number; roundTrip?: boolean }>) {
  const lines = ['G90', `G1 X${cell.mm} F${cell.speed}`];
  if (cell.roundTrip) lines.push(`G1 X0 F${cell.speed}`);
  lines.push('G122');
  programs.push({ id: `m8/${cell.id}`, lines, gauge: 15, note: ['src  e2e/matrix-catalog.json M8_jog'] });
}
for (const cell of catalog.M10_waveform as Array<Record<string, unknown>>) {
  const a = Number(cell.amplitude);
  const f = Number(cell.frequency);
  const c = Number(cell.cycles);
  const mean = Number(cell.distance);
  programs.push({
    id: `m10/${String(cell.id)}`,
    // Ramp velocity is 2*pi*A*f, matching waveformPeakVelocity (testProfile.ts:42).
    // Multiplication only — IEEE-deterministic, so no arch drift. round3 to match
    // what generateTestGcode itself emits.
    lines: ['G90', `G1 X${mean} F${Math.round(2 * Math.PI * a * f * 1000) / 1000}`,
            `G123 A${a} F${f} C${c} W0`, 'G122'],
    gauge: 12,
    note: ['src  e2e/matrix-catalog.json M10_waveform'],
  });
}

/* ── emit ───────────────────────────────────────────────────────────────── */
const cases: Case[] = [];
for (const p of programs) {
  const c = new Case(p.id);
  for (const n of p.note ?? []) c.note(n);
  for (const l of p.lines) c.put('in', l);
  c.put('in.len', p.lines.length);
  c.put('gauge', p.gauge);
  try {
    const ops = gcodeLinesToProgram(p.lines, p.gauge);
    c.put('out.len', ops.length);
    for (const op of ops) {
      const d = op.kind === 'move' ? decodeMove(op.buf) : decodeWaveformMove(op.buf);
      const gloss = Object.entries(d as Record<string, unknown>)
        .map(([k, v]) => `${k}=${String(v)}`).join(' ');
      c.put('bytes', `${hex(op.buf)} ${op.buf.length}B | ${op.kind} ${gloss}`);
    }
  } catch (e) {
    const err = e as Error;
    c.put('throw', `${err.name}: ${err.message}`);
  }
  cases.push(c);
}

write('program.txt', render([
  'GENERATED by `vibes run` — do not hand-edit. `vibes accept` is the only writer.',
  'fn      gcodeLinesToProgram(lines, gaugeLengthMm) -> ProgramOp[]',
  'src     src/domain/gcode.ts',
  'corpus  vibes/producers/gcode-corpus.mts',
  '',
  'Text after "|" is decodeMove/decodeWaveformMove applied to the bytes on the',
  'same line. It is a reading aid; the HEX is the contract. Hex moving while the',
  'gloss holds still means the wire format changed, not the behaviour.',
], cases));

/* The census is this producer's self-reported corpus roster. It is snapshot-
 * compared like any other file, so a removed case id renders as a named row
 * rather than a silent absence, and it is what makes `minCases` count CASES
 * rather than files (this producer emits all 19 into one file).
 *
 * It is explicitly not a security boundary: a producer that shrinks its corpus
 * AND pads this list defeats both checks. What it cannot do is make that edit
 * invisible in the diff. */
write('_vibes-census.json', JSON.stringify({ cases: cases.map((c) => c.id) }, null, 2) + '\n');

console.log(`gcode-corpus: ${cases.length} cases`);
