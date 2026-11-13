import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  generateTestGcode,
  waveFromStart,
  sinePeakVelocity,
  sinePeakAcceleration,
  planSigmoid,
  chirpCycles,
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
          moveParameters: { position: 5, velocity: 2, time: 0 },
        },
        {
          moveType: 'dwell',
          moveParameters: { position: 0, velocity: 0, time: 500 },
        },
        {
          moveType: 'linear',
          moveParameters: { position: 2, velocity: 4, time: 0 },
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
      given: 'a profile named T1 with a linear move to 5 mm, a 500-millisecond pause, and a linear move to 2 mm',
      expect: {
        'opens-with-name': 'the program opens with the profile name',
        'absolute-only': 'the program runs in absolute positioning throughout',
        'authored-moves-and-pause': 'the authored moves and pause appear with their travel, speed and duration',
        'ends-with-stop': 'the program ends with the completion stop',
      },
    },
    () => {
      const { gcode } = generateTestGcode(base);
      const joined = gcode.join('\n');
      expect(gcode[0]).toBe('; Test Profile: T1');
      expect(joined).toContain('G90 ; Set absolute positioning');
      expect(joined).toContain('G1 X5 F2');
      expect(joined).toContain('G4 P500');
      expect(joined).not.toContain('G91');
      expect(joined).toContain('G1 X2 F4');
      expect(gcode[gcode.length - 1]).toBe('G122 ; Stop - signal test complete');
    },
  );

  behaviour(
    {
      id: 'profile.repeats-moves-per-execution',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a set that is configured to run twice',
      expect: {
        'moves-repeated': 'each move in the set appears twice in the program',
      },
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
      expect: {
        'same-point-count': 'time and distance have the same number of points',
        'time-moves-forward': 'time only moves forward',
      },
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
      id: 'profile.wave-from-start-key-points',
      covers: 'src/domain/testProfile.ts#waveFromStart',
      given: 'a wave of unit amplitude sampled at the start, a quarter, a half and a whole cycle',
      expect: {
        'key-points': 'it is zero, one, two and zero away from where it started, in that order',
      },
      why: {
        'key-points': 'the machine starts a wave at rest where the carriage is, one of its peaks, and swings out to the other peak and back',
      },
    },
    () => {
      expect(waveFromStart(0)).toBeCloseTo(0, 6);
      expect(waveFromStart(0.25)).toBeCloseTo(1, 6);
      expect(waveFromStart(0.5)).toBeCloseTo(2, 6);
      expect(waveFromStart(1)).toBeCloseTo(0, 6);
    },
  );
  behaviour(
    {
      id: 'profile.waveform-peak-velocity',
      covers: 'src/domain/testProfile.ts#sinePeakVelocity',
      given: 'a 5 mm, 1 Hz sine',
      expect: {
        'sine-peak': 'peak velocity for a sine is two-pi times amplitude times frequency',
      },
    },
    () => {
      expect(sinePeakVelocity(5, 1)).toBeCloseTo(2 * Math.PI * 5, 6);
    },
  );

  behaviour(
    {
      id: 'profile.sine-peak-acceleration',
      covers: 'src/domain/testProfile.ts#sinePeakAcceleration',
      given: 'sines of 5 mm at 1 Hz, 3 mm at 2 Hz, and 10 mm at 0.5 Hz',
      expect: {
        'peak-acceleration-formula': 'peak acceleration is amplitude times four-pi-squared times frequency squared',
      },
    },
    () => {
      expect(sinePeakAcceleration(5, 1)).toBeCloseTo((2 * Math.PI) ** 2 * 5, 6);
      // Scales with f², which is why a modest frequency bump blows the envelope:
      // 3mm @ 2Hz needs ~474 mm/s² where 5mm @ 1Hz needs only ~197.
      expect(sinePeakAcceleration(3, 2)).toBeCloseTo(473.74, 2);
      expect(sinePeakAcceleration(10, 0.5)).toBeCloseTo(98.7, 1);
    },
  );

  behaviour(
    {
      id: 'profile.acceleration-uses-absolute-amplitude-and-frequency',
      covers: 'src/domain/testProfile.ts#sinePeakAcceleration',
      given: 'a sine with negative amplitude and frequency, and sines with zero amplitude or zero frequency',
      expect: {
        'magnitudes-used': 'peak acceleration uses the magnitudes of amplitude and frequency',
        'zero-when-either-is-zero': 'peak acceleration is zero when either value is zero',
      },
    },
    () => {
      expect(sinePeakAcceleration(-5, -1)).toBeCloseTo((2 * Math.PI) ** 2 * 5, 6);
      expect(sinePeakAcceleration(0, 10)).toBe(0);
      expect(sinePeakAcceleration(10, 0)).toBe(0);
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
            moveParameters: { position: 0, velocity: 0, time: 0, ...params },
          },
        ],
      },
    ],
  };
}

