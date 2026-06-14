import { describe, it, expect } from 'vitest';
import {
  generateTestGcode,
  waveformSample,
  waveformPeakVelocity,
  WAVEFORM_SEGMENTS_PER_CYCLE,
} from './testProfile';
import { gcodeLinesToMachineMoveBuffers } from './gcode';
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
  it('expands a sine waveform into ~segments-per-cycle × cycles G1 moves oscillating ±amplitude', () => {
    const cycles = 2;
    const amplitude = 5;
    const { gcode, distance, time } = generateTestGcode(
      waveformProfile({ waveform: 'sine', amplitude, frequency: 1, cycles }),
    );
    const g1 = gcode.filter((l) => /^G1 /.test(l));
    expect(g1.length).toBe(cycles * WAVEFORM_SEGMENTS_PER_CYCLE); // centre==start ⇒ no ramp-in
    // Oscillates around 0 by ±amplitude (relative, centre = start position 0).
    expect(Math.max(...distance)).toBeCloseTo(amplitude, 1);
    expect(Math.min(...distance)).toBeCloseTo(-amplitude, 1);
    // Time strictly advances and the trailing stop is present.
    for (let i = 1; i < time.length; i++) expect(time[i]).toBeGreaterThanOrEqual(time[i - 1]);
    expect(gcode[gcode.length - 1]).toBe('G122 ; Stop - signal test complete');
  });

  it('a degenerate waveform (no cycles) emits no motion', () => {
    const { gcode } = generateTestGcode(waveformProfile({ waveform: 'sine', amplitude: 5, frequency: 1, cycles: 0 }));
    expect(gcode.some((l) => /^G1 /.test(l))).toBe(false);
  });

  it('segment feedrates stay within the encodable range for a modest waveform', () => {
    const { gcode } = generateTestGcode(
      waveformProfile({ waveform: 'sine', amplitude: 5, frequency: 1, cycles: 1 }),
    );
    const feeds = gcode
      .map((l) => /F([\d.]+)/.exec(l)?.[1])
      .filter((f): f is string => f !== undefined)
      .map(Number);
    expect(feeds.length).toBeGreaterThan(0);
    // Sine peak velocity = 2π·5·1 ≈ 31.4 mm/s, well within the codec's ~131 mm/s.
    expect(Math.max(...feeds)).toBeLessThan(40);
  });

  it('generated waveform converts to uploadable machine-move buffers (full pipeline)', () => {
    const { gcode } = generateTestGcode(
      waveformProfile({ waveform: 'triangle', amplitude: 4, frequency: 1, cycles: 1 }),
    );
    // Validates + encodes every move (incl. gauge offset, range checks) — must not throw.
    const buffers = gcodeLinesToMachineMoveBuffers(gcode, 15);
    expect(buffers.length).toBeGreaterThan(0);
    expect(buffers.every((b) => b.length === 7)).toBe(true); // 7-byte Move wire size
  });
});
