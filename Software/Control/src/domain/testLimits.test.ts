import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import type { MachineConfiguration, Move, TestProfile } from './types';
import { checkTestLimits, type LimitContext } from './testLimits';

const machine = {
  'Position Max (mm)': 100,
  'Velocity Max (mm/s)': 5,
  'Acceleration Max (mm/s^2)': 50,
  'Tensile Force Max (N)': 1000,
  'Restricted Velocity (mm/s)': 1,
} as MachineConfiguration;

const sample = { maxForce: 500, maxVelocity: 10, maxDisplacement: 30, sampleWidth: 4, sampleThickness: 1.5, serial: 'S' };

const linear = (position: number, velocity: number): Move => ({
  moveType: 'linear',
  moveParameters: { position, velocity, time: 0 },
});

const profile = (moves: Move[], executions = 1): TestProfile => ({
  name: 'P',
  description: '',
  sets: [{ name: 'S', executions, moves }],
  sampleProfile: sample,
});

const ctx: LimitContext = { machine, startExtensionMm: 0, gaugeLengthMm: 20, restrictedVelocityMmS: null };
const ids = (p: TestProfile, c: LimitContext = ctx) => checkTestLimits(p, c).map((i) => i.id);

describe('pre-run limit check', () => {
  behaviour(
    {
      id: 'test-limits.within-limits',
      covers: 'src/domain/testLimits.ts#checkTestLimits',
      given: 'a test that stays within every machine and sample limit',
      expect: { 'no-issues': 'nothing is reported' },
    },
    () => {
      expect(ids(profile([linear(10, 2), linear(0, 2)]))).toEqual([]);
    },
  );

  behaviour(
    {
      id: 'test-limits.faster-than-machine',
      covers: 'src/domain/testLimits.ts#checkTestLimits',
      given: 'a move at 8 mm/s on a machine whose Velocity Max is 5 mm/s',
      expect: {
        'machine-velocity': 'the warning reads: motion profile speed of 8 mm/s exceeds machine limit of 5 mm/s',
        'sample-ok': 'the sample velocity limit, 10 mm/s, is not reported',
      },
      why: { 'machine-velocity': 'the machine holds every move to its velocity limit without saying so' },
    },
    () => {
      const issues = checkTestLimits(profile([linear(10, 8)]), ctx);
      const v = issues.find((i) => i.id === 'machine-velocity');
      expect(v?.message).toBe('Motion profile speed of 8 mm/s exceeds machine limit of 5 mm/s.');
      expect(issues.map((i) => i.id)).not.toContain('sample-velocity');
    },
  );

  behaviour(
    {
      id: 'test-limits.faster-than-sample',
      covers: 'src/domain/testLimits.ts#checkTestLimits',
      given: 'a move faster than the sample profile allows',
      expect: { 'sample-velocity': 'the sample velocity limit is reported' },
    },
    () => {
      expect(ids(profile([linear(10, 12)]))).toContain('sample-velocity');
    },
  );

  behaviour(
    {
      id: 'test-limits.furthest-position',
      covers: 'src/domain/testLimits.ts#checkTestLimits',
      given: 'moves to 20 mm, then 40 mm, then back to zero, on a sample allowed 30 mm of displacement',
      expect: { 'sample-displacement': 'the furthest position, 40 mm, is reported against the sample displacement limit' },
    },
    () => {
      const issues = checkTestLimits(profile([linear(20, 2), linear(40, 2), linear(0, 2)]), ctx);
      const d = issues.find((i) => i.id === 'sample-displacement');
      expect(d?.message).toContain('40 mm');
    },
  );

  behaviour(
    {
      id: 'test-limits.past-position-max',
      covers: 'src/domain/testLimits.ts#checkTestLimits',
      given: 'a 20 mm gauge length and a test that extends the sample 90 mm, on a machine with Position Max 100 mm',
      expect: { 'position-max': 'the gantry reaching 110 mm is reported against Position Max' },
    },
    () => {
      const big = { ...sample, maxDisplacement: 200 };
      const issues = checkTestLimits({ ...profile([linear(90, 2)]), sampleProfile: big }, ctx);
      expect(issues.find((i) => i.id === 'machine-position-max')?.message).toContain('110 mm');
    },
  );

  behaviour(
    {
      id: 'test-limits.waveform-acceleration',
      covers: 'src/domain/testLimits.ts#checkTestLimits',
      given: 'a 1 mm sine waveform at 2 Hz on a machine whose Acceleration Max is 50 mm/s²',
      expect: { 'acceleration': 'the waveform\'s peak acceleration, about 158 mm/s², is reported against the machine limit' },
      why: { 'acceleration': 'a sine of amplitude A at frequency f peaks at (2πf)²A' },
    },
    () => {
      const wave: Move = {
        moveType: 'math',
        moveParameters: { position: 0, velocity: 0, time: 0, waveform: 'sine', amplitude: 1, frequency: 2 },
      };
      const issues = checkTestLimits(profile([wave]), { ...ctx, machine: { ...machine, 'Velocity Max (mm/s)': 100 } });
      expect(issues.find((i) => i.id === 'machine-acceleration')?.message).toContain('157.91 mm/s²');
    },
  );

  behaviour(
    {
      id: 'test-limits.sample-force-above-machine',
      covers: 'src/domain/testLimits.ts#checkTestLimits',
      given: 'a sample profile that allows more force than the machine\'s Tensile Force Max',
      expect: { 'force': 'the machine force limit is reported' },
    },
    () => {
      const strong = { ...sample, maxForce: 2000 };
      expect(checkTestLimits({ ...profile([linear(1, 1)]), sampleProfile: strong }, ctx).map((i) => i.id)).toContain(
        'sample-force-above-machine',
      );
    },
  );

  behaviour(
    {
      id: 'test-limits.restricted-now',
      covers: 'src/domain/testLimits.ts#checkTestLimits',
      given: 'a machine that is restricted right now to 1 mm/s, and a test moving at 2 mm/s',
      expect: { 'restricted': 'the current restriction is reported' },
    },
    () => {
      expect(ids(profile([linear(5, 2)]), { ...ctx, restrictedVelocityMmS: 1 })).toContain('restricted-velocity');
    },
  );

  behaviour(
    {
      id: 'test-limits.offline',
      covers: 'src/domain/testLimits.ts#checkTestLimits',
      given: 'no machine configuration (not connected) and a test that breaks only machine limits',
      expect: { 'sample-only': 'nothing is reported, because only the sample limits can be checked' },
    },
    () => {
      expect(ids(profile([linear(10, 8)]), { ...ctx, machine: null, gaugeLengthMm: null })).toEqual([]);
    },
  );

  behaviour(
    {
      id: 'test-limits.short-fast-move',
      covers: 'src/domain/testLimits.ts#checkTestLimits',
      given: 'a 25 mm move at 50 mm/s on a machine allowed 100 mm/s and 50 mm/s²',
      expect: {
        'needs-accel': 'the warning reads: motion profile acceleration of 100 mm/s² exceeds machine limit of 50 mm/s²',
      },
      why: { 'needs-accel': 'the move has to speed up and brake to a stop within its own length' },
    },
    () => {
      const fast = { ...machine, 'Velocity Max (mm/s)': 100 };
      const big = { ...sample, maxVelocity: 100, maxDisplacement: 200 };
      const issues = checkTestLimits({ ...profile([linear(25, 50)]), sampleProfile: big }, { ...ctx, machine: fast });
      expect(issues.find((i) => i.id === 'machine-acceleration')?.message).toBe(
        'Motion profile acceleration of 100 mm/s² exceeds machine limit of 50 mm/s².',
      );
    },
  );


});
