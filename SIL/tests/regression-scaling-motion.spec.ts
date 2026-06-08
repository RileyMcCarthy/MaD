/**
 * Regression: sample scaling and motion precision (consolidated)
 *
 * One test that runs the simple profile + the fractional profile back-to-back
 * and asserts:
 *   - units stay in the same scale (no 1000× mismatch)
 *   - actual position retains sub-mm resolution in the downloaded CSV
 *   - trajectory reaches commanded targets and returns near zero
 *   - setpoint reaches commanded endpoint and force keeps mN precision
 *   - fractional commanded endpoint survives wire/decode at 0.001mm precision
 */

import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

type CsvSample = {
  time_us: number;
  force_mN: number;
  position_um: number;
  setpoint_um: number;
};

type CapturedRun = { data: CsvSample[]; gcode: string[] };

const FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures');
const SAMPLE_PROFILE_PATH = path.join(FIXTURES_DIR, 'sample-profile-regression.sp');
const MOTION_PROFILE_SIMPLE_PATH = path.join(FIXTURES_DIR, 'motion-profile-simple.mp');
const MOTION_PROFILE_FRACTIONAL_PATH = path.join(FIXTURES_DIR, 'motion-profile-fractional.mp');

function parseCSV(csv: string): CsvSample[] {
  const lines = csv.split('\n').filter((line) => line.trim() !== '');
  return lines.slice(1).map((line) => {
    const [time_us, force_mN, position_um, setpoint_um] = line.split(',').map(Number);
    return { time_us, force_mN, position_um, setpoint_um };
  });
}

async function ensureMotionEnabled(window: Page): Promise<void> {
  await window.getByRole('link', { name: 'Dashboard' }).click();
  await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

  const enabled = await window.evaluate(async () =>
    (globalThis as any).electron.ipcRenderer.invoke('set-motion-enabled', true),
  );
  expect(Boolean(enabled)).toBe(true);
  await window.waitForTimeout(500);
}

async function ensureSafeMachineLimits(window: Page): Promise<void> {
  const config = await window.evaluate(async () =>
    (globalThis as any).electron.ipcRenderer.invoke('get-machine-configuration'),
  );
  if (!config || typeof config !== 'object') return;

  const safeConfig = {
    ...(config as Record<string, unknown>),
    'Tensile Force Max (N)': 50,
    'Position Max (mm)': 300,
    'Velocity Max (mm/s)': 100,
  };

  await window.evaluate(
    async ({ cfg }: { cfg: Record<string, unknown> }) =>
      (globalThis as any).electron.ipcRenderer.invoke('save-machine-configuration', cfg),
    { cfg: safeConfig },
  );
  await window.waitForTimeout(300);
}

