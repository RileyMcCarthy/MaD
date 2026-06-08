/**
 * Session regressions (consolidated)
 *
 * Two tests:
 *   1. UI + sample-frame + viewer baseline — coordinate naming, slack→tension
 *      force model, and TestRunViewer expected-G-code baseline. These all share
 *      a normal emulator (default baud).
 *   2. Baud pacing — runs under MAD_SIM_BAUD=57600 so download takes >1s. Kept
 *      separate because it overrides the emulator fixture options.
 */

import { test, expect } from './fixtures';
import path from 'path';
import fs from 'fs';
import os from 'os';
import type { Locator } from '@playwright/test';

function extractValue(text: string | null, label: string): number | null {
  if (!text) return null;
  const pattern = new RegExp(`${label}:\\s*([-\\d.]+)`);
  const match = text.match(pattern);
  return match ? parseFloat(match[1]) : null;
}

const getSampleForce    = async (c: Locator) => extractValue(await c.textContent(), 'Sample Force \\(N\\)');
const getSamplePosition = async (c: Locator) => extractValue(await c.textContent(), 'Sample Position \\(mm\\)');
const getMachinePosition = async (c: Locator) => extractValue(await c.textContent(), 'Machine Position \\(mm\\)');

const FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures');
const SAMPLE_PROFILE_PATH = path.join(FIXTURES_DIR, 'sample-profile.sp');
const MOTION_PROFILE_E2E_PATH = path.join(FIXTURES_DIR, 'motion-profile-e2e.mp');
const SD_TEST_DIR = path.resolve(__dirname, '../sd/test');

