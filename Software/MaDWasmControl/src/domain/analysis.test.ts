import { describe, it, expect } from 'vitest';
import {
  generateExpectedMotion,
  interpolateExpected,
  computeStressStrain,
} from './analysis';
import { TestDataPoint } from './sample';
import { SampleProfile } from './types';

describe('generateExpectedMotion', () => {
  it('reconstructs absolute + relative + dwell motion from G-code', () => {
    const gcode = ['G90', 'G1 X10 F5', 'G4 P1000', 'G91', 'G1 X-4 F2', 'G122'];
    const { time, position } = generateExpectedMotion(gcode, 0);
    // ends at 10 then 10 (dwell) then 6 (relative -4)
    expect(position[position.length - 1]).toBeCloseTo(6, 5);
    // time monotonic, includes the 1s dwell and travel times
    for (let i = 1; i < time.length; i++) expect(time[i]).toBeGreaterThanOrEqual(time[i - 1]);
    expect(time[time.length - 1]).toBeCloseTo(10 / 5 + 1 + 4 / 2, 5);
  });

  it('anchors at the provided initial position', () => {
    const { position } = generateExpectedMotion(['G91', 'G1 X5 F5'], 100);
    expect(position[0]).toBe(100);
    expect(position[position.length - 1]).toBeCloseTo(105, 5);
  });
});

describe('interpolateExpected', () => {
  it('clamps and linearly interpolates', () => {
    const exp = { time: [0, 2], position: [0, 10] };
    expect(interpolateExpected(exp, [-1, 0, 1, 2, 3])).toEqual([0, 0, 5, 10, 10]);
  });
});

describe('computeStressStrain', () => {
  const profile: SampleProfile = {
    maxForce: 200,
    maxVelocity: 0,
    maxDisplacement: 5,
    sampleWidth: 2,
    sampleThickness: 1,
    serial: '',
  };
  const points: TestDataPoint[] = [
    { timeS: 0, forceN: 0, positionMm: 10, setpointMm: 10 },
    { timeS: 1, forceN: 100, positionMm: 11, setpointMm: 11 },
  ];

  it('computes stress (MPa) and strain (%) with limits', () => {
    const { data, maxStress, maxStrain } = computeStressStrain(points, profile, 10);
    // area = 2; stress at 2nd point = 100/2 = 50 MPa; strain = (11-10)/10*100 = 10%
    expect(data[1].y).toBeCloseTo(50, 5);
    expect(data[1].x).toBeCloseTo(10, 5);
    expect(maxStress).toBeCloseTo(100, 5); // 200/2
    expect(maxStrain).toBeCloseTo(50, 5); // 5/10*100
  });

  it('returns empty for zero cross-section', () => {
    expect(computeStressStrain(points, { ...profile, sampleWidth: 0 }, 10).data).toEqual([]);
  });
});
