import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  generateTestGcode,
  waveformSample,
  waveformPeakVelocity,
  waveformPeakAcceleration,
} from './testProfile';
import { gcodeLinesToProgram } from './gcode';
import { decodeWaveformMove, WaveformShape } from '@/protocol/generated/protoemb';
import { TestProfile, MoveParameters } from './types';

const base: TestProfile = {
  name: 'T1',
  description: 'demo',
  sampleProfile: {
    maxForce: 0,
    maxVelocity: 0,
    maxDisplacement: 0,
    sampleWidth: 0,
    sampleThickness: 0,
    serial: '',
  },
  sets: [
    {
      name: 'S1',
      executions: 2,
      moves: [
        {
          moveType: 'linear',
          absoluteOrRelative: 'absolute',
          moveParameters: { position: 5, velocity: 2, distance: 0, time: 0 },
        },
        {
          moveType: 'dwell',
          absoluteOrRelative: 'absolute',
          moveParameters: { position: 0, velocity: 0, distance: 0, time: 500 },
        },
        {
          moveType: 'linear',
          absoluteOrRelative: 'relative',
          moveParameters: { position: 0, velocity: 4, distance: -3, time: 0 },
        },
      ],
    },
  ],
};

describe('generateTestGcode', () => {
  behaviour(
    {
      id: 'profile.gcode-has-header-moves-and-stop',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a profile named T1 with an absolute linear move to 5 mm, a 500-millisecond pause, and a relative move of -3 mm, run twice',
      then: 'generated G-code starts with the profile name, includes absolute and relative mode, the authored moves and pause, and ends with a stop that signals the test is complete',
    },
    () => {
      const { gcode } = generateTestGcode(base);
      const joined = gcode.join('\n');
      expect(gcode[0]).toBe('; Test Profile: T1');
      expect(joined).toContain('G90 ; Set absolute positioning');
      expect(joined).toContain('G1 X5 F2');
      expect(joined).toContain('G4 P500');
      expect(joined).toContain('G91 ; Set relative positioning');
      expect(joined).toContain('G1 X-3 F4');
      expect(gcode[gcode.length - 1]).toBe('G122 ; Stop - signal test complete');
    },
  );

  behaviour(
    {
      id: 'profile.repeats-moves-per-execution',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a set that is configured to run twice',
      then: 'a set configured for two executions emits each move twice',
    },
    () => {
      const { gcode } = generateTestGcode(base);
      const linearAbs = gcode.filter((l) => l === 'G1 X5 F2').length;
      expect(linearAbs).toBe(2); // executions: 2
    },
  );

  behaviour(
    {
      id: 'profile.preview-time-is-monotonic',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a generated profile preview series',
      then: 'preview time and distance have the same length, and time only moves forward',
    },
    () => {
      const { time, distance } = generateTestGcode(base);
      expect(time.length).toBe(distance.length);
      for (let i = 1; i < time.length; i++) {
        expect(time[i]).toBeGreaterThanOrEqual(time[i - 1]);
      }
    },
  );
});

