/**
 * G-code parsing and machine-frame transformation.
 *
 * Ported from the desktop `DeviceInterface.ts` (parseGcodeToMove,
 * moveGcodeNumber, gcodeLinesToMachineMoveBuffers, resolveGaugeLengthMm).
 * Pure functions — output is `Uint8Array` (browser-safe) instead of Node Buffer.
 */

import {
  encodeMove,
  encodeWaveformMove,
  Move as ProtoMove,
  WaveformMove as ProtoWaveformMove,
  WaveformShape,
  GCode,
  GCODE_VALUE_TO_WIRE,
  GCODE_WIRE_TO_VALUE,
} from '@/protocol/generated/protoemb';
import { SampleData } from './types';

/** Moves to batch into a single TEST_MOVE message (matches firmware contract). */
export const BATCH_MOVE_COUNT = 32;

/**
 * G-codes whose absolute X target is in the *sample* frame and must have the
 * gauge length added to reach the *machine* frame. Only true positioning moves
 * (G0 rapid, G1 linear) qualify. Arcs (G2/G3) are NOT here: current firmware has
 * no arc kinematics and executes G2/G3 as a dwell (app_motion.c), ignoring X, so
 * adding gauge to an arc target is meaningless (and could push X out of range).
 */
const GCODE_GAUGE_FRAME_MOVE = new Set([0, 1]);

/**
 * Error thrown when a Move cannot be safely encoded. The packed Move fields have
 * no range check in the codec (`packBits` silently keeps only the low bits), so a
 * value past the field width wraps to a *different physical value* — e.g. an X
 * target beyond the encodable range flips to the opposite extreme. We reject such
 * moves before they reach the wire rather than command unintended motion.
 */
export class MoveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoveValidationError';
  }
}

/** Encodable range of a packed Move numeric field, derived from the wire codec
 *  (bit width / offset / scale must match `encodeMove` in the generated codec). */
function packedFieldRange(bits: number, offset: number, scale: number) {
  return { min: offset, max: (2 ** bits - 1) / scale + offset };
}

/** Safe ranges for Move fields. Outside these, the codec bit-wraps the value. */
export const MOVE_FIELD_RANGE = {
  x: packedFieldRange(22, -200, 1000), // mm   → [-200, 3994.303]
  f: packedFieldRange(22, 0, 1000), //    mm/s → [0, 4194.303]
  p: packedFieldRange(16, 0, 1), //       ms   → [0, 65535]
} as const;

/** Encodable ranges of the packed WaveformMove fields (must match encodeWaveformMove). */
export const WAVEFORM_FIELD_RANGE = {
  amplitude: packedFieldRange(22, 0, 1000), // mm    → [0, 4194.303]
  frequency: packedFieldRange(20, 0, 1000), // Hz    → [0, 1048.575]
  cycles: packedFieldRange(24, 1, 1), //      count → [1, 16777216]
} as const;

function assertFieldInRange(
  name: string,
  value: number,
  range: { min: number; max: number },
  unit: string,
): void {
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    throw new MoveValidationError(
      `Move ${name}=${value} ${unit} is outside the encodable range ` +
        `[${range.min}, ${Math.round(range.max * 1000) / 1000}] ${unit}; refusing to send.`,
    );
  }
}

/**
 * Validate a Move against the codec's encodable ranges and the known G-code set.
 * Throws `MoveValidationError` on a value that would bit-wrap or a G-code that
 * would be coerced to a rapid move. Call before `encodeMove` on any path that
 * commands real motion.
 */
export function validateMove(move: ProtoMove): void {
  if (GCODE_VALUE_TO_WIRE[move.g as number] === undefined) {
    throw new MoveValidationError(
      `Unsupported G-code G${moveGcodeNumber(move.g)}: refusing to send ` +
        `(unknown commands are otherwise sent as a rapid move).`,
    );
  }
  assertFieldInRange('X', move.x, MOVE_FIELD_RANGE.x, 'mm');
  assertFieldInRange('F', move.f, MOVE_FIELD_RANGE.f, 'mm/s');
  assertFieldInRange('P', move.p, MOVE_FIELD_RANGE.p, 'ms');
}

