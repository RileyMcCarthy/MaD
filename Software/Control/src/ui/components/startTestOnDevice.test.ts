/**
 * The device steps TestRunner takes to start a test (issue #238): the selected
 * sample profile is the only thing that sends its limits to the firmware, so it
 * must be written before the test starts, and a refused write must stop the
 * start and fail the run.
 */
import { describe, expect, it, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import type { SampleProfile } from '@/domain';
import type { RunTestParams, RunTestResult } from '@/device/events';
import {
  SAMPLE_PROFILE_WRITE_FAILED,
  startTestOnDevice,
  type TestStartDevice,
} from './startTestOnDevice';

const SAMPLE: SampleProfile = {
  maxForce: 500,
  maxVelocity: 10,
  maxDisplacement: 40,
  sampleWidth: 6,
  sampleThickness: 2,
  serial: 'S-238',
};

const RUN_ARGS: RunTestParams = {
  gcode: ['G90', 'G1 X10 F5', 'G122'],
  gcodeId: '000238',
  testDataId: '000238',
  gaugeLengthMm: 25,
};

/** A fake device that logs each call, in order. */
function fakeDevice(write: () => Promise<boolean>, run?: Partial<RunTestResult>) {
  const calls: string[] = [];
  const device = {
    setMotionEnabled: vi.fn(async (_enabled: boolean) => {
      calls.push('setMotionEnabled');
      return true;
    }),
    writeSampleProfile: vi.fn(async (_profile: SampleProfile) => {
      calls.push('writeSampleProfile');
      return write();
    }),
    runTest: vi.fn(async (params: RunTestParams): Promise<RunTestResult> => {
      calls.push('runTest');
      return { success: true, gcodeId: params.gcodeId, testDataId: params.testDataId, ...run };
    }),
  } satisfies TestStartDevice;
  return { device, calls };
}

function fakeStore() {
  return { updateTestRun: vi.fn(async () => true) };
}

describe('startTestOnDevice', () => {
  behaviour(
    {
      id: 'test-runner.sample-profile-written-before-start',
      covers: 'src/ui/components/startTestOnDevice.ts#startTestOnDevice',
      given: 'the operator starts a test with a sample profile selected',
      expect: {
        'selected-profile-sent': 'the selected sample profile is sent to the machine',
        'sent-before-start': 'the sample profile is sent before the test is started',
      },
      why: {
        'sent-before-start':
          "the sample profile carries the force, displacement and speed limits the firmware enforces for the whole test",
      },
    },
    async () => {
      const { device, calls } = fakeDevice(async () => true);
      const store = fakeStore();

      const started = await startTestOnDevice(device, store, SAMPLE, RUN_ARGS);

      expect(started).toEqual({ ok: true });
      expect(device.writeSampleProfile).toHaveBeenCalledWith(SAMPLE);
      expect(device.runTest).toHaveBeenCalledWith(RUN_ARGS);
      expect(calls).toEqual(['setMotionEnabled', 'writeSampleProfile', 'runTest']);
      expect(store.updateTestRun).not.toHaveBeenCalled();
    },
  );

  behaviour(
    {
      id: 'test-runner.refused-sample-profile-stops-start',
      covers: 'src/ui/components/startTestOnDevice.ts#startTestOnDevice',
      given: 'the machine refuses the sample profile when a test is started',
      expect: {
        'test-not-started': 'the test is not started',
        'run-marked-error': 'the run is recorded as an error',
        'operator-told': "the operator is told the sample profile couldn't be written to the machine",
      },
    },
    async () => {
      const { device } = fakeDevice(async () => false);
      const store = fakeStore();

      const started = await startTestOnDevice(device, store, SAMPLE, RUN_ARGS);

      expect(device.runTest).not.toHaveBeenCalled();
      expect(store.updateTestRun).toHaveBeenCalledWith('000238', { status: 'error' });
      expect(started).toEqual({ ok: false, error: SAMPLE_PROFILE_WRITE_FAILED });
    },
  );

  behaviour(
    {
      id: 'test-runner.failed-sample-profile-send-stops-start',
      covers: 'src/ui/components/startTestOnDevice.ts#startTestOnDevice',
      given: 'sending the sample profile to the machine fails with an error when a test is started',
      expect: {
        'test-not-started': 'the test is not started',
        'run-marked-error': 'the run is recorded as an error',
        'operator-told':
          "the operator is told the sample profile couldn't be written to the machine, along with the error",
      },
    },
    async () => {
      const { device } = fakeDevice(async () => {
        throw new Error('Timed out waiting for acknowledgement');
      });
      const store = fakeStore();

      const started = await startTestOnDevice(device, store, SAMPLE, RUN_ARGS);

      expect(device.runTest).not.toHaveBeenCalled();
      expect(store.updateTestRun).toHaveBeenCalledWith('000238', { status: 'error' });
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.error).toContain(SAMPLE_PROFILE_WRITE_FAILED);
      expect(started.error).toContain('Timed out waiting for acknowledgement');
    },
  );

  it('marks the run as an error when the machine rejects the test itself', async () => {
    const { device } = fakeDevice(async () => true, { success: false, error: 'busy' });
    const store = fakeStore();

    const started = await startTestOnDevice(device, store, SAMPLE, RUN_ARGS);

    expect(store.updateTestRun).toHaveBeenCalledWith('000238', { status: 'error' });
    expect(started).toEqual({ ok: false, error: 'Test failed: busy' });
  });
});
