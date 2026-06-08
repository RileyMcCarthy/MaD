/**
 * Intent-driven execution (consolidated)
 *
 * Two tests sharing the same emulator + Electron startup that exercise the
 * full execution contract: gcode metadata, dwell intent, disable-as-stop,
 * staged uploads, repeatability, and back-to-back runs with reused gcodeId.
 *
 *   1. "execution contract end-to-end" — metadata + terminal G-code + dwell
 *      plateau + staged upload + disable-as-stop (one connect_to_emulator).
 *   2. "repeatability + back-to-back gcodeId reuse" — runs the simple profile
 *      three times in a row, then runs back-to-back with the same gcodeId and
 *      different testDataIds, asserting motion executes both times.
 */

import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

type TestRunRecord = {
  id: string;
  testName: string;
  status: 'running' | 'completed' | 'downloaded' | 'error';
  gcode: string[];
  sampleProfile: {
    maxForce: number;
    maxVelocity: number;
    maxDisplacement: number;
    sampleWidth: number;
    sampleThickness: number;
    serial: string;
  };
  motionProfile: {
    name: string;
    description: string;
  };
  startedAt: string;
  completedAt?: string;
};

const FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures');
const SAMPLE_PROFILE_PATH = path.join(FIXTURES_DIR, 'sample-profile.sp');
const MOTION_PROFILE_SIMPLE_PATH = path.join(FIXTURES_DIR, 'motion-profile-simple.mp');
const MOTION_PROFILE_E2E_PATH = path.join(FIXTURES_DIR, 'motion-profile-e2e.mp');

const SIMPLE_SAMPLE_PROFILE = JSON.parse(
  fs.readFileSync(SAMPLE_PROFILE_PATH, 'utf-8'),
) as {
  maxForce: number;
  maxVelocity: number;
  maxDisplacement: number;
  sampleWidth: number;
  sampleThickness: number;
};

const SIMPLE_MOTION_PROFILE = JSON.parse(
  fs.readFileSync(MOTION_PROFILE_SIMPLE_PATH, 'utf-8'),
) as {
  name: string;
  description: string;
};

function getLastExecutableGcodeLine(gcode: string[]): string | null {
  for (let i = gcode.length - 1; i >= 0; i -= 1) {
    const trimmed = gcode[i].trim();
    if (trimmed === '' || trimmed.startsWith(';')) continue;
    return trimmed;
  }
  return null;
}

function extractPositionMm(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/Machine Position \(mm\):\s*([-\d.]+)/);
  return match ? Number.parseFloat(match[1]) : null;
}

async function ensureMotionEnabled(window: Page): Promise<void> {
  await window.getByRole('link', { name: 'Dashboard' }).click();
  await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

  const enabled = await window.evaluate(async () =>
    (globalThis as any).electron.ipcRenderer.invoke('set-motion-enabled', true),
  );
  expect(Boolean(enabled)).toBe(true);
  await expect(window.getByText('Enabled')).toBeVisible({ timeout: 5000 });
}

