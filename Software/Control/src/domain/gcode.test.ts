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
      expect: {
        'linear-target-and-speed': 'the linear move parses with the authored target and speed',
        'pause-duration': 'the pause parses with the authored duration',
        'home-parsed': 'the home command parses as a home, with no target, speed or duration',
        'stop-parsed': 'the stop command parses as a stop, with no target, speed or duration',
      },
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
      expect: {
        'arc-target': 'it parses as an arc to 5 mm',
        'offset-dropped': 'the centre offset is dropped',
      },
      why: {
        'offset-dropped':
          'current firmware has no arc kinematics and executes an arc as a pause, so the centre offset never drives motion',
      },
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
      expect: {
        'accepted': 'each is accepted for sending',
      },
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
      expect: {
        'refused': 'the move is refused before it reaches the machine',
      },
      why: { 'refused': 'an unknown command is otherwise packed as a rapid move' },
    },
    () => {
      expect(() => validateMove({ g: 92 as GCode, x: 0, f: 0, p: 0 })).toThrow(MoveValidationError);
    },
  );

  behaviour(
    {
      id: 'gcode.out-of-range-fields-refused',
      covers: 'src/domain/gcode.ts#validateMove',
      given: 'a move whose target, speed, or pause duration is past the encodable range',
      expect: {
        'refused': 'the move is refused before it is sent',
      },
      why: { 'refused': 'a value past the packed field width wraps to a different physical command' },
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
      expect: {
        'refused': 'the move is refused before anything is sent',
      },
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
      expect: {
        'max-round-trips': 'the move at the maximum encodes and round-trips back to that target',
        'past-max-refused': 'the move past the maximum is refused',
      },
      why: { 'past-max-refused': 'a value past the packed field width wraps to a different position' },
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
      expect: {
        'linear-offset-by-gauge': 'the linear target is sent as 25 mm',
        'arc-target-untouched': 'the arc target is sent as 5 mm',
      },
      why: { 'arc-target-untouched': 'an arc is executed as a pause, so its target is not a machine-frame position' },
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
      expect: {
        'upload-refused': 'the whole upload is refused before any move is sent',
      },
      why: {
        'upload-refused': 'the packed field would wrap an over-range machine-frame target to a different position',
      },
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
      id: 'gcode.waveform-refuses-what-the-machine-cannot-run',
      covers: 'src/domain/gcode.ts#validateWaveform',
      given: 'a waveform with an unknown traverse profile, one whose holds fill the whole cycle, and one with an impossible skew',
      expect: {
        'refused-at-authoring': 'each is refused when the program is built, not when it runs',
      },
      why: {
        'refused-at-authoring':
          'the firmware refuses these too, but a refusal forty minutes into an unattended run costs a specimen; the same rule applied at authoring time costs nothing',
      },
    },
    () => {
      const ok = { shape: 0, amplitude: 5, frequency: 1, cycles: 10, dwellHigh: 0, dwellLow: 0, skewPerMille: 500 };
      expect(() => validateWaveform(ok)).not.toThrow();

      // A profile this firmware does not implement must not be run as a sine.
      expect(() => validateWaveform({ ...ok, shape: 7 })).toThrow(MoveValidationError);

      // 0.6 s + 0.6 s of holds inside a 1 s cycle leaves no time to move.
      expect(() => validateWaveform({ ...ok, dwellHigh: 0.6, dwellLow: 0.6 })).toThrow(
        MoveValidationError,
      );
      // ...and the same holds inside a 2 s cycle are fine.
      expect(() =>
        validateWaveform({ ...ok, frequency: 0.5, dwellHigh: 0.6, dwellLow: 0.6 }),
      ).not.toThrow();

      // A traverse of zero duration is an infinite rate at either end.
      expect(() => validateWaveform({ ...ok, skewPerMille: 0 })).toThrow(MoveValidationError);
      expect(() => validateWaveform({ ...ok, skewPerMille: 1000 })).toThrow(MoveValidationError);
    },
  );

  behaviour(
    {
      id: 'gcode.waveform-parses-params',
      covers: 'src/domain/gcode.ts#parseGcodeWaveform',
      given: 'a sine waveform with amplitude, frequency, and cycle count, and a triangle waveform with those same kinds of fields',
      expect: {
        'params-kept': 'each parses to the authored amplitude, frequency, cycle count, and shape',
      },
    },
    () => {
      // Omitted H/L/S default to a hold-free, symmetric cycle -- what G123 has
      // always meant, so an existing program keeps its meaning exactly.
      expect(parseGcodeWaveform('G123 A5 F2.5 C100 W0 ; sine A=5mm')).toEqual({
        shape: WaveformShape.SINE,
        amplitude: 5,
        frequency: 2.5,
        cycles: 100,
        dwellHigh: 0,
        dwellLow: 0,
        skewPerMille: 500,
      });
      expect(parseGcodeWaveform('G123 A3 F1 C2 W1')).toEqual({
        shape: WaveformShape.TRIANGLE,
        amplitude: 3,
        frequency: 1,
        cycles: 2,
        dwellHigh: 0,
        dwellLow: 0,
        skewPerMille: 500,
      });
      // The cycle template: a hold at the upper peak only, and a skewed
      // traverse. H and L mean the same thing whatever W is.
      expect(parseGcodeWaveform('G123 A2 F0.5 C10 W1 H1.5 L0.25 S0.8')).toEqual({
        shape: WaveformShape.TRIANGLE,
        amplitude: 2,
        frequency: 0.5,
        cycles: 10,
        dwellHigh: 1.5,
        dwellLow: 0.25,
        skewPerMille: 800,
      });
    },
  );

  behaviour(
    {
      id: 'gcode.waveform-parse-skips-linear',
      covers: 'src/domain/gcode.ts#parseGcodeWaveform',
      given: 'a linear move line offered to the waveform parser',
      expect: {
        'no-waveform': 'no waveform is produced',
      },
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
      expect: {
        'refused': 'the waveform is refused before it is sent',
      },
      why: { 'refused': 'a value past the packed field width wraps to a different waveform' },
    },
    () => {
      expect(() => validateWaveform({ shape: 0, amplitude: WAVEFORM_FIELD_RANGE.amplitude.max + 1, frequency: 1, cycles: 1, dwellHigh: 0, dwellLow: 0, skewPerMille: 500 })).toThrow(MoveValidationError);
      expect(() => validateWaveform({ shape: 0, amplitude: 5, frequency: WAVEFORM_FIELD_RANGE.frequency.max + 1, cycles: 1, dwellHigh: 0, dwellLow: 0, skewPerMille: 500 })).toThrow(MoveValidationError);
      expect(() => validateWaveform({ shape: 0, amplitude: 5, frequency: 1, cycles: WAVEFORM_FIELD_RANGE.cycles.max + 1, dwellHigh: 0, dwellLow: 0, skewPerMille: 500 })).toThrow(MoveValidationError);
      expect(() => validateWaveform({ shape: 0, amplitude: 5, frequency: 1, cycles: 0, dwellHigh: 0, dwellLow: 0, skewPerMille: 500 })).toThrow(MoveValidationError); // min 1
    },
  );

  behaviour(
    {
      id: 'gcode.waveform-stays-in-program-order',
      covers: 'src/domain/gcode.ts#gcodeLinesToProgram',
      given: 'a program that sets absolute positioning, moves, runs a waveform, and moves again',
      expect: {
        'authored-order': 'all four upload in the authored order',
        'waveform-kept': 'the waveform uploads as a single waveform record',
      },
    },
    () => {
      // G90 is itself uploaded as a move record (sets absolute mode on firmware).
      const ops = gcodeLinesToProgram(['G90', 'G1 X10 F5', 'G123 A5 F1 C2 W0', 'G1 X0 F5'], 0);
      expect(ops.map((o) => o.kind)).toEqual(['move', 'move', 'waveform', 'move']);
      const wf = ops.find((o) => o.kind === 'waveform');
      expect(wf?.buf.length).toBe(18); // 18-byte WaveformMove (was 9 before dwell/skew)
    },
  );

  behaviour(
    {
      id: 'gcode.move-only-upload-refuses-waveform',
      covers: 'src/domain/gcode.ts#gcodeLinesToMachineMoveBuffers',
      given: 'a program that contains a waveform, offered to the move-only upload path',
      expect: {
        'upload-refused': 'the whole upload is refused',
      },
      why: { 'upload-refused': 'a waveform has to go through the ordered waveform upload' },
    },
    () => {
      expect(() => gcodeLinesToMachineMoveBuffers(['G123 A5 F1 C2 W0'], 0)).toThrow(MoveValidationError);
    },
  );
});