describe('waveform helpers', () => {
  behaviour(
    {
      id: 'profile.sine-sample-key-points',
      covers: 'src/domain/testProfile.ts#waveformSample',
      given: 'a sine waveform sampled at the start, quarter, three-quarter, and end of a cycle',
      then: 'a sine is zero at the start and end of a cycle, one at a quarter turn, and minus one at three-quarters',
    },
    () => {
      expect(waveformSample('sine', 0)).toBeCloseTo(0, 6);
      expect(waveformSample('sine', 0.25)).toBeCloseTo(1, 6);
      expect(waveformSample('sine', 0.75)).toBeCloseTo(-1, 6);
      expect(waveformSample('sine', 1)).toBeCloseTo(0, 6);
    },
  );
  behaviour(
    {
      id: 'profile.triangle-sample-key-points',
      covers: 'src/domain/testProfile.ts#waveformSample',
      given: 'a triangle waveform sampled at the start, quarter, half, and three-quarter of a cycle',
      then: 'a triangle is zero at the start and half of a cycle, one at a quarter turn, and minus one at three-quarters',
    },
    () => {
      expect(waveformSample('triangle', 0)).toBeCloseTo(0, 6);
      expect(waveformSample('triangle', 0.25)).toBeCloseTo(1, 6);
      expect(waveformSample('triangle', 0.5)).toBeCloseTo(0, 6);
      expect(waveformSample('triangle', 0.75)).toBeCloseTo(-1, 6);
    },
  );
  behaviour(
    {
      id: 'profile.waveform-peak-velocity',
      covers: 'src/domain/testProfile.ts#waveformPeakVelocity',
      given: 'a 5 mm, 1 Hz sine and triangle',
      then: 'peak velocity is two-pi times amplitude times frequency for a sine, and four times amplitude times frequency for a triangle',
    },
    () => {
      expect(waveformPeakVelocity('sine', 5, 1)).toBeCloseTo(2 * Math.PI * 5, 6);
      expect(waveformPeakVelocity('triangle', 5, 1)).toBeCloseTo(20, 6);
    },
  );

  behaviour(
    {
      id: 'profile.sine-peak-acceleration',
      covers: 'src/domain/testProfile.ts#waveformPeakAcceleration',
      given: 'sines of 5 mm at 1 Hz, 3 mm at 2 Hz, and 10 mm at 0.5 Hz',
      then: 'sine peak acceleration is amplitude times four-pi-squared times frequency squared',
    },
    () => {
      expect(waveformPeakAcceleration('sine', 5, 1)).toBeCloseTo((2 * Math.PI) ** 2 * 5, 6);
      // Scales with f², which is why a modest frequency bump blows the envelope:
      // 3mm @ 2Hz needs ~474 mm/s² where 5mm @ 1Hz needs only ~197.
      expect(waveformPeakAcceleration('sine', 3, 2)).toBeCloseTo(473.74, 2);
      expect(waveformPeakAcceleration('sine', 10, 0.5)).toBeCloseTo(98.7, 1);
    },
  );

  behaviour(
    {
      id: 'profile.acceleration-uses-absolute-amplitude-and-frequency',
      covers: 'src/domain/testProfile.ts#waveformPeakAcceleration',
      given: 'a sine with negative amplitude and frequency, and sines with zero amplitude or zero frequency',
      then: 'sine peak acceleration uses the absolute amplitude and frequency, and is zero when either is zero',
    },
    () => {
      expect(waveformPeakAcceleration('sine', -5, -1)).toBeCloseTo((2 * Math.PI) ** 2 * 5, 6);
      expect(waveformPeakAcceleration('sine', 0, 10)).toBe(0);
      expect(waveformPeakAcceleration('sine', 10, 0)).toBe(0);
    },
  );

  behaviour(
    {
      id: 'profile.triangle-acceleration-is-zero',
      covers: 'src/domain/testProfile.ts#waveformPeakAcceleration',
      given: 'a triangle waveform',
      then: 'triangle peak acceleration is reported as zero',
      why: 'a triangle has impulsive acceleration at the turning points, so the planning number is zero',
    },
    () => {
      expect(waveformPeakAcceleration('triangle', 5, 1)).toBe(0);
    },
  );
});

function waveformProfile(params: Partial<MoveParameters>): TestProfile {
  return {
    name: 'W',
    description: '',
    sampleProfile: { maxForce: 0, maxVelocity: 0, maxDisplacement: 0, sampleWidth: 0, sampleThickness: 0, serial: '' },
    sets: [
      {
        name: 'S',
        executions: 1,
        moves: [
          {
            moveType: 'math',
            absoluteOrRelative: 'relative',
            moveParameters: { position: 0, velocity: 0, distance: 0, time: 0, ...params },
          },
        ],
      },
    ],
  };
}