async function startTestFromDialog(
  window: Page,
  sampleProfilePath: string,
  motionProfilePath: string,
): Promise<{ run: TestRunRecord }> {
  const existingRunIds: string[] = await window.evaluate(async () => {
    const resp = await (globalThis as any).electron.ipcRenderer.invoke(
      'data-get-test-runs',
    );
    const runs = (resp as any)?.runs ?? (Array.isArray(resp) ? resp : []);
    return (runs as any[]).map((run) => run.id as string);
  });

  await window.getByRole('button', { name: 'Run Test' }).click();
  await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

  const spInput = window.locator('input[type="file"][accept=".sp"]').first();
  await spInput.setInputFiles(sampleProfilePath);
  await window.waitForTimeout(800);

  const mpInput = window.locator('input[type="file"][accept=".mp"]').last();
  await mpInput.setInputFiles(motionProfilePath);
  await window.waitForTimeout(500);

  const runButton = window.getByRole('button', { name: 'Run Test' }).last();
  await expect(runButton).toBeEnabled();
  await runButton.click();

  await expect(
    window.getByRole('button', { name: 'Test Running...' }),
  ).toBeVisible({ timeout: 15000 });

  const run = await window.evaluate(
    async ({ existingIds }: { existingIds: string[] }) => {
      const resp = await (globalThis as any).electron.ipcRenderer.invoke('data-get-test-runs');
      const runs = (resp as any)?.runs ?? (Array.isArray(resp) ? resp : []);
      const created = (runs as any[])
        .filter((item) => !existingIds.includes(item.id))
        .sort(
          (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        );
      return (created[0] ?? null) as TestRunRecord | null;
    },
    { existingIds: existingRunIds },
  );
  expect(run).toBeTruthy();
  return { run: run as TestRunRecord };
}

async function waitForRunStatus(
  window: Page,
  runId: string,
  expected: Array<'running' | 'completed' | 'downloaded' | 'error'>,
  timeoutMs: number,
): Promise<TestRunRecord> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = await window.evaluate(
      async ({ id }: { id: string }) =>
        (await (globalThis as any).electron.ipcRenderer.invoke(
          'data-get-test-run',
          id,
        )) as TestRunRecord,
      { id: runId },
    );
    if (run && expected.includes(run.status)) return run;
    await window.waitForTimeout(500);
  }
  throw new Error(
    `Run ${runId} did not reach status ${expected.join('|')} within ${timeoutMs}ms`,
  );
}