async function runProfileAndDownloadCsv(
  window: Page,
  motionProfilePath: string,
): Promise<CapturedRun> {
  const existingRunIds: string[] = await window.evaluate(async () => {
    const resp = await (globalThis as any).electron.ipcRenderer.invoke('data-get-test-runs');
    const runs = (resp as any)?.runs ?? (Array.isArray(resp) ? resp : []);
    return (runs as any[]).map((run) => run.id);
  });

  await window.getByRole('button', { name: 'Run Test' }).click();
  await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

  const spInput = window.locator('input[type="file"][accept=".sp"]').first();
  await spInput.setInputFiles(SAMPLE_PROFILE_PATH);
  await window.waitForTimeout(800);

  const mpInput = window.locator('input[type="file"][accept=".mp"]').last();
  await mpInput.setInputFiles(motionProfilePath);
  await window.waitForTimeout(500);

  const dialogRunButton = window.getByRole('button', { name: 'Run Test' }).last();
  await expect(dialogRunButton).toBeEnabled();
  await dialogRunButton.click();

  await window.waitForTimeout(1500);

  const newTestRun = await window.evaluate(
    async ({ existingIds }: { existingIds: string[] }) => {
      const resp = await (globalThis as any).electron.ipcRenderer.invoke('data-get-test-runs');
      const runs = (resp as any)?.runs ?? (Array.isArray(resp) ? resp : []);
      const created = (runs as any[])
        .filter((run) => !existingIds.includes(run.id))
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
      return created[0] ?? null;
    },
    { existingIds: existingRunIds },
  );
  expect(newTestRun).toBeTruthy();

  const runId = (newTestRun as any).id as string;
  let testName = (newTestRun as any).testName as string;
  let runGcode = Array.isArray((newTestRun as any).gcode)
    ? ((newTestRun as any).gcode as string[])
    : [];

  // Wait for the run lifecycle to finish before attempting file download.
  let completed = false;
  let sawRunning = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    const status = await window.evaluate(
      async ({ id }: { id: string }) => {
        const run = await (globalThis as any).electron.ipcRenderer.invoke(
          'data-get-test-run',
          id,
        );
        return (run as { status?: string } | null)?.status;
      },
      { id: runId },
    );

    const runningVisible = await window
      .getByRole('button', { name: 'Test Running...' })
      .isVisible()
      .catch(() => false);
    if (runningVisible) sawRunning = true;

    const idleRunButtonVisible = await window
      .getByRole('button', { name: 'Run Test' })
      .first()
      .isVisible()
      .catch(() => false);

    if (
      status === 'completed' ||
      status === 'downloaded' ||
      (sawRunning && !runningVisible && idleRunButtonVisible)
    ) {
      completed = true;
      break;
    }
    await window.waitForTimeout(1000);
  }
  if (!completed) {
    await window.waitForTimeout(2000);
  }

  /* List snapshot may omit `gcode` / `testName`; refresh from single-run record. */
  const fullRun = await window.evaluate(
    async ({ id }: { id: string }) =>
      (globalThis as any).electron.ipcRenderer.invoke('data-get-test-run', id),
    { id: runId },
  );
  if (fullRun && typeof fullRun === 'object') {
    const fr = fullRun as Record<string, unknown>;
    if (typeof fr.testName === 'string' && fr.testName.length > 0) testName = fr.testName;
    if (Array.isArray(fr.gcode) && fr.gcode.length > 0) runGcode = fr.gcode as string[];
  }

  const savePath = path.join(os.tmpdir(), `mad-regression-${testName}-${Date.now()}.csv`);
  let data: CsvSample[] = [];
  let downloadOk = false;

  for (let attempt = 0; attempt < 4; attempt++) {
    const result = (await window.evaluate(
      async ({ name, dest }: { name: string; dest: string }) =>
        (globalThis as any).electron.ipcRenderer.invoke('download-test-file', {
          testName: name,
          savePath: dest,
        }),
      { name: testName, dest: savePath },
    )) as { success: boolean; error?: string };

    if (result.success && fs.existsSync(savePath)) {
      const csvContent = fs.readFileSync(savePath, 'utf-8');
      data = parseCSV(csvContent);
      if (data.length > 20) {
        downloadOk = true;
        break;
      }
    }

    const err = String(result.error ?? '');
    if (err.includes('not ready')) {
      await window.waitForTimeout(500);
      continue;
    }
    throw new Error(`download-test-file failed: ${err || 'unknown error'}`);
  }
  expect(downloadOk).toBe(true);

  return { data, gcode: runGcode };
}

function getExpectedSetpointExtremaUm(gcode: string[]): { maxAbsUm: number; finalUm: number } {
  let mode: 'absolute' | 'relative' = 'absolute';
  let setpointMm = 0;
  let maxAbsMm = 0;

  gcode.forEach((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith(';')) return;

    const tokens = line.split(/\s+/);
    let g: number | null = null;
    let x: number | null = null;

    tokens.forEach((token) => {
      const code = token[0]?.toUpperCase();
      const value = Number.parseFloat(token.slice(1));
      if (!Number.isFinite(value)) return;
      if (code === 'G') g = Math.round(value);
      if (code === 'X') x = value;
    });

    if (g === 90) { mode = 'absolute'; return; }
    if (g === 91) { mode = 'relative'; return; }
    if ((g === 0 || g === 1) && x !== null) {
      setpointMm = mode === 'absolute' ? x : (setpointMm + x);
      maxAbsMm = Math.max(maxAbsMm, Math.abs(setpointMm));
    }
  });

  return {
    maxAbsUm: Math.round(maxAbsMm * 1000),
    finalUm: Math.round(setpointMm * 1000),
  };
}

