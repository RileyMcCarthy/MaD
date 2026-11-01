import type { SampleProfile } from '@/domain';
import type { RunTestParams } from '@/device/events';
import type { DeviceClient } from '@/device/session';
import type { DataStore } from '@/storage/DataStore';

/** The device calls that start a test (a fake stands in for it in tests). */
export type TestStartDevice = Pick<DeviceClient, 'setMotionEnabled' | 'writeSampleProfile' | 'runTest'>;

export type StartTestResult = { ok: true } | { ok: false; error: string };

/** What the operator sees when the firmware did not take the sample profile. */
export const SAMPLE_PROFILE_WRITE_FAILED =
  "The sample profile couldn't be written to the machine, so the test was not started.";

/**
 * The device steps of starting the already-created run `runArgs.testDataId`:
 * enable motion, send the selected sample profile (its force / displacement /
 * velocity limits), then upload and start the G-code.
 *
 * The sample profile write is the only thing that sends those limits to the
 * firmware, so when it is refused (`false`) or throws, the test is NOT started:
 * it would otherwise run with the previous profile's limits still active.
 *
 * When the write fails or the firmware rejects the test, the run's record is
 * marked `error` and `{ ok: false, error }` comes back with the message for the
 * operator; the caller does the rest of its failed-start cleanup. Resolves
 * `{ ok: true }` once the test started. A thrown `setMotionEnabled` / `runTest`
 * still propagates to the caller, as before.
 */
export async function startTestOnDevice(
  device: TestStartDevice,
  store: Pick<DataStore, 'updateTestRun'>,
  sample: SampleProfile,
  runArgs: RunTestParams,
): Promise<StartTestResult> {
  const fail = async (error: string): Promise<StartTestResult> => {
    await store.updateTestRun(runArgs.testDataId, { status: 'error' });
    return { ok: false, error };
  };

  // Motion is gated by the firmware state machine: a test won't move the
  // gantry unless motion is enabled first. (It is enabled as a separate
  // dashboard step before Run test.)
  await device.setMotionEnabled(true);

  let written: boolean;
  try {
    written = await device.writeSampleProfile(sample);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return fail(`${SAMPLE_PROFILE_WRITE_FAILED} (${why})`);
  }
  if (!written) return fail(SAMPLE_PROFILE_WRITE_FAILED);

  const result = await device.runTest(runArgs);
  if (!result.success) return fail(`Test failed: ${result.error ?? 'unknown'}`);
  return { ok: true };
}