describe('generateTestGcode — waveform (math) move', () => {
  behaviour(
    {
      id: 'profile.waveform-emits-one-canned-cycle',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a relative sine of 5 mm, 1 Hz, two cycles, already centred on the start',
      then: 'a relative waveform already at its centre emits a single waveform command with the authored amplitude, frequency, and cycle count, a preview that swings plus and minus the amplitude, monotonic time, and a trailing stop',
    },
    () => {
      const cycles = 2;
      const amplitude = 5;
      const { gcode, distance, time } = generateTestGcode(
        waveformProfile({ waveform: 'sine', amplitude, frequency: 1, cycles }),
      );
      // Exactly one G123 line; NO per-segment G1s for the oscillation.
      const g123 = gcode.filter((l) => /^G123 /.test(l));
      expect(g123.length).toBe(1);
      expect(g123[0]).toMatch(/^G123 A5 F1 C2 W0\b/);
      // Centre == start (relative, 0) ⇒ no ramp-in G1 needed.
      expect(gcode.some((l) => /^G1 /.test(l))).toBe(false);
      // Preview series still oscillates ±amplitude about the centre, monotonic in time.
      expect(Math.max(...distance)).toBeCloseTo(amplitude, 1);
      expect(Math.min(...distance)).toBeCloseTo(-amplitude, 1);
      for (let i = 1; i < time.length; i++) expect(time[i]).toBeGreaterThanOrEqual(time[i - 1]);
      expect(gcode[gcode.length - 1]).toBe('G122 ; Stop - signal test complete');
    },
  );

  behaviour(
    {
      id: 'profile.zero-cycle-waveform-emits-no-motion',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a sine waveform with zero cycles',
      then: 'a waveform with zero cycles emits no linear move and no waveform command',
    },
    () => {
      const { gcode } = generateTestGcode(waveformProfile({ waveform: 'sine', amplitude: 5, frequency: 1, cycles: 0 }));
      expect(gcode.some((l) => /^G(1|123) /.test(l))).toBe(false);
    },
  );

  behaviour(
    {
      id: 'profile.waveform-is-sine-only',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a motion profile whose waveform is set to triangle',
      then: 'a triangle waveform profile is emitted as a sine canned cycle',
      why: 'firmware v1 runs only sine, so the shape on the wire is sine',
    },
    () => {
      const { gcode } = generateTestGcode(
        waveformProfile({ waveform: 'triangle', amplitude: 5, frequency: 1, cycles: 1 }),
      );
      const g123 = gcode.find((l) => /^G123 /.test(l));
      expect(g123).toMatch(/\bW0\b/);
      expect(g123).not.toMatch(/\bW1\b/);
    },
  );

  behaviour(
    {
      id: 'profile.waveform-uploads-as-one-record',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a generated sine of 4 mm, 1 Hz, three cycles, uploaded with 15 mm of gauge length',
      then: 'a generated sine uploads as a single waveform with sine shape and the authored amplitude, frequency, and cycle count',
    },
    () => {
      const { gcode } = generateTestGcode(
        waveformProfile({ waveform: 'sine', amplitude: 4, frequency: 1, cycles: 3 }),
      );
      // Validates + encodes the whole program — must not throw.
      const ops = gcodeLinesToProgram(gcode, 15);
      const waveforms = ops.filter((o) => o.kind === 'waveform');
      expect(waveforms.length).toBe(1);
      expect(waveforms[0].buf.length).toBe(9); // 9-byte WaveformMove wire size
      const wf = decodeWaveformMove(waveforms[0].buf);
      expect(wf.shape).toBe(WaveformShape.SINE); // v1 is sine-only
      expect(wf.amplitude).toBeCloseTo(4, 3);
      expect(wf.frequency).toBeCloseTo(1, 3);
      expect(wf.cycles).toBe(3);
    },
  );
});
