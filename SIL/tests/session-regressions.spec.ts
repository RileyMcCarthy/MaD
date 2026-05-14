/**
 * Regressions / features added in recent session:
 * - Coordinate system naming: Machine/Sample (no Global)
 * - Sample force model: slack region then linear tension
 * - TestRunViewer expected G-code baseline anchored to initial sample position
 * - Baud pacing (MAD_SIM_BAUD) impacts download duration (not instantaneous)
 */

import { test, expect } from './fixtures';
import path from 'path';
import fs from 'fs';
import os from 'os';

function extractValue(text: string | null, label: string): number | null {
  if (!text) return null;
  const pattern = new RegExp(`${label}:\\s*([-\\d.]+)`);
  const match = text.match(pattern);
  return match ? parseFloat(match[1]) : null;
}

const getSampleForce = async (container: any) =>
  extractValue(await container.textContent(), 'Sample Force \\(N\\)');

const getSamplePosition = async (container: any) =>
  extractValue(await container.textContent(), 'Sample Position \\(mm\\)');

const getMachinePosition = async (container: any) =>
  extractValue(await container.textContent(), 'Machine Position \\(mm\\)');

test.describe('Session regressions', () => {
  test('Graph coordinate terminology is Machine/Sample (no Global)', async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

    // Live graph header should show "Coordinate System: Machine|Sample" and no "Global"
    await expect(window.getByText(/Coordinate System:/)).toBeVisible();
    await expect(window.getByRole('button', { name: 'Machine' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Sample' })).toBeVisible();
    await expect(window.getByText(/Global/)).toHaveCount(0);

    // Toggle works (just verifies UI state text flips)
    await window.getByRole('button', { name: 'Sample' }).click();
    await expect(window.getByText(/Coordinate System:\s*Sample/)).toBeVisible();
    await window.getByRole('button', { name: 'Machine' }).click();
    await expect(window.getByText(/Coordinate System:\s*Machine/)).toBeVisible();
  });

  test('Sample model: first 15mm slack yields ~0 force, then force rises', async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

    const enableBtn = window.getByRole('button', { name: 'Enable Motion' });
    const disableBtn = window.getByRole('button', { name: 'Disable Motion' });
    const distanceInput = window.getByLabel('Move Distance (mm)');
    const speedInput = window.getByLabel('Move Speed (mm/s)');

    if (await enableBtn.isVisible()) {
      await enableBtn.click();
      await expect(disableBtn).toBeVisible({ timeout: 5000 });
    }

    // Ensure sample baseline is well-defined for this test.
    await window.getByRole('button', { name: 'Zero Length' }).click();
    await window.waitForTimeout(500);
    await window.getByRole('button', { name: 'Zero Force' }).click();
    await window.waitForTimeout(500);

    const samplePosContainer = window.locator('text=Sample Position (mm):').locator('..').first();
    const sampleForceContainer = window.locator('text=Sample Force (N):').locator('..').first();
    const machinePosContainer = window.locator('text=Machine Position (mm):').locator('..').first();

    // Move +10mm: still within slack (15mm) so sample force should remain near 0.
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
      // Position should have moved; force should remain ~0 in slack.
      expect(sp).toBeGreaterThan(8);
      expect(Math.abs(f)).toBeLessThan(0.15);
    }).toPass({ timeout: 20_000 });

    // Move another +10mm (total ~20mm): beyond slack, force should be > 0.
    await distanceInput.fill('10');
    await speedInput.fill('20');
    await window.getByRole('button', { name: 'Move Up' }).click();

    await expect(async () => {
      const sp = (await getSamplePosition(samplePosContainer))!;
      const f = (await getSampleForce(sampleForceContainer))!;
      expect(sp).toBeGreaterThan(18);
      // With k ~= 5/(100-15)=0.0588 N/mm, at 20mm extension force ~0.29N.
      expect(f).toBeGreaterThan(0.1);
    }).toPass({ timeout: 20_000 });
  });

  test('TestRunViewer: expected G-code baseline matches initial sample frame', async ({ window, connectToEmulator }) => {
    await connectToEmulator();

    // Create a test run quickly using the existing lifecycle flow assets.
    const FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures');
    const SAMPLE_PROFILE_PATH = path.join(FIXTURES_DIR, 'sample-profile.sp');
    const MOTION_PROFILE_E2E_PATH = path.join(FIXTURES_DIR, 'motion-profile-e2e.mp');
    const SD_TEST_DIR = path.resolve(__dirname, '../sd/test');

    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

    const enableButton = window.getByRole('button', { name: 'Enable Motion' });
    if (await enableButton.isVisible()) {
      await enableButton.click();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });
    }

    const existingFiles = new Set(
      fs.existsSync(SD_TEST_DIR)
        ? fs.readdirSync(SD_TEST_DIR).filter((f) => f.endsWith('.bin'))
        : [],
    );

    await window.getByRole('button', { name: 'Run Test' }).click();
    await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

    await window.locator('input[type="file"][accept=".sp"]').first().setInputFiles(SAMPLE_PROFILE_PATH);
    await window.locator('input[type="file"][accept=".mp"]').last().setInputFiles(MOTION_PROFILE_E2E_PATH);
    await window.waitForTimeout(500);

    await window.getByRole('button', { name: 'Run Test' }).last().click();
    await expect(window.getByRole('button', { name: 'Test Running...' })).toBeVisible({ timeout: 15000 });
    await expect(window.getByRole('button', { name: 'Run Test' }).first()).toBeEnabled({ timeout: 30000 });
    await window.waitForTimeout(1500);

    const currentFiles = fs.readdirSync(SD_TEST_DIR).filter((f) => f.endsWith('.bin'));
    const newFiles = currentFiles.filter((f) => !existingFiles.has(f));
    expect(newFiles.length).toBe(1);
    const testName = newFiles[0].replace('.bin', '');

    // Download so the Tests page marks it as viewable.
    const savePath = path.join(os.tmpdir(), `mad-baseline-${Date.now()}.csv`);
    const result = await window.evaluate(
      async ({ name, dest }: { name: string; dest: string }) => {
        return window.electron.ipcRenderer.invoke('download-test-file', {
          testName: name,
          savePath: dest,
        });
      },
      { name: testName, dest: savePath },
    );
    expect((result as any).success).toBe(true);

    // Navigate to Tests and open the viewer.
    await window.getByRole('link', { name: 'Tests' }).click();
    await window.waitForTimeout(1000);
    await expect(window.getByText(testName).first()).toBeVisible({ timeout: 5000 });

    // Click the view button on the row containing testName.
    const row = window.locator('tr', { hasText: testName }).first();
    await row.getByRole('button', { name: 'View test data' }).click();

    // The viewer page should expose a hidden baseline blob for E2E.
    const baselineText = await window.getByTestId('expected-gcode-baseline').textContent();
    expect(baselineText).toBeTruthy();
    const parsed = JSON.parse(baselineText || '{}') as { initialSampleMm: number; expectedStartMm: number | null };

    expect(Number.isFinite(parsed.initialSampleMm)).toBe(true);
    expect(parsed.expectedStartMm).not.toBeNull();
    expect(Number.isFinite(parsed.expectedStartMm as number)).toBe(true);

    // Expected first point should match the initial sample-frame baseline (no forced 0).
    expect(Math.abs((parsed.expectedStartMm as number) - parsed.initialSampleMm)).toBeLessThan(1e-6);
  });

  test.describe('Baud pacing', () => {
    test.use({ madSimBaud: 57_600 });

    test('file download is not instantaneous when MAD_SIM_BAUD is low', async ({
      window,
      connectToEmulator,
    }) => {
      await connectToEmulator();

      const FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures');
      const SAMPLE_PROFILE_PATH = path.join(FIXTURES_DIR, 'sample-profile-regression.sp');
      const MOTION_PROFILE_PATH = path.join(FIXTURES_DIR, 'motion-profile-fractional.mp');
      const SD_TEST_DIR = path.resolve(__dirname, '../sd/test');

      await window.getByRole('link', { name: 'Dashboard' }).click();
      await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

      const enableButton = window.getByRole('button', { name: 'Enable Motion' });
      if (await enableButton.isVisible()) {
        await enableButton.click();
        await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });
      }

      const existingFiles = new Set(
        fs.existsSync(SD_TEST_DIR)
          ? fs.readdirSync(SD_TEST_DIR).filter((f) => f.endsWith('.bin'))
          : [],
      );

      await window.getByRole('button', { name: 'Run Test' }).click();
      await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

      await window.locator('input[type="file"][accept=".sp"]').first().setInputFiles(SAMPLE_PROFILE_PATH);
      await window.locator('input[type="file"][accept=".mp"]').last().setInputFiles(MOTION_PROFILE_PATH);
      await window.waitForTimeout(500);

      await window.getByRole('button', { name: 'Run Test' }).last().click();
      await expect(window.getByRole('button', { name: 'Test Running...' })).toBeVisible({ timeout: 15000 });
      await expect(window.getByRole('button', { name: 'Run Test' }).first()).toBeEnabled({ timeout: 30000 });
      await window.waitForTimeout(1500);

      const currentFiles = fs.readdirSync(SD_TEST_DIR).filter((f) => f.endsWith('.bin'));
      const newFiles = currentFiles.filter((f) => !existingFiles.has(f));
      expect(newFiles.length).toBe(1);
      const testName = newFiles[0].replace('.bin', '');

      const savePath = path.join(os.tmpdir(), `mad-baud-${Date.now()}.csv`);

      const t0 = Date.now();
      const result = await window.evaluate(
        async ({ name, dest }: { name: string; dest: string }) => {
          return window.electron.ipcRenderer.invoke('download-test-file', {
            testName: name,
            savePath: dest,
          });
        },
        { name: testName, dest: savePath },
      );
      const elapsedMs = Date.now() - t0;

      expect((result as any).success).toBe(true);
      expect((result as any).fileSize).toBeGreaterThan(0);

      // At 57600 8N1 you get ~5760 bytes/sec. Even modest payloads should take
      // well over a second end-to-end when RX pacing is enabled.
      expect(elapsedMs, `download elapsedMs=${elapsedMs}`).toBeGreaterThan(1200);
      expect(elapsedMs, `download elapsedMs=${elapsedMs}`).toBeLessThan(20_000);

      if (fs.existsSync(savePath)) {
        fs.unlinkSync(savePath);
      }
    });
  });
});