/** Validate then encode a Move (single choke point for motion-commanding code). */
export function validateAndEncodeMove(move: ProtoMove): Uint8Array {
  validateMove(move);
  return encodeMove(move);
}

/**
 * Parse a `G123` waveform canned-cycle line into a WaveformMove. Params:
 *   A=amplitude(mm)  F=frequency(Hz)  C=cycles  W=shape(0=sine,1=triangle).
 * Returns null if the line is not a G123. The waveform oscillates about the
 * machine's current position (the program ramps to the mean with a preceding G1).
 */
export function parseGcodeWaveform(line: string): ProtoWaveformMove | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0].toUpperCase() !== 'G123') return null;

  let amplitude = 0; // mm
  let frequency = 0; // Hz
  let cycles = 0; // count
  let shape: WaveformShape = WaveformShape.SINE;

  for (const token of tokens) {
    if (token.length === 0) continue;
    const code = token[0].toUpperCase();
    if (code === ';') break; // trailing comment
    const value = parseFloat(token.substring(1));
    if (Number.isNaN(value)) continue;
    switch (code) {
      case 'A':
        amplitude = value;
        break;
      case 'F':
        frequency = value;
        break;
      case 'C':
        cycles = Math.round(value);
        break;
      case 'W':
        shape = value === 1 ? WaveformShape.TRIANGLE : WaveformShape.SINE;
        break;
      default:
        break;
    }
  }

  return { shape, amplitude, frequency, cycles };
}

/** Validate a WaveformMove against the codec's encodable ranges (prevents bit-wrap). */
export function validateWaveform(wf: ProtoWaveformMove): void {
  // A waveform with zero amplitude or frequency is physically meaningless
  // (no motion / infinite period); reject rather than emit a no-op record.
  if (!(wf.amplitude > 0) || !(wf.frequency > 0)) {
    throw new MoveValidationError(
      `Waveform requires amplitude > 0 and frequency > 0 (got A=${wf.amplitude} mm, f=${wf.frequency} Hz).`,
    );
  }
  assertFieldInRange('amplitude', wf.amplitude, WAVEFORM_FIELD_RANGE.amplitude, 'mm');
  assertFieldInRange('frequency', wf.frequency, WAVEFORM_FIELD_RANGE.frequency, 'Hz');
  assertFieldInRange('cycles', wf.cycles, WAVEFORM_FIELD_RANGE.cycles, 'cycles');
}

/** Validate then encode a WaveformMove. */
export function validateAndEncodeWaveform(wf: ProtoWaveformMove): Uint8Array {
  validateWaveform(wf);
  return encodeWaveformMove(wf);
}

/**
 * A single item in an uploadable program: a binary Move (sent via `test_move`)
 * or a binary WaveformMove (sent via `test_waveform`). Order is preserved so the
 * firmware appends them to the SD program in sequence.
 */
export type ProgramOp =
  | { kind: 'move'; buf: Uint8Array }
  | { kind: 'waveform'; buf: Uint8Array };

/** Parse a G-code text line into a ProtoMove. Returns null if unparseable. */
export function parseGcodeToMove(line: string): ProtoMove | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length === 0) return null;

  let g = 0;
  let x = 0; // mm
  let f = 0; // mm/s
  let p = 0; // ms

  for (const token of tokens) {
    if (token.length === 0) continue;
    const code = token[0].toUpperCase();
    // Stop at a trailing comment. Without this, a token inside the comment is
    // parsed as a parameter: `G1 X10 F5 ; X50 fast` moved to X50, and
    // `G0 X0 ; G1 X999` changed both the command and the target. Matches
    // parseGcodeWaveform, which has always had this guard.
    if (code === ';') break;
    const value = parseFloat(token.substring(1));
    if (Number.isNaN(value)) continue;

    switch (code) {
      case 'G':
        g = Math.round(value);
        break;
      case 'X':
        x = value;
        break;
      case 'F':
        f = value;
        break;
      case 'P':
        p = Math.round(value);
        break;
      default:
        break;
    }
  }

  return { g: g as GCode, x, f, p };
}

