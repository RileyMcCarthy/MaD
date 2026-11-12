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
      expect: {
        'ends-at-six': 'the expected motion ends at 6 mm',
        'time-moves-forward': 'time only moves forward',
        'run-takes-five-seconds': 'the whole run takes five seconds',
      },
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
      expect: {
        'starts-at-anchor': 'the expected motion starts at 100 mm',
        'ends-five-further': 'it ends at 105 mm',
      },
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
      expect: {
        'held-outside-span': 'samples outside the span hold the start and end positions',
        'midpoint-interpolated': 'a sample between two expected points reads the straight-line value between them',
      },
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
      expect: {
        'stress-at-point': 'stress is 50 megapascals',
        'strain-at-point': 'strain is 10 percent',
        'stress-limit': 'the chart stress limit is 100 megapascals',
        'strain-limit': 'the chart strain limit is 50 percent',
      },
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
      given: 'logged force and position for a sample whose width is zero',
      expect: {
        'curve-empty': 'the stress-strain curve comes out empty',
      },
    },
    () => {
      expect(computeStressStrain(points, { ...profile, sampleWidth: 0 }, 10).data).toEqual([]);
    },
  );
});

describe('generateExpectedMotion — sine', () => {
  behaviour(
    {
      id: 'analysis.expected-wave-from-rest',
      covers: 'src/domain/analysis.ts#generateExpectedMotion',
      given: 'a program running a 5 mm, 1 Hz wave of two cycles from 10 mm, and one of minus 5 mm',
      expect: {
        'rises-from-start': 'the expected curve starts at rest at 10 mm and rises, reaching 20 mm half a cycle in',
        'full-stroke': 'it swings between 10 mm and 20 mm',
        'two-seconds': 'it lasts the two seconds of its cycles and ends back at 10 mm',
        'negative-falls': 'with a negative amplitude it falls to 0 mm instead',
      },
      why: { 'rises-from-start': 'the machine starts a wave at rest where the carriage is and sets off in the direction of the amplitude' },
    },
    () => {
      const { time, position } = generateExpectedMotion(['G90', 'G123 A5 F1 C2 W0 ; sine'], 10);
      const at = (t: number) => position[time.findIndex((x) => Math.abs(x - t) < 1e-9)];
      expect(position[0]).toBe(10);
      expect(at(0.5)).toBeCloseTo(20, 6);
      expect(Math.min(...position)).toBeCloseTo(10, 6);
      expect(Math.max(...position)).toBeCloseTo(20, 6);
      const down = generateExpectedMotion(['G123 A-5 F1 C1 W0'], 10).position;
      expect(Math.min(...down)).toBeCloseTo(0, 6);
      expect(time[time.length - 1]).toBeCloseTo(2, 9);
      expect(position[position.length - 1]).toBeCloseTo(10, 6);
    },
  );
});

describe('generateExpectedMotion — chirp', () => {
  behaviour(
    {
      id: 'analysis.expected-chirp',
      covers: 'src/domain/analysis.ts#generateExpectedMotion',
      given: 'a program running a 1 mm chirp of three cycles sweeping from 1 Hz to 2 Hz, from 0 mm',
      expect: {
        'span': 'the expected curve lasts two seconds, three cycles at the 1.5 Hz mean',
        'speeds-up': 'its second half holds more of the motion than its first, as the frequency rises',
        'ends-at-rest': 'it ends back at 0 mm',
      },
    },
    () => {
      const { time, position } = generateExpectedMotion(['G123 A1 F1 C3 W0 E2'], 0);
      expect(time[time.length - 1]).toBeCloseTo(2, 9);
      expect(position[position.length - 1]).toBeCloseTo(0, 6);
      const travel = (from: number, to: number) => {
        let sum = 0;
        for (let i = 1; i < time.length; i++) {
          if (time[i] > from && time[i] <= to) sum += Math.abs(position[i] - position[i - 1]);
        }
        return sum;
      };
      expect(travel(1, 2)).toBeGreaterThan(travel(0, 1));
    },
  );
});