test.describe('Regression: sample scaling + motion precision', () => {
  test('simple + fractional profiles: scale, sub-mm resolution, trajectory, fractional precision', async ({
    window,
    connectToEmulator,
  }) => {
    await connectToEmulator();
    await ensureMotionEnabled(window);
    await ensureSafeMachineLimits(window);

    // ─── Run 1: simple profile ─────────────────────────────────────────
    const simpleRun = await runProfileAndDownloadCsv(window, MOTION_PROFILE_SIMPLE_PATH);
    const simple = simpleRun.data;
    const simpleExpected = getExpectedSetpointExtremaUm(simpleRun.gcode);

    // ── A. Units stay in same scale (no 1000× mismatch) ────────────────
    const maxActualPosition = Math.max(...simple.map((s) => Math.abs(s.position_um)));
    const maxSetpointPosition = Math.max(...simple.map((s) => Math.abs(s.setpoint_um)));

    expect(maxSetpointPosition).toBeGreaterThan(0);
    expect(maxSetpointPosition).toBeLessThan(200_000);
    expect(Math.abs(maxSetpointPosition - simpleExpected.maxAbsUm)).toBeLessThanOrEqual(1200);

    expect(maxActualPosition).toBeGreaterThan(0);
    expect(maxActualPosition).toBeLessThan(200_000);

    const magnitudeRatio = maxActualPosition / Math.max(1, maxSetpointPosition);
    expect(magnitudeRatio).toBeGreaterThan(0.05);
    expect(magnitudeRatio).toBeLessThan(2.0);

    // ── B. Actual position retains sub-mm resolution ───────────────────
    const nonIntegerMillimeterSamples = simple.filter(
      (s) => Math.abs(s.position_um % 1000) > 0,
    );
    expect(nonIntegerMillimeterSamples.length).toBeGreaterThan(0);

    // ── C. Trajectory reaches commanded targets and returns near zero ──
    const positions = simple.map((s) => s.position_um);
    const reachedMeaningfulMotion = positions.some(
      (p) => Math.abs(p) >= Math.max(500, Math.round(simpleExpected.maxAbsUm * 0.1)),
    );
    const reachedFinalNeighborhoodPos = positions.some(
      (p) => Math.abs(p - simpleExpected.finalUm) <= 3000,
    );
    expect(reachedMeaningfulMotion).toBe(true);
    expect(reachedFinalNeighborhoodPos).toBe(true);

    const finalPosition = positions[positions.length - 1];
    expect(Math.abs(finalPosition - simpleExpected.finalUm)).toBeLessThanOrEqual(8000);

    // ── D. Setpoint reaches commanded endpoint + force has mN precision ─
    const setpoints = simple.map((s) => s.setpoint_um);
    const reachedExpectedPeakSetpoint = setpoints.some(
      (sp) => Math.abs(Math.abs(sp) - simpleExpected.maxAbsUm) <= 1200,
    );
    const reachedFinalNeighborhoodSet = setpoints.some(
      (sp) => Math.abs(sp - simpleExpected.finalUm) <= 8000,
    );
    expect(reachedExpectedPeakSetpoint).toBe(true);
    expect(reachedFinalNeighborhoodSet).toBe(true);

    const allForcesAreIntegers = simple.every((s) => Number.isInteger(s.force_mN));
    expect(allForcesAreIntegers).toBe(true);
    const noDoubleScaling = simple.every((s) => Math.abs(s.force_mN) < 100_000);
    expect(noDoubleScaling).toBe(true);

    // ─── Run 2: fractional profile (0.001 mm precision) ────────────────
    const fractRun = await runProfileAndDownloadCsv(
      window,
      MOTION_PROFILE_FRACTIONAL_PATH,
    );
    const fract = fractRun.data;
    const fractSetpoints = fract.map((s) => s.setpoint_um);

    // CSV setpoint is sample-frame (machine setpoint minus gauge offset),
    // so absolute values can shift; the span should still reflect the 2.5 mm move.
    const initialSetpointUm = fractSetpoints[0];
    const maxDeviationFromInitialUm = Math.max(
      ...fractSetpoints.map((v) => Math.abs(v - initialSetpointUm)),
    );
    expect(Math.abs(maxDeviationFromInitialUm - 2500)).toBeLessThanOrEqual(2);

    // Ensure fractional resolution survives (not collapsed to whole-mm steps).
    const hasSubMillimeterSetpoint = fractSetpoints.some(
      (v) => Math.abs(v % 1000) > 0,
    );
    expect(hasSubMillimeterSetpoint).toBe(true);
  });
});