function repeatedSine(executions: number, params: Partial<MoveParameters>): TestProfile {
  const prof = waveformProfile({ waveform: 'sine', ...params });
  prof.sets[0].executions = executions;
  return prof;
}

describe('generateTestGcode — sine', () => {
  behaviour(
    {
      id: 'profile.sine-cycles-join-into-one-wave',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a set holding one 5 mm, 1 Hz sine move, executed three times',
      expect: {
        'one-wave': 'exactly one waveform command is emitted, carrying three cycles',
        'no-positioning-move': 'no straight move is emitted: the wave runs around where the gantry already is',
        'preview-full-stroke': 'the preview rises from the start to twice the amplitude above it',
        'preview-time': 'the preview lasts three seconds, one per cycle',
      },
      why: {
        'one-wave':
          'a wave starts at rest at a peak and each whole cycle ends at rest back at that peak, so separate one-cycle waves would stop at that peak between every cycle',
      },
    },
    () => {
      const { gcode, distance, time } = generateTestGcode(repeatedSine(3, { amplitude: 5, frequency: 1 }));
      const g123 = gcode.filter((l) => /^G123 /.test(l));
      expect(g123.length).toBe(1);
      expect(g123[0]).toMatch(/^G123 A5 F1 C3 W0\b/);
      expect(gcode.some((l) => /^G1 /.test(l))).toBe(false);
      expect(Math.max(...distance)).toBeCloseTo(10, 1);
      expect(Math.min(...distance)).toBeCloseTo(0, 1);
      expect(time[time.length - 1]).toBeCloseTo(3, 3);
    },
  );

  behaviour(
    {
      id: 'profile.negative-amplitude-falls-first',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a sine of minus 5 mm at 1 Hz',
      expect: {
        'signed-command': 'the waveform command carries the amplitude with its sign',
        'preview-falls': 'the preview falls from the start to 10 mm below it and returns',
      },
    },
    () => {
      const { gcode, distance } = generateTestGcode(repeatedSine(1, { amplitude: -5, frequency: 1 }));
      expect(gcode.find((l) => /^G123 /.test(l))).toMatch(/^G123 A-5 F1 C1 W0\b/);
      expect(Math.min(...distance)).toBeCloseTo(-10, 1);
      expect(Math.max(...distance)).toBeCloseTo(0, 1);
    },
  );

  behaviour(
    {
      id: 'profile.different-sines-stay-separate',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a 5 mm sine at 1 Hz followed by a 5 mm sine at 2 Hz',
      expect: { 'two-waves': 'two waveform commands are emitted, one cycle each' },
    },
    () => {
      const prof = waveformProfile({ waveform: 'sine', amplitude: 5, frequency: 1 });
      prof.sets[0].moves.push({
        moveType: 'math',
        moveParameters: { position: 0, velocity: 0, time: 0, waveform: 'sine', amplitude: 5, frequency: 2 },
      });
      const g123 = generateTestGcode(prof).gcode.filter((l) => /^G123 /.test(l));
      expect(g123.length).toBe(2);
      expect(g123.every((l) => /\bC1\b/.test(l))).toBe(true);
    },
  );

  behaviour(
    {
      id: 'profile.zero-amplitude-sine-emits-no-motion',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a sine with no amplitude',
      expect: { 'no-motion': 'the generated program contains no move' },
    },
    () => {
      const { gcode } = generateTestGcode(waveformProfile({ waveform: 'sine', amplitude: 0, frequency: 1 }));
      expect(gcode.some((l) => /^G(1|123) /.test(l))).toBe(false);
    },
  );

  behaviour(
    {
      id: 'profile.waveform-uploads-as-one-record',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a set of one 4 mm, 1 Hz sine executed three times, uploaded with 15 mm of gauge length',
      expect: {
        'one-waveform': 'the program carries exactly one waveform',
        'wire-size': 'the waveform takes the agreed 21 bytes on the wire',
        'sine-shape': 'the waveform carries the sine shape',
        'authored-values': 'the waveform carries the authored amplitude and frequency, and three cycles',
      },
    },
    () => {
      const { gcode } = generateTestGcode(repeatedSine(3, { amplitude: 4, frequency: 1 }));
      const ops = gcodeLinesToProgram(gcode, 15);
      const waveforms = ops.filter((o) => o.kind === 'waveform');
      expect(waveforms.length).toBe(1);
      expect(waveforms[0].buf.length).toBe(21);
      const wf = decodeWaveformMove(waveforms[0].buf);
      expect(wf.shape).toBe(WaveformShape.SINE);
      expect(wf.amplitude).toBeCloseTo(4, 3);
      expect(wf.frequency).toBeCloseTo(1, 3);
      expect(wf.cycles).toBe(3);
    },
  );
});