test.describe('Session regressions', () => {
  test('coordinate UI + sample force model + TestRunViewer baseline', async ({
    connectToEmulator,
    window,
  }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

    // ── 1. Coordinate terminology: Machine/Sample, no Global ───────────
    await expect(window.getByText(/Coordinate System:/)).toBeVisible();
    await expect(window.getByRole('button', { name: 'Machine' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Sample' })).toBeVisible();
    await expect(window.getByText(/Global/)).toHaveCount(0);

    await window.getByRole('button', { name: 'Sample' }).click();
    await expect(window.getByText(/Coordinate System:\s*Sample/)).toBeVisible();
    await window.getByRole('button', { name: 'Machine' }).click();
    await expect(window.getByText(/Coordinate System:\s*Machine/)).toBeVisible();

    // ── 2. Sample force model: slack → tension transition ─────────────
    const distanceInput = window.getByLabel('Move Distance (mm)');
    const speedInput = window.getByLabel('Move Speed (mm/s)');

    const ipcEnabled = await window.evaluate(async () =>
      (globalThis as any).electron.ipcRenderer.invoke('set-motion-enabled', true),
    );
    expect(Boolean(ipcEnabled)).toBe(true);
    await expect(window.getByText('Enabled')).toBeVisible({ timeout: 5000 });

    await window.getByRole('button', { name: 'Zero Length' }).click();
    await window.waitForTimeout(500);
    await window.getByRole('button', { name: 'Zero Force' }).click();
    await window.waitForTimeout(500);

    const samplePosContainer = window.locator('text=Sample Position (mm):').locator('..').first();
    const sampleForceContainer = window.locator('text=Sample Force (N):').locator('..').first();
    const machinePosContainer = window.locator('text=Machine Position (mm):').locator('..').first();

    // Move +10mm: within 15mm slack zone → ~0 force
    await distanceInput.fill('10');
    await speedInput.fill('20');
    await window.getByRole('button', { name: 'Move Up' }).click();

    await expect(async () => {
      const sp = (await getSamplePosition(samplePosContainer))!;
      const mp = (await getMachinePosition(machinePosContainer))!;
      const f = (await getSampleForce(sampleForceContainer))!;
      expect(Number.isFinite(sp)).toBe(true);
      expect(Number.isFinite(mp)).toBe(true);
      expect(Number.isFinite(f)).toBe(true);
      expect(sp).toBeGreaterThan(8);
      expect(Math.abs(f)).toBeLessThan(0.15);
    }).toPass({ timeout: 20_000 });

    // Move another +10mm (~20mm total): beyond slack → force > 0
    await distanceInput.fill('10');
    await speedInput.fill('20');
    await window.getByRole('button', { name: 'Move Up' }).click();

    await expect(async () => {
      const sp = (await getSamplePosition(samplePosContainer))!;
      const f = (await getSampleForce(sampleForceContainer))!;
      expect(sp).toBeGreaterThan(18);
      expect(f).toBeGreaterThan(0.1);
    }).toPass({ timeout: 20_000 });

    // ── 3. TestRunViewer expected-G-code baseline ─────────────────────
    // Bring sample back near zero before the lifecycle run so the absolute
    // motion profile (15 mm target) stays in machine bounds.
    await window.getByRole('button', { name: 'Zero Length' }).click();
    await window.waitForTimeout(500);

    const existingFiles = new Set(
      fs.existsSync(SD_TEST_DIR)
        ? fs.readdirSync(SD_TEST_DIR).filter((f) => f.endsWith('.bin'))
        : [],
    );

    await window.getByRole('button', { name: 'Run Test' }).click();
    await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

    await window
      .locator('input[type="file"][accept=".sp"]')
      .first()
      .setInputFiles(SAMPLE_PROFILE_PATH);
    await window
      .locator('input[type="file"][accept=".mp"]')
      .last()
      .setInputFiles(MOTION_PROFILE_E2E_PATH);
    await window.waitForTimeout(500);

    await window.getByRole('button', { name: 'Run Test' }).last().click();
    await expect(window.getByRole('button', { name: 'Test Running...' })).toBeVisible({
      timeout: 15000,
    });
    await expect(window.getByRole('button', { name: 'Run Test' })).toBeEnabled({
      timeout: 60_000,
    });
    await window.waitForTimeout(1500);

    const currentFiles = fs.readdirSync(SD_TEST_DIR).filter((f) => f.endsWith('.bin'));
    const newFiles = currentFiles.filter((f) => !existingFiles.has(f));
    expect(newFiles.length).toBe(1);
    const testName = newFiles[0].replace('.bin', '');

    // Download into the app test-runs dir + mark the run viewable.
    const testRunsDir = (await window.evaluate(async () =>
      (globalThis as any).electron.ipcRenderer.invoke('data-get-test-runs-dir'),
    )) as string;
    const savePath = path.join(testRunsDir, `${testName}.csv`);
    const result = (await window.evaluate(
      async ({ name, dest }: { name: string; dest: string }) =>
        (globalThis as any).electron.ipcRenderer.invoke('download-test-file', {
          testName: name,
          savePath: dest,
        }),
      { name: testName, dest: savePath },
    )) as { success: boolean };
    expect(result.success).toBe(true);

    await window.evaluate(async ({ name }: { name: string }) => {
      const response = await (globalThis as any).electron.ipcRenderer.invoke(
        'data-get-test-runs',
        { offset: 0, limit: 50 },
      );
      const runs = (response?.runs || []).filter(
        (entry: { testName: string }) => entry.testName === name,
      );
      runs.sort(
        (a: { startedAt: string }, b: { startedAt: string }) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );
      const run = runs[0];
      if (!run) throw new Error(`Test run not found for ${name}`);
      await (globalThis as any).electron.ipcRenderer.invoke('data-update-test-run', run.id, {
        status: 'downloaded',
        dataFilePath: `${name}.csv`,
        completedAt: new Date().toISOString(),
      });
    }, { name: testName });

    // Navigate to Tests and open the viewer.
    await window.getByRole('link', { name: 'Tests' }).click();
    await window.getByRole('button', { name: 'Refresh' }).click();
    await expect(window.getByText(testName).first()).toBeVisible({ timeout: 5000 });

    const row = window
      .locator('tr', { hasText: testName })
      .filter({ has: window.getByText('Downloaded') })
      .first();
    await row.getByRole('button', { name: 'View test data' }).click();

    const baselineText = await window.getByTestId('expected-gcode-baseline').textContent();
    expect(baselineText).toBeTruthy();
    const parsed = JSON.parse(baselineText || '{}') as {
      initialSampleMm: number;
      expectedStartMm: number | null;
    };
    expect(Number.isFinite(parsed.initialSampleMm)).toBe(true);
    expect(parsed.expectedStartMm).not.toBeNull();
    expect(Number.isFinite(parsed.expectedStartMm as number)).toBe(true);
    expect(
      Math.abs((parsed.expectedStartMm as number) - parsed.initialSampleMm),
    ).toBeLessThan(1e-6);
  });

  test.describe('Baud pacing', () => {
    test.use({ madSimBaud: 57_600 });

    test('file download is not instantaneous when MAD_SIM_BAUD is low', async ({
      window,
      connectToEmulator,
    }) => {
      await connectToEmulator();

      await window.getByRole('link', { name: 'Dashboard' }).click();
      await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

      const ipcEnabled = await window.evaluate(async () =>
        (globalThis as any).electron.ipcRenderer.invoke('set-motion-enabled', true),
      );
      expect(Boolean(ipcEnabled)).toBe(true);
      await expect(window.getByText('Enabled')).toBeVisible({ timeout: 5000 });

      const existingFiles = new Set(
        fs.existsSync(SD_TEST_DIR)
          ? fs.readdirSync(SD_TEST_DIR).filter((f) => f.endsWith('.bin'))
          : [],
      );

      await window.getByRole('button', { name: 'Run Test' }).click();
      await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

      await window
        .locator('input[type="file"][accept=".sp"]')
        .first()
        .setInputFiles(SAMPLE_PROFILE_PATH);
      await window
        .locator('input[type="file"][accept=".mp"]')
        .last()
        .setInputFiles(MOTION_PROFILE_E2E_PATH);
      await window.waitForTimeout(500);

      await window.getByRole('button', { name: 'Run Test' }).last().click();
      await expect(window.getByRole('button', { name: 'Test Running...' })).toBeVisible({
        timeout: 15000,
      });
      await expect(window.getByRole('button', { name: 'Run Test' })).toBeEnabled({
        timeout: 60_000,
      });
      await window.waitForTimeout(1500);

      const currentFiles = fs.readdirSync(SD_TEST_DIR).filter((f) => f.endsWith('.bin'));
      const newFiles = currentFiles.filter((f) => !existingFiles.has(f));
      expect(newFiles.length).toBe(1);
      const testName = newFiles[0].replace('.bin', '');

      const savePath = path.join(os.tmpdir(), `mad-baud-${Date.now()}.csv`);
      const t0 = Date.now();
      const result = (await window.evaluate(
        async ({ name, dest }: { name: string; dest: string }) =>
          (globalThis as any).electron.ipcRenderer.invoke('download-test-file', {
            testName: name,
            savePath: dest,
          }),
        { name: testName, dest: savePath },
      )) as { success: boolean; fileSize: number };
      const elapsedMs = Date.now() - t0;

      expect(result.success).toBe(true);
      expect(result.fileSize).toBeGreaterThan(0);

      // At 57600 8N1 ≈ 5760 bytes/sec; modest payloads should take >1s.
      expect(elapsedMs, `download elapsedMs=${elapsedMs}`).toBeGreaterThan(1200);
      expect(elapsedMs, `download elapsedMs=${elapsedMs}`).toBeLessThan(20_000);

      if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
    });
  });
});
