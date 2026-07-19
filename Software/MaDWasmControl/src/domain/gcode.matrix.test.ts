/**
 * M2 — Move / waveform packed-field bounds matrix (parameterized).
 *
 * The codec bit-packs Move/WaveformMove; values outside the field width wrap
 * to a different physical command. validateMove/validateWaveform must reject.
 */
import { describe, it, expect } from 'vitest';
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
  it.each(LEGAL_G.map((g) => ({ g })))('accepts G$g at zero fields', ({ g }) => {
    expect(() => validateMove({ g, x: 0, f: 0, p: 0 })).not.toThrow();
  });
});

describe('M2 move matrix: illegal G-codes rejected', () => {
  it.each(ILLEGAL_G.map((g) => ({ g })))('rejects G$g (no silent coerce to rapid)', ({ g }) => {
    expect(() => validateMove({ g, x: 0, f: 0, p: 0 })).toThrow(MoveValidationError);
  });
});

describe('M2 move matrix: X bounds', () => {
  it.each([
    { x: MOVE_FIELD_RANGE.x.min, ok: true },
    { x: MOVE_FIELD_RANGE.x.max, ok: true },
    { x: 0, ok: true },
    { x: 10.25, ok: true },
    { x: -0.001, ok: true },
    { x: MOVE_FIELD_RANGE.x.min - 0.001, ok: false },
    { x: MOVE_FIELD_RANGE.x.max + 1, ok: false },
    { x: Number.NaN, ok: false },
    { x: Number.POSITIVE_INFINITY, ok: false },
  ])('x=$x ok=$ok', ({ x, ok }) => {
    const move = { g: 1 as GCode, x, f: 5, p: 0 };
    if (ok) {
      expect(() => validateMove(move)).not.toThrow();
      const back = decodeMove(validateAndEncodeMove(move));
      expect(back.x).toBeCloseTo(x, 2);
    } else {
      expect(() => validateMove(move)).toThrow(MoveValidationError);
    }
  });
});

describe('M2 move matrix: F bounds', () => {
  it.each([
    { f: 0, ok: true },
    { f: MOVE_FIELD_RANGE.f.max, ok: true },
    { f: 5, ok: true },
    { f: MOVE_FIELD_RANGE.f.max + 1, ok: false },
    { f: -0.001, ok: false },
    { f: Number.NaN, ok: false },
  ])('f=$f ok=$ok', ({ f, ok }) => {
    const move = { g: 1 as GCode, x: 0, f, p: 0 };
    if (ok) expect(() => validateMove(move)).not.toThrow();
    else expect(() => validateMove(move)).toThrow(MoveValidationError);
  });
});

describe('M2 move matrix: P (dwell) bounds', () => {
  it.each([
    { p: 0, ok: true },
    { p: 1, ok: true },
    { p: MOVE_FIELD_RANGE.p.max, ok: true },
    { p: MOVE_FIELD_RANGE.p.max + 1, ok: false },
    { p: -1, ok: false },
  ])('p=$p ok=$ok', ({ p, ok }) => {
    const move = { g: 4 as GCode, x: 0, f: 0, p };
    if (ok) expect(() => validateMove(move)).not.toThrow();
    else expect(() => validateMove(move)).toThrow(MoveValidationError);
  });
});

describe('M2 waveform matrix: amplitude / frequency / cycles', () => {
  it.each([
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
  ])('A=$amplitude F=$frequency C=$cycles ok=$ok', ({ amplitude, frequency, cycles, ok }) => {
    const wf = { shape: WaveformShape.SINE, amplitude, frequency, cycles };
    if (ok) {
      expect(() => validateWaveform(wf)).not.toThrow();
    } else {
      expect(() => validateWaveform(wf)).toThrow(MoveValidationError);
    }
  });

  it.each([
    { shape: WaveformShape.SINE, label: 'sine' },
    { shape: WaveformShape.TRIANGLE, label: 'triangle' },
  ])('shape $label at nominal params encodes', ({ shape }) => {
    const wf = { shape, amplitude: 3, frequency: 1.5, cycles: 4 };
    expect(() => validateWaveform(wf)).not.toThrow();
  });
});

describe('M2 gcode line corpus (whitespace / comments / modes)', () => {
  it.each([
    { line: 'G1 X10 F5', g: 1, x: 10, f: 5 },
    { line: '  G1   X10  F5  ', g: 1, x: 10, f: 5 },
    { line: 'G1 X10 F5 ; comment', g: 1, x: 10, f: 5 },
    { line: 'G4 P100', g: 4, x: 0, f: 0 },
    { line: 'G122', g: 122, x: 0, f: 0 },
    { line: 'G28', g: 28, x: 0, f: 0 },
  ])('parse $line', ({ line, g, x, f }) => {
    const m = parseGcodeToMove(line);
    expect(m).not.toBeNull();
    expect(m!.g).toBe(g);
    expect(m!.x).toBeCloseTo(x, 6);
    expect(m!.f).toBeCloseTo(f, 6);
  });

  it('arcs do not receive gauge length (firmware dwells G2/G3)', () => {
    const bufs = gcodeLinesToMachineMoveBuffers(['G90', 'G2 X5 I1'], 15);
    expect(decodeMove(bufs[1]).x).toBeCloseTo(5, 3);
  });

  it('absolute G1 receives gauge length', () => {
    const bufs = gcodeLinesToMachineMoveBuffers(['G90', 'G1 X10 F5'], 15);
    expect(decodeMove(bufs[1]).x).toBeCloseTo(25, 3);
  });
});
