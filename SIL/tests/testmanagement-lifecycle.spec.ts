/**
 * Test-management lifecycle & busy-gating regressions
 *
 * Guards the `app_testManagement` state machine (IDLE → STARTING → RUNNING →
 * ENDING → IDLE) and the `isBusy` contract hardened in firmware commit
 * c081e6c8 ("fix isBusy race and test_run self-cancel"). `isBusy` is true while
 * the state is non-IDLE *or* a start/end request is still pending, so the
 * machine must recycle cleanly after a mid-flight abort and must reject manual
 * moves for the entire duration of a test.
 *
 * These two cases are NOT covered by intent-driven-execution.spec.ts, which
 * exercises disable-as-stop (without a restart) and back-to-back runs (each
 * allowed to complete). Here we specifically:
 *
 *   1. Cancel a test MID-FLIGHT (disable motion while RUNNING) and then start a
 *      fresh test immediately — proving the busy bit clears and the state
 *      machine returns to IDLE rather than wedging. A regression that left the
 *      machine busy would make the restart never reach RUNNING.
 *   2. Confirm manual moves are NACKed by the firmware for a test's whole
 *      lifetime (app_testManagement_addManualMove → NACK in app_messageSlave),
 *      and accepted again once the machine is back to IDLE.
 *
 * Tests drive the test run partly through the UI (Run Test dialog, so the
 * firmware sample profile / limits are set) and partly through IPC, observing
 * the authoritative `testRunning` flag from `device-machine-state` (the
 * `run-test` handler returns success even on a firmware busy-NACK, so it is not
 * a reliable start signal — `testRunning` is).
 */

import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import path from 'path';

const FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures');
const SAMPLE_PROFILE_PATH = path.join(FIXTURES_DIR, 'sample-profile.sp');
const MOTION_PROFILE_E2E_PATH = path.join(FIXTURES_DIR, 'motion-profile-e2e.mp');

async function ensureMotionEnabled(window: Page): Promise<void> {
  await window.getByRole('link', { name: 'Dashboard' }).click();
  await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

  const enabled = await window.evaluate(async () =>
    (globalThis as any).electron.ipcRenderer.invoke('set-motion-enabled', true),
  );
  expect(Boolean(enabled)).toBe(true);
  await expect(window.getByText('Enabled')).toBeVisible({ timeout: 5000 });
}

async function getTestRunning(window: Page): Promise<boolean> {
  const state = await window.evaluate(async () =>
    (globalThis as any).electron.ipcRenderer.invoke('device-machine-state'),
  );
  return Boolean(state && (state as { testRunning?: boolean }).testRunning);
}

/** Poll the firmware's authoritative testRunning flag until it matches. */
async function waitForTestRunning(
  window: Page,
  expected: boolean,
  timeoutMs: number,
): Promise<void> {
  await expect
    .poll(async () => getTestRunning(window), {
      timeout: timeoutMs,
      intervals: [150, 250, 400, 600],
    })
    .toBe(expected);
}

/** Invoke a manual jog; resolves to the firmware ACK (false on a busy NACK). */
async function manualMove(window: Page, mm: number, speed: number): Promise<boolean> {
  return Boolean(
    await window.evaluate(
      async ({ d, s }: { d: number; s: number }) =>
        (globalThis as any).electron.ipcRenderer.invoke('manual-move', d, s),
      { d: mm, s: speed },
    ),
  );
}

/** Start a test via IPC. Returns the handler's success flag (see file header:
 *  not authoritative for whether the firmware actually started — use
 *  waitForTestRunning for that). */
async function runTestViaIpc(window: Page, gcode: string[], id: string): Promise<boolean> {
  const res = await window.evaluate(
    async ({ g, i }: { g: string[]; i: string }) =>
      (globalThis as any).electron.ipcRenderer.invoke('run-test', {
        gcode: g,
        gcodeId: i,
        testDataId: i,
      }),
    { g: gcode, i: id },
  );
  return Boolean((res as { success?: boolean })?.success);
}