/** G-code command number (0, 1, 90, 91, …) from a Move.g (wire index or literal). */
export function moveGcodeNumber(g: GCode): number {
  const raw = g as number;
  if (GCODE_VALUE_TO_WIRE[raw] !== undefined) {
    return raw;
  }
  return GCODE_WIRE_TO_VALUE[raw] ?? raw;
}

/**
 * Resolve gauge length (mm) for sample → machine G-code conversion.
 * Falls back to (machine − sample) position from the latest sample.
 */
export function resolveGaugeLengthMm(
  gaugeLengthMm: number | undefined,
  lastSample: SampleData | null,
): number {
  if (gaugeLengthMm !== undefined && Number.isFinite(gaugeLengthMm)) {
    return gaugeLengthMm;
  }
  if (lastSample) {
    const machineMm = lastSample['Machine Position (mm)'];
    const sampleMm = lastSample['Sample Position (mm)'];
    if (Number.isFinite(machineMm) && Number.isFinite(sampleMm)) {
      const g = machineMm - sampleMm;
      if (Number.isFinite(g)) return g;
    }
  }
  return 0;
}

/**
 * Parse profile G-code (sample frame, mm) and encode moves in the machine
 * frame for the firmware SD card. Absolute G0/G1 targets get gauge length
 * added; G91 relative deltas are left unchanged.
 */
export function gcodeLinesToProgram(lines: string[], gaugeLengthMm: number): ProgramOp[] {
  let absoluteMode = true;
  const ops: ProgramOp[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith(';')) continue;

    // Waveform canned cycle (G123): its params don't fit a Move, so it becomes a
    // separate WaveformMove record. Amplitude is a relative excursion → no gauge
    // offset (the preceding G1 to the mean carries the frame conversion).
    if (/^G123\b/i.test(trimmed)) {
      const wf = parseGcodeWaveform(trimmed);
      if (!wf) continue;
      ops.push({ kind: 'waveform', buf: validateAndEncodeWaveform(wf) });
      continue;
    }

    const move = parseGcodeToMove(trimmed);
    if (!move) continue;

    const gNum = moveGcodeNumber(move.g);
    if (gNum === 90) {
      absoluteMode = true;
    } else if (gNum === 91) {
      absoluteMode = false;
    } else if (
      absoluteMode &&
      GCODE_GAUGE_FRAME_MOVE.has(gNum) &&
      Number.isFinite(gaugeLengthMm)
    ) {
      move.x += gaugeLengthMm;
    }

    // Validate after the gauge offset (so the actual machine-frame target is
    // checked) and fail the whole upload loudly rather than wrap a value.
    ops.push({ kind: 'move', buf: validateAndEncodeMove(move) });
  }

  return ops;
}

/**
 * Move-only convenience over {@link gcodeLinesToProgram}. Throws if the program
 * contains a waveform (those require the ordered `test_waveform` upload path).
 */
export function gcodeLinesToMachineMoveBuffers(
  lines: string[],
  gaugeLengthMm: number,
): Uint8Array[] {
  return gcodeLinesToProgram(lines, gaugeLengthMm).map((op) => {
    if (op.kind !== 'move') {
      throw new MoveValidationError('Program contains a G123 waveform; use gcodeLinesToProgram for upload.');
    }
    return op.buf;
  });
}

/** Concatenate move buffers into batches of `BATCH_MOVE_COUNT` for TEST_MOVE. */
export function batchMoveBuffers(
  moveBuffers: Uint8Array[],
  batchCount = BATCH_MOVE_COUNT,
): Uint8Array[] {
  const batches: Uint8Array[] = [];
  for (let i = 0; i < moveBuffers.length; i += batchCount) {
    const slice = moveBuffers.slice(i, i + batchCount);
    const total = slice.reduce((n, b) => n + b.length, 0);
    const batch = new Uint8Array(total);
    let offset = 0;
    for (const b of slice) {
      batch.set(b, offset);
      offset += b.length;
    }
    batches.push(batch);
  }
  return batches;
}
