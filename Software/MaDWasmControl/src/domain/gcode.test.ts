import { describe, it, expect } from 'vitest';
import {
  parseGcodeToMove,
  gcodeLinesToMachineMoveBuffers,
  validateMove,
  validateAndEncodeMove,
  MoveValidationError,
  MOVE_FIELD_RANGE,
} from './gcode';
import { GCode, decodeMove } from '@/protocol/generated/protoemb';

describe('parseGcodeToMove', () => {
  it('parses linear/absolute/relative/dwell/home/stop', () => {
    expect(parseGcodeToMove('G1 X10 F5')).toEqual({ g: 1, x: 10, f: 5, p: 0 });
    expect(parseGcodeToMove('G4 P2000')).toEqual({ g: 4, x: 0, f: 0, p: 2000 });
    expect(parseGcodeToMove('G28')).toEqual({ g: 28, x: 0, f: 0, p: 0 });
    expect(parseGcodeToMove('G122')).toEqual({ g: 122, x: 0, f: 0, p: 0 });
  });

  it('parses an arc line (I offset is intentionally dropped — firmware dwells)', () => {
    expect(parseGcodeToMove('G2 X5 I3')).toEqual({ g: 2, x: 5, f: 0, p: 0 });
  });
});

describe('validateMove', () => {
  it('accepts valid moves', () => {
    expect(() => validateMove({ g: 1 as GCode, x: 10, f: 5, p: 0 })).not.toThrow();
    expect(() => validateMove({ g: 28 as GCode, x: 0, f: 0, p: 0 })).not.toThrow();
    expect(() => validateMove({ g: 2 as GCode, x: 5, f: 0, p: 0 })).not.toThrow(); // arc is a valid G-code
  });

  it('rejects an unknown G-code rather than coercing it to a rapid move', () => {
    expect(() => validateMove({ g: 92 as GCode, x: 0, f: 0, p: 0 })).toThrow(MoveValidationError);
  });

  it('rejects out-of-range X / F / P (would silently bit-wrap)', () => {
    expect(() => validateMove({ g: 1 as GCode, x: MOVE_FIELD_RANGE.x.max + 1, f: 5, p: 0 })).toThrow(
      MoveValidationError,
    );
    expect(() => validateMove({ g: 1 as GCode, x: MOVE_FIELD_RANGE.x.min - 1, f: 5, p: 0 })).toThrow(
      MoveValidationError,
    );
    expect(() => validateMove({ g: 1 as GCode, x: 0, f: MOVE_FIELD_RANGE.f.max + 1, p: 0 })).toThrow(
      MoveValidationError,
    );
    expect(() => validateMove({ g: 4 as GCode, x: 0, f: 0, p: 70000 })).toThrow(MoveValidationError);
  });

  it('rejects NaN', () => {
    expect(() => validateMove({ g: 1 as GCode, x: NaN, f: 5, p: 0 })).toThrow(MoveValidationError);
  });

  it('field-range constants match the codec (a boundary value round-trips, just past wraps)', () => {
    // At the max boundary the encode→decode round-trips within the field precision.
    const atMax = { g: 1 as GCode, x: MOVE_FIELD_RANGE.x.max, f: 0, p: 0 };
    const back = decodeMove(validateAndEncodeMove(atMax));
    expect(back.x).toBeCloseTo(MOVE_FIELD_RANGE.x.max, 2);
    // One unit past the boundary is rejected (it would wrap to a different value).
    expect(() => validateAndEncodeMove({ ...atMax, x: MOVE_FIELD_RANGE.x.max + 1 })).toThrow(
      MoveValidationError,
    );
  });
});

describe('gcodeLinesToMachineMoveBuffers', () => {
  it('adds gauge length to absolute G0/G1 targets but not to arcs', () => {
    const gauge = 15;
    const bufs = gcodeLinesToMachineMoveBuffers(['G90', 'G1 X10 F5', 'G2 X5 I3'], gauge);
    expect(bufs).toHaveLength(3);
    const linear = decodeMove(bufs[1]);
    const arc = decodeMove(bufs[2]);
    expect(linear.x).toBeCloseTo(25, 3); // 10 + gauge
    expect(arc.x).toBeCloseTo(5, 3); // gauge NOT added to the arc
  });

  it('does not add gauge to relative moves', () => {
    const bufs = gcodeLinesToMachineMoveBuffers(['G91', 'G1 X10 F5'], 15);
    expect(decodeMove(bufs[1]).x).toBeCloseTo(10, 3);
  });

  it('throws when an absolute target + gauge exceeds the encodable range', () => {
    // 320 + gauge 15 = 335 mm > MOVE_FIELD_RANGE.x.max (~324.287) → must throw, not wrap.
    expect(() => gcodeLinesToMachineMoveBuffers(['G90', 'G1 X320 F5'], 15)).toThrow(MoveValidationError);
  });
});