/** Start a test through the Run Test dialog and wait until it is running. This
 *  also loads the sample profile so firmware limits are configured. */
async function startTestViaDialog(
  window: Page,
  sampleProfilePath: string,
  motionProfilePath: string,
): Promise<void> {
  await window.getByRole('button', { name: 'Run Test' }).click();
  await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

  await window
    .locator('input[type="file"][accept=".sp"]')
    .first()
    .setInputFiles(sampleProfilePath);
  await window.waitForTimeout(800);

  await window
    .locator('input[type="file"][accept=".mp"]')
    .last()
    .setInputFiles(motionProfilePath);
  await window.waitForTimeout(500);

  const runButton = window.getByRole('button', { name: 'Run Test' }).last();
  await expect(runButton).toBeEnabled();
  await runButton.click();

  await expect(window.getByRole('button', { name: 'Test Running...' })).toBeVisible({
    timeout: 15000,
  });
}

test.describe('Test-management lifecycle & busy gating', () => {
  test('mid-flight cancel recycles cleanly: a fresh test starts and completes after a disable-stop', async ({
    window,
    connectToEmulator,
  }) => {
    await connectToEmulator();
    await ensureMotionEnabled(window);

    // ── 1. Start a multi-move test and let it reach RUNNING ───────────────
    await startTestViaDialog(window, SAMPLE_PROFILE_PATH, MOTION_PROFILE_E2E_PATH);
    await waitForTestRunning(window, true, 20_000);

    // ── 2. Cancel mid-flight: disabling motion drives RUNNING → ENDING →
    //       IDLE in the firmware. The busy bit must clear.
    await window.getByRole('button', { name: 'Disable Motion' }).click();
    await expect(window.getByRole('button', { name: 'Enable Motion' })).toBeVisible({
      timeout: 10_000,
    });
    await waitForTestRunning(window, false, 15_000);
    await expect(window.getByText('Idle')).toBeVisible({ timeout: 10_000 });

    // ── 3. Re-enable and immediately start a NEW test. The sample profile is
    //       already loaded in firmware from step 1, so the IPC start is valid.
    //       If the abort had left the machine busy, this start would be
    //       rejected and testRunning would never go true again.
    await ensureMotionEnabled(window);
    const restartGcode = ['G90', 'G1 X8 F8', 'G1 X0 F8', 'G122'];
    expect(await runTestViaIpc(window, restartGcode, '772001')).toBe(true);

    // The restarted test must actually run …
    await waitForTestRunning(window, true, 30_000);
    // … and then complete on its own, returning the machine to idle.
    await waitForTestRunning(window, false, 60_000);
    await expect(window.getByText('Idle')).toBeVisible({ timeout: 10_000 });
  });

  test('manual moves are gated while a test is busy and released once idle', async ({
    window,
    connectToEmulator,
  }) => {
    await connectToEmulator();
    await ensureMotionEnabled(window);

    // ── 1. Idle baseline: a manual jog is accepted (ACK). ─────────────────
    expect(await manualMove(window, 0.5, 5)).toBe(true);

    // ── 2. Start a multi-move test and reach RUNNING. ─────────────────────
    await startTestViaDialog(window, SAMPLE_PROFILE_PATH, MOTION_PROFILE_E2E_PATH);
    await waitForTestRunning(window, true, 20_000);

    // ── 3. While the test is running the firmware NACKs manual moves
    //       (addManualMove rejects when isBusy → NACK in app_messageSlave),
    //       so the IPC resolves to false. The E2E profile runs for several
    //       seconds, so the move lands squarely inside the run window.
    expect(await getTestRunning(window)).toBe(true);
    expect(await manualMove(window, 0.5, 5)).toBe(false);

    // ── 4. Let the test finish on its own, then confirm the gate releases. ─
    await waitForTestRunning(window, false, 60_000);
    await expect(window.getByText('Idle')).toBeVisible({ timeout: 10_000 });
    expect(await manualMove(window, -0.5, 5)).toBe(true);
  });
});