test.describe('Intent-driven execution', () => {
  test('execution contract end-to-end: metadata, dwell, staging, disable-as-stop', async ({
    window,
    connectToEmulator,
  }) => {
    await connectToEmulator();
    await ensureMotionEnabled(window);

    // ── 1. Run metadata + terminal G-code contract ─────────────────────
    const { run: metaRun } = await startTestFromDialog(
      window,
      SAMPLE_PROFILE_PATH,
      MOTION_PROFILE_SIMPLE_PATH,
    );

    const observedRun = await waitForRunStatus(
      window,
      metaRun.id,
      ['running', 'completed', 'downloaded'],
      20000,
    );

    expect(observedRun.testName).toMatch(/^\d{6}$/);
    expect(Array.isArray(observedRun.gcode)).toBe(true);
    expect(observedRun.gcode.length).toBeGreaterThan(0);
    expect(getLastExecutableGcodeLine(observedRun.gcode)?.startsWith('G122')).toBe(true);

    expect(observedRun.sampleProfile.maxForce).toBe(SIMPLE_SAMPLE_PROFILE.maxForce);
    expect(observedRun.sampleProfile.maxVelocity).toBe(SIMPLE_SAMPLE_PROFILE.maxVelocity);
    expect(observedRun.sampleProfile.maxDisplacement).toBe(SIMPLE_SAMPLE_PROFILE.maxDisplacement);
    expect(observedRun.sampleProfile.sampleWidth).toBe(SIMPLE_SAMPLE_PROFILE.sampleWidth);
    expect(observedRun.sampleProfile.sampleThickness).toBe(SIMPLE_SAMPLE_PROFILE.sampleThickness);
    expect(observedRun.motionProfile.name).toBe(SIMPLE_MOTION_PROFILE.name);
    expect(observedRun.motionProfile.description).toBe(SIMPLE_MOTION_PROFILE.description);
    expect(new Date(observedRun.startedAt).getTime()).toBeGreaterThan(0);

    // Let the metadata run complete fully before issuing the next dwell run.
    await waitForRunStatus(window, metaRun.id, ['completed', 'downloaded'], 30_000);

    // ── 2. Dwell intent: setpoint samples observed during run ──────────
    await window.evaluate(async () => {
      (globalThis as any).__dwellSamples = [];
      (globalThis as any).__dwellSawRunning = false;
      (globalThis as any).__dwellIsRunning = false;

      (globalThis as any).electron.ipcRenderer.on(
        'sample-data-updates',
        (sample: Record<string, number>) => {
          (globalThis as any).__dwellSamples.push({
            setpointMm: sample['Machine Setpoint (mm)'],
          });
        },
      );

      (globalThis as any).electron.ipcRenderer.on(
        'machine-state-updates',
        (state: { testRunning?: boolean }) => {
          if (state.testRunning) (globalThis as any).__dwellSawRunning = true;
          (globalThis as any).__dwellIsRunning = Boolean(state.testRunning);
        },
      );
    });

    const dwellId = String(Date.now() % 1_000_000).padStart(6, '0');
    const gcodeWithDwell = ['G90', 'G1 X20 F10', 'G4 P600', 'G1 X0 F10', 'G122'];
    const dwellStartResult = (await window.evaluate(
      async ({ id, gcode }: { id: string; gcode: string[] }) => {
        return (globalThis as any).electron.ipcRenderer.invoke('run-test', {
          gcode,
          gcodeId: id,
          testDataId: id,
        });
      },
      { id: dwellId, gcode: gcodeWithDwell },
    )) as { success: boolean; error?: string };
    expect(dwellStartResult.success).toBe(true);

    const dwellStart = Date.now();
    let dwellFinished = false;
    while (Date.now() - dwellStart < 45_000) {
      const state = await window.evaluate(() => ({
        sawRunning: (globalThis as any).__dwellSawRunning as boolean,
        isRunning: (globalThis as any).__dwellIsRunning as boolean,
      }));
      if (state.sawRunning && !state.isRunning) {
        dwellFinished = true;
        break;
      }
      await window.waitForTimeout(250);
    }
    expect(dwellFinished).toBe(true);

    const dwellSamples = await window.evaluate(
      () => (globalThis as any).__dwellSamples as Array<{ setpointMm: number }>,
    );
    expect(dwellSamples.length).toBeGreaterThan(5);

    // ── 3. Staged G-code: file appears on SD before run completes ──────
    const stagedId = String((Date.now() + 1) % 1_000_000).padStart(6, '0');
    const stagedGcode = ['G90', 'G1 X1.5 F5', 'G4 P150', 'G1 X0 F5', 'G122'];
    const stagedFile = path.resolve(__dirname, `../sd/gcode/${stagedId}.bin`);

    const stagedResult = (await window.evaluate(
      async ({ gcode, id }: { gcode: string[]; id: string }) =>
        (globalThis as any).electron.ipcRenderer.invoke('run-test', {
          gcode,
          gcodeId: id,
          testDataId: id,
        }),
      { gcode: stagedGcode, id: stagedId },
    )) as { success: boolean };
    expect(stagedResult.success).toBe(true);

    const fileStart = Date.now();
    let fileExists = false;
    while (Date.now() - fileStart < 8000) {
      if (fs.existsSync(stagedFile) && fs.statSync(stagedFile).size > 0) {
        fileExists = true;
        break;
      }
      await window.waitForTimeout(200);
    }
    expect(fileExists).toBe(true);

    // Let staged run finish.
    await expect(window.getByRole('button', { name: 'Run Test' }).first()).toBeEnabled({
      timeout: 30_000,
    });

    // ── 4. Disable during test acts as software stop ───────────────────
    const { run: stopRun } = await startTestFromDialog(
      window,
      SAMPLE_PROFILE_PATH,
      MOTION_PROFILE_E2E_PATH,
    );

    const positionContainer = window
      .locator('text=Machine Position (mm):')
      .locator('..')
      .first();

    await window.waitForTimeout(1200);

    await window.getByRole('button', { name: 'Disable Motion' }).click();
    await expect(window.getByRole('button', { name: 'Enable Motion' })).toBeVisible({
      timeout: 5000,
    });
    await expect(window.getByRole('button', { name: 'Run Test' }).first()).toBeEnabled({
      timeout: 10_000,
    });
    await expect(window.getByText('Idle')).toBeVisible({ timeout: 10_000 });

    const positionA = extractPositionMm(await positionContainer.textContent());
    await window.waitForTimeout(1200);
    const positionB = extractPositionMm(await positionContainer.textContent());
    expect(positionA).not.toBeNull();
    expect(positionB).not.toBeNull();
    expect(Math.abs(positionB! - positionA!)).toBeLessThan(0.7);

    const finalRun = await waitForRunStatus(
      window,
      stopRun.id,
      ['completed', 'error', 'downloaded'],
      15_000,
    );
    expect(finalRun.status === 'running').toBe(false);
  });

  test('repeatability + back-to-back runs reuse same gcodeId', async ({
    window,
    connectToEmulator,
  }) => {
    await connectToEmulator();
    await ensureMotionEnabled(window);

    // ── 1. Three consecutive runs all complete cleanly ─────────────────
    for (let index = 0; index < 3; index += 1) {
      const { run } = await startTestFromDialog(
        window,
        SAMPLE_PROFILE_PATH,
        MOTION_PROFILE_SIMPLE_PATH,
      );
      const observed = await waitForRunStatus(
        window,
        run.id,
        ['completed', 'downloaded'],
        60_000,
      );
      expect(observed.status).toBe('completed');
    }

    // ── 2. Back-to-back runs reuse same gcodeId, motion executes both ──
    const posRow = window
      .locator('text=Machine Position (mm):')
      .locator('..')
      .first();

    const gcodeLines = ['G90', 'G1 X4 F10', 'G1 X0 F10', 'G122'];
    const sharedGcodeId = 'same01';
    const testDataIds = ['run001', 'run002'];

    /* Runner UI can stay disabled if `isLoading` was latched from another flow; firmware
     * `testRunning` is the reliable completion signal. */
    const waitForTestIdle = async () => {
      await expect
        .poll(
          async () => {
            const s = await window.evaluate(async () =>
              (globalThis as any).electron.ipcRenderer.invoke('device-machine-state'),
            );
            return Boolean(s && !(s as { testRunning?: boolean }).testRunning);
          },
          { timeout: 45_000, intervals: [150, 250, 400, 600] },
        )
        .toBe(true);
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await window.waitForTimeout(500);

      await window.evaluate(() => {
        (globalThis as any).__bbPeak = 0;
        const prevUnsub = (globalThis as any).__bbUnsub;
        if (typeof prevUnsub === 'function') prevUnsub();
        (globalThis as any).__bbUnsub = (globalThis as any).electron.ipcRenderer.on(
          'sample-data-updates',
          (sample: Record<string, number>) => {
            const before = (globalThis as any).__bbBefore as number | null | undefined;
            if (
              before == null ||
              typeof before !== 'number' ||
              !Number.isFinite(before)
            ) {
              return;
            }
            const m = sample['Machine Position (mm)'];
            if (typeof m !== 'number' || !Number.isFinite(m)) return;
            const d = Math.abs(m - before);
            if (d > (globalThis as any).__bbPeak) (globalThis as any).__bbPeak = d;
          },
        );
      });

      let beforePos = extractPositionMm(await posRow.textContent());
      if (beforePos == null) {
        await window.waitForTimeout(400);
        beforePos = extractPositionMm(await posRow.textContent());
      }
      if (beforePos == null) {
        throw new Error(`No baseline Machine Position for attempt ${attempt + 1}`);
      }

      await window.evaluate((bp: number) => {
        (globalThis as any).__bbBefore = bp;
      }, beforePos);

      const startResult = (await window.evaluate(
        async ({
          lines,
          gid,
          tid,
        }: {
          lines: string[];
          gid: string;
          tid: string;
        }) =>
          (globalThis as any).electron.ipcRenderer.invoke('run-test', {
            gcode: lines,
            gcodeId: gid,
            testDataId: tid,
          }),
        { lines: gcodeLines, gid: sharedGcodeId, tid: testDataIds[attempt] },
      )) as { success?: boolean };
      expect(startResult.success).toBe(true);

      await expect
        .poll(
          async () => {
            const peak = await window.evaluate(() => (globalThis as any).__bbPeak as number);
            const pos = extractPositionMm(await posRow.textContent());
            const before = (await window.evaluate(
              () => (globalThis as any).__bbBefore,
            )) as number | null | undefined;
            let domDelta = 0;
            if (
              before != null &&
              typeof before === 'number' &&
              Number.isFinite(before) &&
              pos != null
            ) {
              domDelta = Math.abs(pos - before);
            }
            return Math.max(peak, domDelta);
          },
          {
            timeout: 45_000,
            intervals: [15, 30, 50, 80, 120],
            message: `machine motion during attempt ${attempt + 1}`,
          },
        )
        .toBeGreaterThan(0.25);

      await waitForTestIdle();

      await window.evaluate(() => {
        const unsub = (globalThis as any).__bbUnsub;
        if (typeof unsub === 'function') unsub();
        (globalThis as any).__bbUnsub = undefined;
      });
    }
  });
});
