import { describe, it, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  parseGcodeToMove,
  parseGcodeWaveform,
  validateWaveform,
  gcodeLinesToMachineMoveBuffers,
  gcodeLinesToProgram,
  validateMove,
  validateAndEncodeMove,
  MoveValidationError,
  MOVE_FIELD_RANGE,
  WAVEFORM_FIELD_RANGE,
} from './gcode';
import { GCode, WaveformShape, decodeMove } from '@/protocol/generated/protoemb';

describe('parseGcodeToMove', () => {
  behaviour(
    {
      id: 'gcode.parses-linear-dwell-home-stop',
      covers: 'src/domain/gcode.ts#parseGcodeToMove',
      given: 'a linear move to 10 mm at 5 mm/s, a pause of 2000 milliseconds, a home command, and a stop command',
      then: 'a linear move, a 2000-millisecond pause, a home, and a stop each parse as that command with the authored target, speed, and duration',
    },
    () => {
      expect(parseGcodeToMove('G1 X10 F5')).toEqual({ g: 1, x: 10, f: 5, p: 0 });
      expect(parseGcodeToMove('G4 P2000')).toEqual({ g: 4, x: 0, f: 0, p: 2000 });
      expect(parseGcodeToMove('G28')).toEqual({ g: 28, x: 0, f: 0, p: 0 });
      expect(parseGcodeToMove('G122')).toEqual({ g: 122, x: 0, f: 0, p: 0 });
    },
  );

  behaviour(
    {
      id: 'gcode.arc-parses-target',
      covers: 'src/domain/gcode.ts#parseGcodeToMove',
      given: 'an arc command to 5 mm with a 3 mm centre offset',
      then: 'an arc to 5 mm with a centre offset parses as an arc to 5 mm',
      why: 'current firmware has no arc kinematics and executes an arc as a pause, so the centre offset never drives motion',
    },
    () => {
      expect(parseGcodeToMove('G2 X5 I3')).toEqual({ g: 2, x: 5, f: 0, p: 0 });
    },
  );
});

describe('validateMove', () => {
  behaviour(
    {
      id: 'gcode.valid-linear-home-arc-accepted',
      covers: 'src/domain/gcode.ts#validateMove',
      given: 'a linear move, a home command, and an arc, each with fields inside the encodable range',
      then: 'a linear move, a home, and an arc with fields inside the encodable range are accepted for sending',
    },
    () => {
      expect(() => validateMove({ g: 1 as GCode, x: 10, f: 5, p: 0 })).not.toThrow();
      expect(() => validateMove({ g: 28 as GCode, x: 0, f: 0, p: 0 })).not.toThrow();
      expect(() => validateMove({ g: 2 as GCode, x: 5, f: 0, p: 0 })).not.toThrow(); // arc is a valid G-code
    },
  );

  behaviour(
    {
      id: 'gcode.unknown-command-refused',
      covers: 'src/domain/gcode.ts#validateMove',
      given: 'a command numbered 92, which the machine does not implement',
      then: 'a command numbered 92 is refused before it is sent',
      why: 'an unknown command is otherwise packed as a rapid move',
    },
    () => {
      expect(() => validateMove({ g: 92 as GCode, x: 0, f: 0, p: 0 })).toThrow(MoveValidationError);
    },
  );

  behaviour(
    {
      id: 'gcode.out-of-range-fields-refused',
      covers: 'src/domain/gcode.ts#validateMove',
      given: 'a move whose target, speed, or pause duration is one unit past the encodable range',
      then: 'a target, speed, or pause duration one unit past the encodable range is refused before it is sent',
      why: 'a value past the packed field width wraps to a different physical command',
    },
    () => {
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
    },
  );

  behaviour(
    {
      id: 'gcode.non-finite-target-refused',
      covers: 'src/domain/gcode.ts#validateMove',
      given: 'a linear move whose target is not a finite number',
      then: 'a move whose target is not a finite number is refused before it is sent',
    },
    () => {
      expect(() => validateMove({ g: 1 as GCode, x: NaN, f: 5, p: 0 })).toThrow(MoveValidationError);
    },
  );

  behaviour(
    {
      id: 'gcode.boundary-target-encodes',
      covers: 'src/domain/gcode.ts#validateAndEncodeMove',
      given: 'a linear move whose target is at the codec maximum, and the same move one millimetre past that maximum',
      then: 'a move whose target is at the codec maximum still encodes, and one millimetre past that maximum is refused',
      why: 'a value past the packed field width wraps to a different position',
    },
    () => {
      // At the max boundary the encode→decode round-trips within the field precision.
      const atMax = { g: 1 as GCode, x: MOVE_FIELD_RANGE.x.max, f: 0, p: 0 };
      const back = decodeMove(validateAndEncodeMove(atMax));
      expect(back.x).toBeCloseTo(MOVE_FIELD_RANGE.x.max, 2);
      // One unit past the boundary is rejected (it would wrap to a different value).
      expect(() => validateAndEncodeMove({ ...atMax, x: MOVE_FIELD_RANGE.x.max + 1 })).toThrow(
        MoveValidationError,
      );
    },
  );
});

