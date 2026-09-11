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
      then: 'five live samples appear on the live chart in arrival order, with time increasing',
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
      then: 'when more live samples arrive than the chart can hold, the live chart keeps the newest minute of points in time order',
      why: 'the live view is about a minute at 100 samples a second',
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
      then: 'an empty live chart is backfilled oldest to newest with increasing time, and a later seed is ignored once points are already present',
      why: 'once live samples are flowing there is nothing to seed',
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
