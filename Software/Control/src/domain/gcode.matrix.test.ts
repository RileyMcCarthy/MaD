/**
 * M2 — Move / waveform packed-field bounds matrix (parameterized).
 *
 * The codec bit-packs Move/WaveformMove; values outside the field width wrap
 * to a different physical command. validateMove/validateWaveform must reject.
 */
import { describe, it, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  validateMove,
  validateAndEncodeMove,
  validateWaveform,
  MoveValidationError,
  MOVE_FIELD_RANGE,
  WAVEFORM_FIELD_RANGE,
  parseGcodeToMove,
  gcodeLinesToMachineMoveBuffers,
} from './gcode';
import { GCode, WaveformShape, decodeMove } from '@/protocol/generated/protoemb';

const LEGAL_G: GCode[] = [0, 1, 2, 3, 4, 28, 90, 91, 122] as GCode[];
const ILLEGAL_G = [5, 6, 7, 10, 92, 99, 255] as unknown as GCode[];

describe('M2 move matrix: legal G-codes at origin', () => {
  behaviour(
    {
      id: 'matrix.legal-commands-at-origin-accepted',
      covers: 'src/domain/gcode.ts#validateMove',
      given: 'every command the machine implements, with target, speed, and pause at zero',
      expect: { 'all-accepted': 'each is accepted for sending' },
    },
    () => {
      for (const { g } of LEGAL_G.map((g) => ({ g }))) {
        expect(() => validateMove({ g, x: 0, f: 0, p: 0 })).not.toThrow();
      }
    },
  );
});

describe('M2 move matrix: illegal G-codes rejected', () => {
  behaviour(
    {
      id: 'matrix.unknown-commands-refused',
      covers: 'src/domain/gcode.ts#validateMove',
      given: 'command numbers the machine does not implement',
      expect: { refused: 'the move is refused before it is sent' },
      why: { refused: 'an unknown command is otherwise packed as a rapid move' },
    },
    () => {
      for (const { g } of ILLEGAL_G.map((g) => ({ g }))) {
        expect(() => validateMove({ g, x: 0, f: 0, p: 0 })).toThrow(MoveValidationError);
      }
    },
  );
});

describe('M2 move matrix: X bounds', () => {
  behaviour(
    {
      id: 'matrix.move-target-bounds',
      covers: 'src/domain/gcode.ts#validateAndEncodeMove',
      given: 'linear-move targets at the codec bounds, inside them, and past them, including a non-finite value',
      expect: {
        'in-range-round-trip': 'targets in range encode and decode back to the same position',
        'out-of-range-refused': 'the out-of-range and non-finite targets are refused',
      },
      why: {
        'out-of-range-refused': 'a value past the packed field width wraps to a different position',
      },
    },
    () => {
      for (const { x, ok } of [
        { x: MOVE_FIELD_RANGE.x.min, ok: true },
        { x: MOVE_FIELD_RANGE.x.max, ok: true },
        { x: 0, ok: true },
        { x: 10.25, ok: true },
        { x: -0.001, ok: true },
        { x: MOVE_FIELD_RANGE.x.min - 0.001, ok: false },
        { x: MOVE_FIELD_RANGE.x.max + 1, ok: false },
        { x: Number.NaN, ok: false },
        { x: Number.POSITIVE_INFINITY, ok: false },
      ]) {
        const move = { g: 1 as GCode, x, f: 5, p: 0 };
        if (ok) {
          expect(() => validateMove(move)).not.toThrow();
          const back = decodeMove(validateAndEncodeMove(move));
          expect(back.x).toBeCloseTo(x, 2);
        } else {
          expect(() => validateMove(move)).toThrow(MoveValidationError);
        }
      }
    },
  );
});

describe('M2 move matrix: F bounds', () => {
  behaviour(
    {
      id: 'matrix.move-speed-bounds',
      covers: 'src/domain/gcode.ts#validateMove',
      given: 'linear-move speeds at zero, at the codec maximum, inside the range, and past it, including a negative and a non-number',
      expect: {
        'in-range-accepted': 'zero, the maximum, and anything between are accepted',
        'out-of-range-refused': 'past the maximum, negative, and non-numeric are refused',
      },
    },
    () => {
      for (const { f, ok } of [
        { f: 0, ok: true },
        { f: MOVE_FIELD_RANGE.f.max, ok: true },
        { f: 5, ok: true },
        { f: MOVE_FIELD_RANGE.f.max + 1, ok: false },
        { f: -0.001, ok: false },
        { f: Number.NaN, ok: false },
      ]) {
        const move = { g: 1 as GCode, x: 0, f, p: 0 };
        if (ok) expect(() => validateMove(move)).not.toThrow();
        else expect(() => validateMove(move)).toThrow(MoveValidationError);
      }
    },
  );
});

describe('M2 move matrix: P (dwell) bounds', () => {
  behaviour(
    {
      id: 'matrix.pause-duration-bounds',
      covers: 'src/domain/gcode.ts#validateMove',
      given: 'pause durations at zero, one millisecond, the codec maximum, one past the maximum, and a negative duration',
      expect: {
        'in-range-accepted': 'durations up to the maximum are accepted',
        'out-of-range-refused': 'the over-range and negative durations are refused',
      },
    },
    () => {
      for (const { p, ok } of [
        { p: 0, ok: true },
        { p: 1, ok: true },
        { p: MOVE_FIELD_RANGE.p.max, ok: true },
        { p: MOVE_FIELD_RANGE.p.max + 1, ok: false },
        { p: -1, ok: false },
      ]) {
        const move = { g: 4 as GCode, x: 0, f: 0, p };
        if (ok) expect(() => validateMove(move)).not.toThrow();
        else expect(() => validateMove(move)).toThrow(MoveValidationError);
      }
    },
  );
});

