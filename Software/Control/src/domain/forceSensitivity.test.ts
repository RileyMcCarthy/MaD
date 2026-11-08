import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { LIGHT_LOAD_SHARE, MIN_RESPONSE_N, STANDARD_GRAVITY, fitSensitivity } from './forceSensitivity';
import type { SavedLoadCell } from './forceZero';

/** 100 N at 2 mV/V. */
const CELL: SavedLoadCell = { capacityN: 100, sensitivityMvV: 2, zeroBalanceMvV: 0.01 };

describe('load cell sensitivity from known weights', () => {
  behaviour(
    {
      id: 'force-sensitivity.scaled-by-weight',
      covers: 'src/domain/forceSensitivity.ts#fitSensitivity',
      given:
        'a load cell saved at 2 mV/V that reads 0.3 N unloaded and 50.3 N with a 5 kg weight hanging from it',
      expect: {
        'tared': "the weight is measured as the change from the unloaded reading, 50 N, so the zero balance's error drops out",
        'scaled': 'the new sensitivity is the saved one times measured over known force, 5 kg at standard gravity being 49.033 N',
        'error-shown': 'the weight is reported as reading about 1.97% high',
      },
    },
    () => {
      const r = fitSensitivity([{ massKg: 5, unloadedN: 0.3, loadedN: 50.3 }], CELL);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.fit.points[0].measuredN).toBeCloseTo(50, 9);
      expect(r.fit.sensitivityMvV).toBeCloseTo((2 * 50) / (5 * STANDARD_GRAVITY), 6);
      expect(r.fit.points[0].errorPct).toBeCloseTo(1.97, 2);
    },
  );

  behaviour(
    {
      id: 'force-sensitivity.fit-and-linearity',
      covers: 'src/domain/forceSensitivity.ts#fitSensitivity',
      given: 'three weights of 2, 5 and 10 kg on a load cell whose middle weight reads 0.1 N more than a straight line through the other two',
      expect: {
        'least-squares': 'the sensitivity comes from a least-squares line through zero and all three weights',
        'linearity': "linearity is the largest distance of a weight from that line, as a percentage of the largest weight's force",
        'residuals': 'each weight is reported with its distance from the line',
      },
    },
    () => {
      const g = STANDARD_GRAVITY;
      const masses = [2, 5, 10];
      const measured = masses.map((m) => m * g + (m === 5 ? 0.1 : 0));
      const r = fitSensitivity(
        masses.map((m, i) => ({ massKg: m, unloadedN: 0, loadedN: measured[i] })),
        CELL,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const known = masses.map((m) => m * g);
      const slope = known.reduce((a, k, i) => a + k * measured[i], 0) / known.reduce((a, k) => a + k * k, 0);
      expect(r.fit.scale).toBeCloseTo(slope, 12);
      const residuals = known.map((k, i) => measured[i] / slope - k);
      expect(r.fit.points.map((p) => p.residualN)).toEqual(residuals.map((x) => expect.closeTo(x, 9)));
      expect(r.fit.linearityPct).toBeCloseTo((Math.max(...residuals.map(Math.abs)) / (10 * g)) * 100, 9);
    },
  );

  behaviour(
    {
      id: 'force-sensitivity.reversed-polarity',
      covers: 'src/domain/forceSensitivity.ts#fitSensitivity',
      given: 'a 5 kg weight that the machine reads as pushing on the load cell with 49 N',
      expect: {
        'flagged': 'the load cell is reported as wired the other way round from the saved sensitivity',
        'negative': 'the new sensitivity has the opposite sign from the saved one',
      },
    },
    () => {
      const r = fitSensitivity([{ massKg: 5, unloadedN: 0, loadedN: -49 }], CELL);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.fit.polarityReversed).toBe(true);
      expect(r.fit.sensitivityMvV).toBeLessThan(0);
    },
  );

  behaviour(
    {
      id: 'force-sensitivity.light-load',
      covers: 'src/domain/forceSensitivity.ts#fitSensitivity',
      given: `weights whose largest is under ${LIGHT_LOAD_SHARE * 100}% of a 100 N load cell's capacity, and one at it`,
      expect: {
        'light-flagged': `a largest weight under ${LIGHT_LOAD_SHARE * 100}% of capacity is flagged as light`,
        'heavy-not-flagged': `a largest weight at ${LIGHT_LOAD_SHARE * 100}% of capacity or more is not`,
      },
      why: { 'light-flagged': 'the fit then has to reach a long way past the heaviest weight to full scale' },
    },
    () => {
      const at = (massKg: number) => fitSensitivity([{ massKg, unloadedN: 0, loadedN: massKg * STANDARD_GRAVITY }], CELL);
      const light = at(1);
      const heavy = at(Math.ceil((LIGHT_LOAD_SHARE * 100) / STANDARD_GRAVITY));
      expect(light.ok).toBe(true);
      expect(heavy.ok).toBe(true);
      if (light.ok) expect(light.fit.lightLoad).toBe(true);
      if (heavy.ok) expect(heavy.fit.lightLoad).toBe(false);
    },
  );

  behaviour(
    {
      id: 'force-sensitivity.local-gravity',
      covers: 'src/domain/forceSensitivity.ts#fitSensitivity',
      given: 'a 5 kg weight read at a place where gravity is 9.78 m/s²',
      expect: { 'gravity-used': 'the known force is the mass times the gravity entered, 48.9 N' },
    },
    () => {
      const r = fitSensitivity([{ massKg: 5, unloadedN: 0, loadedN: 50 }], CELL, 9.78);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.fit.points[0].knownN).toBeCloseTo(48.9, 9);
    },
  );

  behaviour(
    {
      id: 'force-sensitivity.weight-not-registered',
      covers: 'src/domain/forceSensitivity.ts#fitSensitivity',
      given: `a weight that moved the reading by less than ${MIN_RESPONSE_N * 1000} mN`,
      expect: { 'refused': 'no sensitivity is fitted, and the reason names the weight that did not register' },
    },
    () => {
      const r = fitSensitivity([{ massKg: 2, unloadedN: 0, loadedN: 0.01 }], CELL);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('2 kg');
    },
  );

  behaviour(
    {
      id: 'force-sensitivity.needs-load-cell',
      covers: 'src/domain/forceSensitivity.ts#fitSensitivity',
      given: 'a saved profile with no load cell sensitivity',
      expect: { 'refused': 'no sensitivity is fitted, and the reason names Load Cell Sensitivity' },
    },
    () => {
      const r = fitSensitivity([{ massKg: 5, unloadedN: 0, loadedN: 49 }], { ...CELL, sensitivityMvV: 0 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/Load Cell Sensitivity/);
    },
  );
});