describe('gcodeLinesToMachineMoveBuffers', () => {
  behaviour(
    {
      id: 'gcode.gauge-offsets-linear-leaves-arc',
      covers: 'src/domain/gcode.ts#gcodeLinesToMachineMoveBuffers',
      given: 'an absolute linear move to 10 mm and an arc to 5 mm, with 15 mm of gauge length',
      then: 'an absolute linear target of 10 mm is sent as 25 mm when gauge length is 15 mm, and an arc target of 5 mm is sent as 5 mm',
      why: 'an arc is executed as a pause, so its target is not a machine-frame position',
    },
    () => {
      const gauge = 15;
      const bufs = gcodeLinesToMachineMoveBuffers(['G90', 'G1 X10 F5', 'G2 X5 I3'], gauge);
      expect(bufs).toHaveLength(3);
      const linear = decodeMove(bufs[1]);
      const arc = decodeMove(bufs[2]);
      expect(linear.x).toBeCloseTo(25, 3); // 10 + gauge
      expect(arc.x).toBeCloseTo(5, 3); // gauge NOT added to the arc
    },
  );

  /* claimed by gcode.relative-moves-are-not-offset */
  it('does not add gauge to relative moves', () => {
    const bufs = gcodeLinesToMachineMoveBuffers(['G91', 'G1 X10 F5'], 15);
    expect(decodeMove(bufs[1]).x).toBeCloseTo(10, 3);
  });

  behaviour(
    {
      id: 'gcode.gauge-offset-out-of-range-refused',
      covers: 'src/domain/gcode.ts#gcodeLinesToMachineMoveBuffers',
      given: 'an absolute move to 4000 mm with 15 mm of gauge length, which together exceed the encodable range',
      then: 'an absolute target plus gauge length that exceeds the encodable range is refused before it is sent',
      why: 'the packed field would wrap an over-range machine-frame target to a different position',
    },
    () => {
      // 4000 + gauge 15 = 4015 mm > MOVE_FIELD_RANGE.x.max (~3994.303) → must throw, not wrap.
      expect(() => gcodeLinesToMachineMoveBuffers(['G90', 'G1 X4000 F5'], 15)).toThrow(MoveValidationError);
    },
  );
});

describe('waveform (G123) canned cycle', () => {
  behaviour(
    {
      id: 'gcode.waveform-parses-params',
      covers: 'src/domain/gcode.ts#parseGcodeWaveform',
      given: 'a sine waveform with amplitude, frequency, and cycle count, and a triangle waveform with those same kinds of fields',
      then: 'a waveform command parses to the authored amplitude, frequency, cycle count, and shape',
    },
    () => {
      expect(parseGcodeWaveform('G123 A5 F2.5 C100 W0 ; sine A=5mm')).toEqual({
        shape: WaveformShape.SINE,
        amplitude: 5,
        frequency: 2.5,
        cycles: 100,
      });
      expect(parseGcodeWaveform('G123 A3 F1 C2 W1')).toEqual({
        shape: WaveformShape.TRIANGLE,
        amplitude: 3,
        frequency: 1,
        cycles: 2,
      });
    },
  );

  behaviour(
    {
      id: 'gcode.waveform-parse-skips-linear',
      covers: 'src/domain/gcode.ts#parseGcodeWaveform',
      given: 'a linear move line offered to the waveform parser',
      then: 'a linear move is not read as a waveform',
    },
    () => {
      expect(parseGcodeWaveform('G1 X5 F2')).toBeNull();
    },
  );

  behaviour(
    {
      id: 'gcode.waveform-out-of-range-refused',
      covers: 'src/domain/gcode.ts#validateWaveform',
      given: 'a waveform whose amplitude, frequency, or cycle count is outside the encodable range, or whose cycle count is zero',
      then: 'a waveform whose amplitude, frequency, or cycle count is outside the encodable range, or whose cycle count is zero, is refused before it is sent',
      why: 'a value past the packed field width wraps to a different waveform',
    },
    () => {
      expect(() => validateWaveform({ shape: 0, amplitude: WAVEFORM_FIELD_RANGE.amplitude.max + 1, frequency: 1, cycles: 1 })).toThrow(MoveValidationError);
      expect(() => validateWaveform({ shape: 0, amplitude: 5, frequency: WAVEFORM_FIELD_RANGE.frequency.max + 1, cycles: 1 })).toThrow(MoveValidationError);
      expect(() => validateWaveform({ shape: 0, amplitude: 5, frequency: 1, cycles: WAVEFORM_FIELD_RANGE.cycles.max + 1 })).toThrow(MoveValidationError);
      expect(() => validateWaveform({ shape: 0, amplitude: 5, frequency: 1, cycles: 0 })).toThrow(MoveValidationError); // min 1
    },
  );

  behaviour(
    {
      id: 'gcode.waveform-stays-in-program-order',
      covers: 'src/domain/gcode.ts#gcodeLinesToProgram',
      given: 'a program that sets absolute positioning, moves, runs a waveform, and moves again',
      then: 'a set-absolute command, a linear move, a waveform, and another linear move upload in that order, with the waveform kept as a waveform',
    },
    () => {
      // G90 is itself uploaded as a move record (sets absolute mode on firmware).
      const ops = gcodeLinesToProgram(['G90', 'G1 X10 F5', 'G123 A5 F1 C2 W0', 'G1 X0 F5'], 0);
      expect(ops.map((o) => o.kind)).toEqual(['move', 'move', 'waveform', 'move']);
      const wf = ops.find((o) => o.kind === 'waveform');
      expect(wf?.buf.length).toBe(9); // 9-byte WaveformMove
    },
  );

  behaviour(
    {
      id: 'gcode.move-only-upload-refuses-waveform',
      covers: 'src/domain/gcode.ts#gcodeLinesToMachineMoveBuffers',
      given: 'a program that contains a waveform, offered to the move-only upload path',
      then: 'a program that contains a waveform is refused by the move-only upload path',
      why: 'a waveform has to go through the ordered waveform upload, not the move batch',
    },
    () => {
      expect(() => gcodeLinesToMachineMoveBuffers(['G123 A5 F1 C2 W0'], 0)).toThrow(MoveValidationError);
    },
  );
});
