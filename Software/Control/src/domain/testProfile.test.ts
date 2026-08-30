import { describe, it, expect } from 'vitest';
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
  it('emits header, mode lines, moves, and trailing G122', () => {
    const { gcode } = generateTestGcode(base);
    const joined = gcode.join('\n');
    expect(gcode[0]).toBe('; Test Profile: T1');
    expect(joined).toContain('G90 ; Set absolute positioning');
    expect(joined).toContain('G1 X5 F2');
    expect(joined).toContain('G4 P500');
    expect(joined).toContain('G91 ; Set relative positioning');
    expect(joined).toContain('G1 X-3 F4');
    expect(gcode[gcode.length - 1]).toBe('G122 ; Stop - signal test complete');
  });

  it('repeats moves per execution', () => {
    const { gcode } = generateTestGcode(base);
    const linearAbs = gcode.filter((l) => l === 'G1 X5 F2').length;
    expect(linearAbs).toBe(2); // executions: 2
  });

  it('produces a monotonic-in-time distance/time series', () => {
    const { time, distance } = generateTestGcode(base);
    expect(time.length).toBe(distance.length);
    for (let i = 1; i < time.length; i++) {
      expect(time[i]).toBeGreaterThanOrEqual(time[i - 1]);
    }
  });
});

describe('waveform helpers', () => {
  it('waveformSample sine key points', () => {
    expect(waveformSample('sine', 0)).toBeCloseTo(0, 6);
    expect(waveformSample('sine', 0.25)).toBeCloseTo(1, 6);
    expect(waveformSample('sine', 0.75)).toBeCloseTo(-1, 6);
    expect(waveformSample('sine', 1)).toBeCloseTo(0, 6);
  });
  it('waveformSample triangle key points', () => {
    expect(waveformSample('triangle', 0)).toBeCloseTo(0, 6);
    expect(waveformSample('triangle', 0.25)).toBeCloseTo(1, 6);
    expect(waveformSample('triangle', 0.5)).toBeCloseTo(0, 6);
    expect(waveformSample('triangle', 0.75)).toBeCloseTo(-1, 6);
  });
  it('waveformPeakVelocity matches 2πAf (sine) and 4Af (triangle)', () => {
    expect(waveformPeakVelocity('sine', 5, 1)).toBeCloseTo(2 * Math.PI * 5, 6);
    expect(waveformPeakVelocity('triangle', 5, 1)).toBeCloseTo(20, 6);
  });

  it('waveformPeakAcceleration matches (2πf)²A for a sine', () => {
    expect(waveformPeakAcceleration('sine', 5, 1)).toBeCloseTo((2 * Math.PI) ** 2 * 5, 6);
    // Scales with f², which is why a modest frequency bump blows the envelope:
    // 3mm @ 2Hz needs ~474 mm/s² where 5mm @ 1Hz needs only ~197.
    expect(waveformPeakAcceleration('sine', 3, 2)).toBeCloseTo(473.74, 2);
    expect(waveformPeakAcceleration('sine', 10, 0.5)).toBeCloseTo(98.7, 1);
  });

  it('waveformPeakAcceleration is sign- and zero-safe', () => {
    expect(waveformPeakAcceleration('sine', -5, -1)).toBeCloseTo((2 * Math.PI) ** 2 * 5, 6);
    expect(waveformPeakAcceleration('sine', 0, 10)).toBe(0);
    expect(waveformPeakAcceleration('sine', 10, 0)).toBe(0);
  });

  it("waveformPeakAcceleration reports 0 for a triangle (impulsive, not the binding limit)", () => {
    expect(waveformPeakAcceleration('triangle', 5, 1)).toBe(0);
  });
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
  it('emits one firmware-native G123 with the waveform params (no host segment expansion)', () => {
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
  });

  it('a degenerate waveform (no cycles) emits no motion', () => {
    const { gcode } = generateTestGcode(waveformProfile({ waveform: 'sine', amplitude: 5, frequency: 1, cycles: 0 }));
    expect(gcode.some((l) => /^G(1|123) /.test(l))).toBe(false);
  });

  it('v1 is sine-only: a legacy triangle profile is coerced to sine (W0), never silently W1', () => {
    const { gcode } = generateTestGcode(
      waveformProfile({ waveform: 'triangle', amplitude: 5, frequency: 1, cycles: 1 }),
    );
    const g123 = gcode.find((l) => /^G123 /.test(l));
    expect(g123).toMatch(/\bW0\b/);
    expect(g123).not.toMatch(/\bW1\b/);
  });

  it('generated waveform becomes a single uploadable WaveformMove op (full pipeline)', () => {
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
  });
});