describe('M2 waveform matrix: amplitude / frequency / cycles', () => {
  behaviour(
    {
      id: 'matrix.waveform-param-bounds',
      covers: 'src/domain/gcode.ts#validateWaveform',
      given: 'waveform amplitude, frequency, and cycles at the smallest positive value, at the codec maximum, past the maximum, and at zero or negative',
      expect: {
        'all-three-in-range-accepted':
          'a waveform with all three values positive and in range is accepted',
        'any-out-of-range-refused':
          'a waveform with any of the three at zero, negative, or past the maximum is refused',
      },
    },
    () => {
      for (const { amplitude, frequency, cycles, ok } of [
        { amplitude: 0, frequency: 1, cycles: 1, ok: false }, // requires A > 0
        { amplitude: 0.001, frequency: 1, cycles: 1, ok: true },
        { amplitude: 5, frequency: 1, cycles: 2, ok: true },
        { amplitude: WAVEFORM_FIELD_RANGE.amplitude.max, frequency: 1, cycles: 1, ok: true },
        { amplitude: WAVEFORM_FIELD_RANGE.amplitude.max + 1, frequency: 1, cycles: 1, ok: false },
        { amplitude: 5, frequency: WAVEFORM_FIELD_RANGE.frequency.max + 1, cycles: 1, ok: false },
        { amplitude: 5, frequency: 0, cycles: 1, ok: false },
        { amplitude: 5, frequency: 1, cycles: 0, ok: false },
        { amplitude: 5, frequency: 1, cycles: WAVEFORM_FIELD_RANGE.cycles.max + 1, ok: false },
        { amplitude: -1, frequency: 1, cycles: 1, ok: false },
      ]) {
        const wf = { shape: WaveformShape.SINE, amplitude, frequency, cycles };
        if (ok) {
          expect(() => validateWaveform(wf)).not.toThrow();
        } else {
          expect(() => validateWaveform(wf)).toThrow(MoveValidationError);
        }
      }
    },
  );

  behaviour(
    {
      id: 'matrix.waveform-shapes-accepted',
      covers: 'src/domain/gcode.ts#validateWaveform',
      given: 'a sine waveform and a triangle waveform at nominal amplitude, frequency, and cycles',
      expect: { 'both-accepted': 'both are accepted for sending' },
    },
    () => {
      for (const { shape } of [
        { shape: WaveformShape.SINE, label: 'sine' },
        { shape: WaveformShape.TRIANGLE, label: 'triangle' },
      ]) {
        const wf = { shape, amplitude: 3, frequency: 1.5, cycles: 4 };
        expect(() => validateWaveform(wf)).not.toThrow();
      }
    },
  );
});

describe('M2 gcode line corpus (whitespace / comments / modes)', () => {
  behaviour(
    {
      id: 'matrix.gcode-line-parse-whitespace',
      covers: 'src/domain/gcode.ts#parseGcodeToMove',
      given: 'move, pause, home, and stop lines, with extra whitespace and a trailing comment',
      expect: {
        'authored-values-kept': 'each parses to the command, target, and speed the author wrote',
      },
    },
    () => {
      for (const { line, g, x, f } of [
        { line: 'G1 X10 F5', g: 1, x: 10, f: 5 },
        { line: '  G1   X10  F5  ', g: 1, x: 10, f: 5 },
        { line: 'G1 X10 F5 ; comment', g: 1, x: 10, f: 5 },
        { line: 'G4 P100', g: 4, x: 0, f: 0 },
        { line: 'G122', g: 122, x: 0, f: 0 },
        { line: 'G28', g: 28, x: 0, f: 0 },
      ]) {
        const m = parseGcodeToMove(line);
        expect(m).not.toBeNull();
        expect(m!.g).toBe(g);
        expect(m!.x).toBeCloseTo(x, 6);
        expect(m!.f).toBeCloseTo(f, 6);
      }
    },
  );

  behaviour(
    {
      id: 'matrix.arc-keeps-authored-target',
      covers: 'src/domain/gcode.ts#gcodeLinesToMachineMoveBuffers',
      given: 'an absolute arc to 5 mm with 15 mm of gauge length',
      expect: {
        'target-unchanged': 'the target is sent through unchanged, with no gauge-length offset added',
      },
      why: {
        'target-unchanged': 'an arc is executed as a pause, so its target is not a machine-frame position',
      },
    },
    () => {
      const bufs = gcodeLinesToMachineMoveBuffers(['G90', 'G2 X5 I1'], 15);
      expect(decodeMove(bufs[1]).x).toBeCloseTo(5, 3);
    },
  );

  /* claimed by gcode.gauge-offsets-absolute-moves */
  it('absolute G1 receives gauge length', () => {
    const bufs = gcodeLinesToMachineMoveBuffers(['G90', 'G1 X10 F5'], 15);
    expect(decodeMove(bufs[1]).x).toBeCloseTo(25, 3);
  });
});
