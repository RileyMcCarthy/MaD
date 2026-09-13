import { describe, expect, beforeEach } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { pushSample, resetLiveBuffer, getLiveSeries, seedSamples } from './liveBuffer';
import { SampleData } from '@/domain';

const CAPACITY = 6000;

function sample(force: number): SampleData {
  return {
    'Machine Force (N)': force,
    'Machine Position (mm)': force / 10,
    'Machine Setpoint (mm)': force / 10,
    'Sample Force (N)': force,
    'Sample Position (mm)': force / 10,
  };
}

function isMonotonic(a: Float64Array): boolean {
  for (let i = 1; i < a.length; i++) if (a[i] < a[i - 1]) return false;
  return true;
}

describe('liveBuffer ring', () => {
  beforeEach(() => resetLiveBuffer());

  behaviour(
    {
      id: 'live.chart-points-stay-in-time-order',
      covers: 'src/store/liveBuffer.ts#getLiveSeries',
      given: 'five live samples pushed in sequence',
      expect: {
        'all-five-in-order': 'all five appear on the live chart in arrival order',
        'time-increasing': 'time increases across the points',
      },
    },
    () => {
      for (let i = 0; i < 5; i++) pushSample(sample(i));
      const s = getLiveSeries();
      expect(s.length).toBe(5);
      expect(Array.from(s.machineForce)).toEqual([0, 1, 2, 3, 4]);
      expect(isMonotonic(s.t)).toBe(true);
    },
  );

  behaviour(
    {
      id: 'live.chart-keeps-the-newest-minute',
      covers: 'src/store/liveBuffer.ts#getLiveSeries',
      given: 'more live samples than the chart can hold',
      expect: {
        'oldest-dropped': 'the oldest points are dropped and the chart holds the newest minute',
        'newest-kept': 'the most recent sample is the last point on the chart',
        'time-order-kept': 'the kept points stay in arrival order, with time increasing',
      },
      why: { 'oldest-dropped': 'the live view is about a minute at 100 samples a second' },
    },
    () => {
      const total = CAPACITY + 10;
      for (let i = 0; i < total; i++) pushSample(sample(i));
      const s = getLiveSeries();
      expect(s.length).toBe(CAPACITY);
      // Oldest retained sample is index 10; newest is total-1.
      expect(s.machineForce[0]).toBe(10);
      expect(s.machineForce[CAPACITY - 1]).toBe(total - 1);
      expect(isMonotonic(s.machineForce)).toBe(true);
      expect(isMonotonic(s.t)).toBe(true);
    },
  );

  behaviour(
    {
      id: 'live.history-seeds-only-an-empty-chart',
      covers: 'src/store/liveBuffer.ts#seedSamples',
      given: 'an empty live chart seeded with three historical samples, then seeded again',
      expect: {
        'seed-lands-oldest-first': 'the three points land oldest to newest',
        'seed-time-increasing': 'time increases across the seeded points',
        'second-seed-ignored': 'the second seed leaves the chart unchanged',
      },
      why: { 'second-seed-ignored': 'once live samples are flowing there is nothing to seed' },
    },
    () => {
      seedSamples([sample(1), sample(2), sample(3)], 10);
      let s = getLiveSeries();
      expect(Array.from(s.machineForce)).toEqual([1, 2, 3]);
      expect(isMonotonic(s.t)).toBe(true);
      // No-op once data is present.
      seedSamples([sample(99)], 10);
      s = getLiveSeries();
      expect(s.length).toBe(3);
    },
  );
});
