import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { ZERO_MIN_SAMPLES, measureZero, type SavedLoadCell } from './forceZero';

/** 100 N at 2 mV/V: 0.02 mV/V per newton. */
const CELL: SavedLoadCell = { capacityN: 100, sensitivityMvV: 2, zeroBalanceMvV: 0.01 };

/** `n` readings alternating `mean ± swing`. */
function readings(n: number, mean: number, swing = 0): number[] {
  return Array.from({ length: n }, (_, i) => mean + (i % 2 === 0 ? swing : -swing));
}

describe('load cell zero', () => {
  behaviour(
    {
      id: 'force-zero.signal-recovered',
      covers: 'src/domain/forceZero.ts#measureZero',
      given: 'a load cell saved as 100 N at 2 mV/V with a zero balance of 0.01 mV/V, reading a steady 0.5 N with nothing on it',
      expect: {
        'zero-from-signal':
          'the new zero balance is the saved one plus the mean unloaded force turned back into mV/V by sensitivity over capacity, 0.02 mV/V',
        'offset-reported': 'the force the new zero takes away is reported as the mean unloaded reading, 0.5 N',
      },
      why: { 'zero-from-signal': 'the live samples carry force, and the firmware made that force from the saved values' },
    },
    () => {
      const r = measureZero(readings(100, 0.5), CELL);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.measurement.zeroBalanceMvV).toBeCloseTo(0.02, 9);
      expect(r.measurement.offsetN).toBeCloseTo(0.5, 9);
    },
  );

  behaviour(
    {
      id: 'force-zero.reversed-polarity',
      covers: 'src/domain/forceZero.ts#measureZero',
      given: 'a load cell wired so its saved sensitivity is −2 mV/V, reading a steady 0.5 N with nothing on it',
      expect: {
        'zero-follows-sign': 'the new zero balance moves the opposite way from the reading, to 0 mV/V from the saved 0.01',
      },
    },
    () => {
      const r = measureZero(readings(100, 0.5), { ...CELL, sensitivityMvV: -2 });
      expect(r.ok && r.measurement.zeroBalanceMvV).toBeCloseTo(0, 9);
    },
  );

  behaviour(
    {
      id: 'force-zero.noise',
      covers: 'src/domain/forceZero.ts#measureZero',
      given: 'unloaded readings swinging 0.01 N either side of zero on a 100 N, 2 mV/V load cell',
      expect: {
        'noise-std': 'the noise is the standard deviation of the readings, about 0.01 N',
        'noise-bridge-units': 'the noise is also given in nV/V, converted by sensitivity over capacity, about 200 nV/V',
        'peak-to-peak': 'the spread from lowest to highest reading is 0.02 N',
      },
    },
    () => {
      const r = measureZero(readings(100, 0, 0.01), CELL);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.measurement.noiseN).toBeCloseTo(0.01, 3);
      expect(r.measurement.noiseNvV).toBeCloseTo(200, -1);
      expect(r.measurement.peakToPeakN).toBeCloseTo(0.02, 9);
    },
  );

  behaviour(
    {
      id: 'force-zero.settling-flagged',
      covers: 'src/domain/forceZero.ts#measureZero',
      given: 'unloaded readings creeping steadily from 0 to 0.1 N while they are read',
      expect: {
        'drifting': 'the zero is flagged as still settling',
        'drift-size': 'the drift is reported as the last third of the readings minus the first third, about 0.067 N',
      },
    },
    () => {
      const creep = Array.from({ length: 99 }, (_, i) => (0.1 * i) / 98);
      const r = measureZero(creep, CELL);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.measurement.drifting).toBe(true);
      expect(r.measurement.driftN).toBeCloseTo(0.0673, 3);
    },
  );

  behaviour(
    {
      id: 'force-zero.steady-not-flagged',
      covers: 'src/domain/forceZero.ts#measureZero',
      given: 'unloaded readings swinging 0.01 N either side of a steady mean',
      expect: { 'steady': 'the zero is reported as steady' },
    },
    () => {
      const r = measureZero(readings(99, 0.2, 0.01), CELL);
      expect(r.ok && r.measurement.drifting).toBe(false);
    },
  );

  behaviour(
    {
      id: 'force-zero.needs-load-cell',
      covers: 'src/domain/forceZero.ts#measureZero',
      given: 'a saved profile with no load cell sensitivity',
      expect: {
        'refused': 'no zero is measured, and the reason names Load Cell Sensitivity',
      },
    },
    () => {
      const r = measureZero(readings(100, 0.5), { ...CELL, sensitivityMvV: 0 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/Load Cell Sensitivity/);
    },
  );

  behaviour(
    {
      id: 'force-zero.needs-readings',
      covers: 'src/domain/forceZero.ts#measureZero',
      given: `fewer than ${ZERO_MIN_SAMPLES} unloaded readings`,
      expect: {
        'refused': 'no zero is measured, and the reason gives how many readings arrived and how many are needed',
      },
    },
    () => {
      const r = measureZero(readings(ZERO_MIN_SAMPLES - 1, 0.5), CELL);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(String(ZERO_MIN_SAMPLES));
    },
  );
});
