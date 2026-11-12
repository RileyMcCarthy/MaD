import { describe, expect } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { RUN_UNSEEN_GRACE_MS, stepRunTrack, staleRunningRuns, type RunTrack } from './runTracking';

const idle = { testRunning: false };
const running = { testRunning: true };
const starting: RunTrack = { testName: '000007', sawRunning: false, startedAtMs: null };
const accepted: RunTrack = { ...starting, startedAtMs: 1000 };

describe('test run tracking', () => {
  behaviour(
    {
      id: 'run-tracking.idle-while-uploading',
      covers: 'src/domain/runTracking.ts#stepRunTrack',
      given: 'a run whose program is still being sent, with the machine idle',
      expect: { 'still-waiting': 'the run is not treated as finished' },
      why: { 'still-waiting': 'the machine stays idle until the whole program has arrived and the test starts' },
    },
    () => {
      const step = stepRunTrack(starting, idle, 60_000);
      expect(step.finished).toBeUndefined();
      expect(step.track).toEqual(starting);
    },
  );

  behaviour(
    {
      id: 'run-tracking.running-then-idle',
      covers: 'src/domain/runTracking.ts#stepRunTrack',
      given: 'an accepted run that the machine reports running and then idle',
      expect: { 'finished': 'the run is finished at the first idle report after running' },
    },
    () => {
      const seen = stepRunTrack(accepted, running, 1200);
      expect(seen.finished).toBeUndefined();
      const done = stepRunTrack(seen.track, idle, 1400);
      expect(done.finished).toBe('000007');
      expect(done.track).toBeNull();
    },
  );

  behaviour(
    {
      id: 'run-tracking.too-short-to-see',
      covers: 'src/domain/runTracking.ts#stepRunTrack',
      given: 'an accepted run the machine never reports running, because it ended between two state reports',
      expect: {
        'waits-grace': 'the run is not finished while the machine has been idle for less than the grace period since the start was accepted',
        'finishes-after-grace': 'once the grace period has passed with the machine idle, the run is finished',
      },
      why: { 'finishes-after-grace': 'machine state is reported about once a second, so a short test can start and end unseen' },
    },
    () => {
      expect(stepRunTrack(accepted, idle, 1000 + RUN_UNSEEN_GRACE_MS - 1).finished).toBeUndefined();
      expect(stepRunTrack(accepted, idle, 1000 + RUN_UNSEEN_GRACE_MS).finished).toBe('000007');
    },
  );

  behaviour(
    {
      id: 'run-tracking.unknown-state',
      covers: 'src/domain/runTracking.ts#stepRunTrack',
      given: 'a run that was seen running, while the machine state is unknown (the link dropped)',
      expect: { 'kept': 'the run stays tracked and is not finished' },
      why: { 'kept': 'the machine keeps running the test from its SD card while the app is disconnected' },
    },
    () => {
      const seen: RunTrack = { ...accepted, sawRunning: true };
      const step = stepRunTrack(seen, null, 99_000);
      expect(step.finished).toBeUndefined();
      expect(step.track).toEqual(seen);
    },
  );

  behaviour(
    {
      id: 'run-tracking.stale-runs',
      covers: 'src/domain/runTracking.ts#staleRunningRuns',
      given: 'run records still marked running, with the machine idle',
      expect: {
        'untracked-stale': 'every running record the app is not tracking is reported as over',
        'tracked-kept': 'the run the app is tracking is left alone',
        'others-ignored': 'records in any other status are left alone',
      },
    },
    () => {
      const runs = [
        { testName: '000001', status: 'running' },
        { testName: '000002', status: 'completed' },
        { testName: '000003', status: 'running' },
      ];
      const stale = staleRunningRuns(runs, idle, '000003');
      expect(stale).toContain('000001');
      expect(stale).not.toContain('000003');
      expect(stale).not.toContain('000002');
    },
  );

  behaviour(
    {
      id: 'run-tracking.stale-needs-idle',
      covers: 'src/domain/runTracking.ts#staleRunningRuns',
      given: 'a record marked running while the machine is running a test or its state is unknown',
      expect: { 'none-stale': 'no record is reported as over' },
    },
    () => {
      const runs = [{ testName: '000001', status: 'running' }];
      expect(staleRunningRuns(runs, running, null)).toEqual([]);
      expect(staleRunningRuns(runs, null, null)).toEqual([]);
    },
  );
});
