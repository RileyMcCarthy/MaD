import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import {
  generateExpectedMotion,
  interpolateExpected,
  computeStressStrain,
} from './analysis';
import { TestDataPoint } from './sample';
import { SampleProfile } from './types';

describe('generateExpectedMotion', () => {
  behaviour(
    {
      id: 'analysis.expected-motion-from-gcode',
      covers: 'src/domain/analysis.ts#generateExpectedMotion',
      given: 'a program that moves absolutely to 10 mm at 5 mm/s, pauses one second, then moves relatively minus 4 mm at 2 mm/s',
      then: 'the expected motion ends at 6 mm, time only moves forward, and the total time is the two travel times plus the one-second pause',
    },
    () => {
      const gcode = ['G90', 'G1 X10 F5', 'G4 P1000', 'G91', 'G1 X-4 F2', 'G122'];
      const { time, position } = generateExpectedMotion(gcode, 0);
      // ends at 10 then 10 (dwell) then 6 (relative -4)
      expect(position[position.length - 1]).toBeCloseTo(6, 5);
      // time monotonic, includes the 1s dwell and travel times
      for (let i = 1; i < time.length; i++) expect(time[i]).toBeGreaterThanOrEqual(time[i - 1]);
      expect(time[time.length - 1]).toBeCloseTo(10 / 5 + 1 + 4 / 2, 5);
    },
  );

  behaviour(
    {
      id: 'analysis.expected-motion-starts-at-anchor',
      covers: 'src/domain/analysis.ts#generateExpectedMotion',
      given: 'a relative move of 5 mm starting from 100 mm',
      then: 'the expected motion of a relative 5 mm move from 100 mm starts at 100 mm and ends at 105 mm',
    },
    () => {
      const { position } = generateExpectedMotion(['G91', 'G1 X5 F5'], 100);
      expect(position[0]).toBe(100);
      expect(position[position.length - 1]).toBeCloseTo(105, 5);
    },
  );
});

describe('interpolateExpected', () => {
  behaviour(
    {
      id: 'analysis.expected-curve-interpolates-and-clamps',
      covers: 'src/domain/analysis.ts#interpolateExpected',
      given: 'an expected curve from 0 to 10 mm over two seconds, sampled before, during, and after that span',
      then: 'a sample before the expected curve stays at the start position, a sample after stays at the end position, and a sample in the middle is the linear value between them',
    },
    () => {
      const exp = { time: [0, 2], position: [0, 10] };
      expect(interpolateExpected(exp, [-1, 0, 1, 2, 3])).toEqual([0, 0, 5, 10, 10]);
    },
  );
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

  behaviour(
    {
      id: 'analysis.stress-strain-from-force-and-extension',
      covers: 'src/domain/analysis.ts#computeStressStrain',
      given: 'a sample 2 mm by 1 mm, with a 100 N reading after 1 mm of extension on a 10 mm gauge, and limits of 200 N and 5 mm',
      then: 'stress is 50 megapascals and strain is 10 percent, and the chart limits are 100 megapascals and 50 percent',
    },
    () => {
      const { data, maxStress, maxStrain } = computeStressStrain(points, profile, 10);
      // area = 2; stress at 2nd point = 100/2 = 50 MPa; strain = (11-10)/10*100 = 10%
      expect(data[1].y).toBeCloseTo(50, 5);
      expect(data[1].x).toBeCloseTo(10, 5);
      expect(maxStress).toBeCloseTo(100, 5); // 200/2
      expect(maxStrain).toBeCloseTo(50, 5); // 5/10*100
    },
  );

  behaviour(
    {
      id: 'analysis.zero-section-has-no-stress-strain',
      covers: 'src/domain/analysis.ts#computeStressStrain',
      given: 'logged force and position with a sample whose width is zero',
      then: 'a sample with zero width produces no stress-strain points',
    },
    () => {
      expect(computeStressStrain(points, { ...profile, sampleWidth: 0 }, 10).data).toEqual([]);
    },
  );
});