describe('sigmoid move', () => {
  behaviour(
    {
      id: 'profile.sigmoid-plan-long-move',
      covers: 'src/domain/testProfile.ts#planSigmoid',
      given: 'a 20 mm sigmoid move at 10 mm/s and 50 mm/s squared',
      expect: {
        'reaches-velocity': 'it cruises at the full 10 mm/s',
        'smooth-ramp': 'speeding up takes pi times speed over twice the acceleration, about 0.31 s',
        'exact-ends': 'it covers exactly 20 mm, starting and ending at rest',
        'symmetric': 'it is halfway along at half its duration',
      },
      why: {
        'smooth-ramp':
          'the acceleration rises and falls as a half-sine bump peaking at the given acceleration, which takes longer than switching it on would',
      },
    },
    () => {
      const plan = planSigmoid(20, 10, 50)!;
      expect(plan.peakVelocity).toBe(10);
      expect(plan.rampTime).toBeCloseTo(Math.PI / 10, 9);
      expect(plan.at(0)).toBe(0);
      expect(plan.at(plan.duration)).toBe(20);
      expect(plan.at(plan.duration / 2)).toBeCloseTo(10, 9);
      const h = 1e-6;
      expect((plan.at(h) - plan.at(0)) / h).toBeCloseTo(0, 3);
    },
  );

  behaviour(
    {
      id: 'profile.sigmoid-plan-short-move',
      covers: 'src/domain/testProfile.ts#planSigmoid',
      given: 'a 1 mm sigmoid move at 50 mm/s and 50 mm/s squared, too short to reach that speed',
      expect: {
        'lower-peak': 'it peaks at the square root of twice the acceleration times the distance over pi, about 5.6 mm/s',
        'no-cruise': 'it speeds up for half the move and brakes for the other half',
      },
    },
    () => {
      const plan = planSigmoid(1, 50, 50)!;
      expect(plan.peakVelocity).toBeCloseTo(Math.sqrt((2 * 50 * 1) / Math.PI), 9);
      expect(plan.duration).toBeCloseTo(2 * plan.rampTime, 9);
    },
  );

  behaviour(
    {
      id: 'profile.sigmoid-emits-a-smooth-chain',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a sigmoid move from zero length to 20 mm at 10 mm/s and 50 mm/s squared',
      expect: {
        'ends-on-position': 'its straight moves end exactly at 20 mm',
        'one-way': 'every move goes forward, toward the position',
        'speeds-rise-and-fall': 'the move speeds rise to 10 mm/s and fall again',
        'takes-the-plan': 'the preview takes the planned duration',
      },
      why: {
        'speeds-rise-and-fall':
          'the machine carries its speed from one move into the next, so a chain whose speeds follow the curve runs as one smooth S-curve',
      },
    },
    () => {
      const { gcode, time } = generateTestGcode(
        waveformProfile({ waveform: 'sigmoid', position: 20, velocity: 10, acceleration: 50 }),
      );
      const moves = gcode
        .filter((l) => /^G1 /.test(l))
        .map((l) => ({ x: Number(/X(-?[\d.]+)/.exec(l)![1]), f: Number(/F([\d.]+)/.exec(l)![1]) }));
      expect(moves.length).toBeGreaterThan(8);
      expect(moves[moves.length - 1].x).toBe(20);
      for (let i = 1; i < moves.length; i++) expect(moves[i].x).toBeGreaterThan(moves[i - 1].x);
      const peak = Math.max(...moves.map((m) => m.f));
      expect(peak).toBeCloseTo(10, 1);
      expect(moves[0].f).toBeLessThan(peak);
      expect(moves[moves.length - 1].f).toBeLessThan(peak);
      expect(time[time.length - 1]).toBeCloseTo(planSigmoid(20, 10, 50)!.duration, 3);
    },
  );

  behaviour(
    {
      id: 'profile.sigmoid-without-acceleration',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a sigmoid move with no acceleration',
      expect: { 'no-motion': 'the generated program contains no move' },
    },
    () => {
      const { gcode } = generateTestGcode(waveformProfile({ waveform: 'sigmoid', position: 20, velocity: 10 }));
      expect(gcode.some((l) => /^G(1|123) /.test(l))).toBe(false);
    },
  );
});

