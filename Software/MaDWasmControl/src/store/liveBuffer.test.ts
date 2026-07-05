import { describe, it, expect, beforeEach } from 'vitest';
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

  it('returns points in order before wrapping', () => {
    for (let i = 0; i < 5; i++) pushSample(sample(i));
    const s = getLiveSeries();
    expect(s.length).toBe(5);
    expect(Array.from(s.machineForce)).toEqual([0, 1, 2, 3, 4]);
    expect(isMonotonic(s.t)).toBe(true);
  });

  it('keeps the most recent CAPACITY points in chronological order after wrapping', () => {
    const total = CAPACITY + 10;
    for (let i = 0; i < total; i++) pushSample(sample(i));
    const s = getLiveSeries();
    expect(s.length).toBe(CAPACITY);
    // Oldest retained sample is index 10; newest is total-1.
    expect(s.machineForce[0]).toBe(10);
    expect(s.machineForce[CAPACITY - 1]).toBe(total - 1);
    expect(isMonotonic(s.machineForce)).toBe(true);
    expect(isMonotonic(s.t)).toBe(true);
  });

  it('seedSamples backfills only while empty, oldest→newest with increasing time', () => {
    seedSamples([sample(1), sample(2), sample(3)], 10);
    let s = getLiveSeries();
    expect(Array.from(s.machineForce)).toEqual([1, 2, 3]);
    expect(isMonotonic(s.t)).toBe(true);
    // No-op once data is present.
    seedSamples([sample(99)], 10);
    s = getLiveSeries();
    expect(s.length).toBe(3);
  });
});
