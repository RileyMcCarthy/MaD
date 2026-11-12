import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { expectedAt, jogSegment, segmentsFromMotion } from './expectedPath';

describe('expected path on the live chart', () => {
  behaviour(
    {
      id: 'expected-path.jog-is-a-ramp',
      covers: 'src/domain/expectedPath.ts#jogSegment',
      given: 'a 10 mm jog at 5 mm/s sent with the machine resting at 20 mm',
      expect: {
        'straight-line': 'halfway through its two seconds the expected position is halfway, 25 mm',
        'ends-at-target': 'it ends at 30 mm and stays there',
      },
      why: { 'straight-line': 'the expected path is the commanded speed with no acceleration' },
    },
    () => {
      const seg = jogSegment([], 100, 20, 10, 5);
      expect(expectedAt([seg], 101, 30)).toBeCloseTo(25, 9);
      expect(expectedAt([seg], 110, 30)).toBe(30);
    },
  );

  behaviour(
    {
      id: 'expected-path.queued-jog',
      covers: 'src/domain/expectedPath.ts#jogSegment',
      given: 'a second jog sent while the first is still underway',
      expect: { 'starts-after': 'it starts when and where the first one ends' },
      why: { 'starts-after': 'the machine queues moves and runs them one after another' },
    },
    () => {
      const first = jogSegment([], 0, 0, 10, 5);
      const second = jogSegment([first], 1, 999, 5, 5);
      expect(second).toEqual({ t0: 2, t1: 3, p0: 10, p1: 15 });
    },
  );

  behaviour(
    {
      id: 'expected-path.unknown-motion',
      covers: 'src/domain/expectedPath.ts#expectedAt',
      given: 'a finished path, while the machine is heading somewhere the path does not end',
      expect: {
        'blank': 'no expected position is shown',
        'before-start': 'nothing is shown before the path starts either',
      },
      why: { 'blank': 'something the app did not plan, such as homing, moved the machine' },
    },
    () => {
      const seg = jogSegment([], 0, 0, 10, 5);
      expect(expectedAt([seg], 50, 42)).toBeNull();
      expect(expectedAt([seg], -1, 10)).toBeNull();
    },
  );

  behaviour(
    {
      id: 'expected-path.test-program',
      covers: 'src/domain/expectedPath.ts#segmentsFromMotion',
      given: 'a test program\'s ideal motion started at 50 s on a machine with a 20 mm gauge length',
      expect: { 'machine-frame': 'its positions are shifted by the gauge length and its times by the start' },
    },
    () => {
      const segs = segmentsFromMotion({ time: [0, 2], position: [0, 10] }, 50, 20);
      expect(segs).toEqual([{ t0: 50, t1: 52, p0: 20, p1: 30 }]);
    },
  );
});