describe('chirp', () => {
  behaviour(
    {
      id: 'profile.chirp-whole-cycles',
      covers: 'src/domain/testProfile.ts#chirpCycles',
      given: 'a chirp from 0.1 Hz to 1 Hz asked to last 30 seconds',
      expect: {
        'cycles-from-mean': 'it runs 17 cycles: 30 seconds at the 0.55 Hz mean, rounded to a whole number',
        'duration-follows': 'its actual duration is those cycles at the mean frequency, about 30.9 seconds',
      },
      why: { 'cycles-from-mean': 'a linear sweep averages the mean of its ends, and only whole cycles end it at rest where it started' },
    },
    () => {
      const sweep = chirpCycles(0.1, 1, 30);
      expect(sweep.cycles).toBe(17);
      expect(sweep.duration).toBeCloseTo(17 / 0.55, 9);
    },
  );

  behaviour(
    {
      id: 'profile.chirp-emits-one-sweep',
      covers: 'src/domain/testProfile.ts#generateTestGcode',
      given: 'a 0.5 mm chirp from 0.1 Hz to 1 Hz over 30 seconds, in a set executed twice',
      expect: {
        'one-command-each': 'each execution emits its own waveform command with the end frequency, two in all',
        'uploads': 'the program validates and uploads, each waveform carrying both frequencies',
      },
      why: { 'one-command-each': 'joining two sweeps into one command would make it a different, longer sweep' },
    },
    () => {
      const prof = waveformProfile({ waveform: 'chirp', amplitude: 0.5, frequency: 0.1, endFrequency: 1, duration: 30 });
      prof.sets[0].executions = 2;
      const { gcode } = generateTestGcode(prof);
      const g123 = gcode.filter((l) => /^G123 /.test(l));
      expect(g123.length).toBe(2);
      expect(g123[0]).toMatch(/^G123 A0\.5 F0\.1 C17 W0 E1\b/);
      const waves = gcodeLinesToProgram(gcode, 15).filter((o) => o.kind === 'waveform');
      const wf = decodeWaveformMove(waves[0].buf);
      expect(wf.frequency).toBeCloseTo(0.1, 6);
      expect(wf.endFrequency).toBeCloseTo(1, 6);
    },
  );
});
