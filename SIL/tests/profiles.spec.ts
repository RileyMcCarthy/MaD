/**
 * Profile Operations Tests (consolidated)
 *
 * Single test per section that validates:
 * - Sample profile: form fields visible, accept input, load from file, modify, save button
 * - Motion profile: form fields, Add Set/Move, load simple/complex profiles
 * - G-code preview: generation, expected commands, G122 STOP
 * - Dashboard profile loading: Test Runner visible, dialog loads profiles, graph renders
 * - Test execution: enable motion → start → verify running → completion
 * - Manual motion with graph rendering
 */

import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import path from 'path';

const FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures');
const SAMPLE_PROFILE_PATH = path.join(FIXTURES_DIR, 'sample-profile.sp');
const MOTION_PROFILE_SIMPLE_PATH = path.join(FIXTURES_DIR, 'motion-profile-simple.mp');
const MOTION_PROFILE_COMPLEX_PATH = path.join(FIXTURES_DIR, 'motion-profile-complex.mp');

/** IPC jog (G91+G0 with ACK ordering); assert |Δposition| via DOM (matches dashboard-motion). */
async function jogAndAssertDisplacementMm(
  window: Page,
  baselineMm: number,
  deltaMm: number,
  speedMmPerSec: number,
  minAbsDeltaMm: number,
  timeoutMs: number,
): Promise<void> {
  const ok = await window.evaluate(
    async ({ d, s }: { d: number; s: number }) =>
      (globalThis as any).electron.ipcRenderer.invoke('manual-move', d, s),
    { d: deltaMm, s: speedMmPerSec },
  );
  expect(ok).toBe(true);

  const positionText = window.locator('text=Machine Position (mm):').locator('..').first();
  const readMm = async (): Promise<number> => {
    const text = (await positionText.textContent()) || '';
    const m = text.match(/Machine Position \(mm\):\s*([-\d.]+)/);
    if (!m) throw new Error(`Could not extract machine position from: ${text}`);
    return parseFloat(m[1]);
  };

  await expect
    .poll(
      async () => {
        const dom = Math.abs((await readMm()) - baselineMm);
        const s = (await window.evaluate(async () =>
          (globalThis as any).electron.ipcRenderer.invoke('device-latest-sample'),
        )) as Record<string, number> | null;
        const mm = s?.['Machine Position (mm)'];
        const ipc =
          typeof mm === 'number' && Number.isFinite(mm)
            ? Math.abs(mm - baselineMm)
            : 0;
        return Math.max(dom, ipc);
      },
      { timeout: timeoutMs, intervals: [40, 80, 120, 200, 400] },
    )
    .toBeGreaterThan(Math.max(minAbsDeltaMm, 0.5));
}

test.describe('Profile Operations', () => {
  test.describe.configure({ retries: 2 });

  test('sample profile: fields, input, load, modify, save', async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Create' }).click();
    await window.waitForTimeout(300);
    await expect(window.getByRole('heading', { name: 'Sample Profile' })).toBeVisible();

    // ── All fields visible ──
    await expect(window.getByLabel('Max Force (N)')).toBeVisible();
    await expect(window.getByLabel('Max Velocity (mm/s)')).toBeVisible();
    await expect(window.getByLabel('Max Displacement (mm)')).toBeVisible();
    await expect(window.getByLabel('Sample Width (mm)')).toBeVisible();
    await expect(window.getByLabel('Sample Thickness (mm)')).toBeVisible();
    await expect(window.getByLabel('Sample Name')).toBeVisible();

    // ── Fields accept input ──
    await window.getByLabel('Max Force (N)').fill('100');
    await expect(window.getByLabel('Max Force (N)')).toHaveValue('100');
    await window.getByLabel('Max Velocity (mm/s)').fill('50');
    await expect(window.getByLabel('Max Velocity (mm/s)')).toHaveValue('50');
    await window.getByLabel('Max Displacement (mm)').fill('200');
    await expect(window.getByLabel('Max Displacement (mm)')).toHaveValue('200');
    await window.getByLabel('Sample Name').fill('TEST-SERIAL-001');
    await expect(window.getByLabel('Sample Name')).toHaveValue('TEST-SERIAL-001');

    // ── Save button enabled ──
    const saveButton = window.getByRole('button', { name: 'Save Sample Profile' });
    await expect(saveButton).toBeVisible();
    await expect(saveButton).toBeEnabled();

    // ── Load profile from file ──
    const fileInput = window.locator('input[type="file"][accept=".sp"]').first();
    await fileInput.setInputFiles(SAMPLE_PROFILE_PATH);
    await window.waitForTimeout(500);

    await expect(window.getByLabel('Max Force (N)')).toHaveValue('50');
    await expect(window.getByLabel('Max Velocity (mm/s)')).toHaveValue('25');
    await expect(window.getByLabel('Max Displacement (mm)')).toHaveValue('100');
    await expect(window.getByLabel('Sample Width (mm)')).toHaveValue('10');
    await expect(window.getByLabel('Sample Thickness (mm)')).toHaveValue('2');
    await expect(window.getByLabel('Sample Name')).toHaveValue('sample-profile');

    // ── Modify loaded values ──
    await window.getByLabel('Max Force (N)').fill('75');
    await expect(window.getByLabel('Max Force (N)')).toHaveValue('75');
    // Other values unchanged
    await expect(window.getByLabel('Max Velocity (mm/s)')).toHaveValue('25');
    await expect(window.getByLabel('Sample Name')).toHaveValue('sample-profile');
  });

  test('motion profile: form, sets, moves, load simple and complex', async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Create' }).click();
    await window.waitForTimeout(300);

    // ── Form fields and buttons visible ──
    await expect(window.getByRole('heading', { name: 'Motion Profile' })).toBeVisible();
    await expect(window.getByLabel('Name', { exact: true }).first()).toBeVisible();
    await expect(window.getByLabel('Description', { exact: true }).first()).toBeVisible();
    await expect(window.getByRole('button', { name: 'Add Set' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Preview G-code' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Save Motion Profile' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Save Motion Profile' })).toBeEnabled();

    // ── Add Set creates set with Add Move ──
    await window.getByLabel('Name', { exact: true }).first().fill('Test Motion Profile');
    await window.getByLabel('Description', { exact: true }).first().fill('Created by Playwright test');
    await window.getByRole('button', { name: 'Add Set' }).click();
    await window.waitForTimeout(300);
    await expect(window.getByLabel('Set Name').first()).toBeVisible();
    await expect(window.getByRole('button', { name: 'Add Move' }).first()).toBeVisible();

    // ── Adding moves shows move type ──
    await expect(window.locator('text=Linear').first()).toBeVisible();
    await window.getByRole('button', { name: 'Add Move' }).first().click();
    await window.waitForTimeout(200);
    const moveCount = await window.locator('text=Linear').count() +
      await window.locator('text=Dwell').count();
    expect(moveCount).toBeGreaterThanOrEqual(2);

    // More inputs after adding moves
    const numberInputs = window.locator('input[type="number"]');
    expect(await numberInputs.count()).toBeGreaterThan(6);

    // ── Load simple profile ──
    const fileInput = window.locator('input[type="file"][accept=".mp"]');
    await fileInput.setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
    await window.waitForTimeout(500);
    await expect(window.getByLabel('Set Name')).toHaveValue('Tension Cycle');

    // ── Load complex profile ──
    await fileInput.setInputFiles(MOTION_PROFILE_COMPLEX_PATH);
    await window.waitForTimeout(500);
    await expect(window.getByLabel('Name', { exact: true }).first()).toHaveValue('Complex Multi-Set Test');
    await expect(window.getByLabel('Description', { exact: true }).first()).toHaveValue(
      'A complex motion profile with multiple sets, move types, and executions',
    );
    await expect(window.getByLabel('Set Name').first()).toHaveValue('Conditioning Cycles');
    await expect(window.getByLabel('Set Name').nth(1)).toHaveValue('Main Test');
  });

  test('G-code preview: generation and expected commands', async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Create' }).click();
    await window.waitForTimeout(300);

    // Load sample profile (required for G-code generation)
    const spInput = window.locator('input[type="file"][accept=".sp"]').first();
    await spInput.setInputFiles(SAMPLE_PROFILE_PATH);
    await window.waitForTimeout(300);

    // Load motion profile
    const mpInput = window.locator('input[type="file"][accept=".mp"]').first();
    await mpInput.setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
    await window.waitForTimeout(300);

    // Open preview
    await window.getByRole('button', { name: 'Preview G-code' }).click();
    await window.waitForTimeout(500);

    // Dialog should open
    await expect(window.getByText('Generated G-code and Graph')).toBeVisible();

    // Verify key G-code commands
    await expect(window.getByText(/G90/).first()).toBeVisible();
    await expect(window.getByText(/G1/).first()).toBeVisible();

    // Must contain G122 STOP
    const pageText = await window.locator('body').textContent();
    expect(pageText).toContain('G122');

    // Close
    await window.getByRole('button', { name: 'Close' }).click();
  });

  test('dashboard: test runner, dialog, graph, test execution, manual motion', async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
    await window.waitForTimeout(300);

    // ── Test Runner visible ──
    await expect(window.getByRole('heading', { name: 'Test Runner' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Run Test' }).first()).toBeVisible();

    // ── Run Test dialog loads profiles and shows G-code preview ──
    await window.getByRole('button', { name: 'Run Test' }).click();
    await window.waitForTimeout(300);
    await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

    const spInput = window.locator('input[type="file"][accept=".sp"]');
    await spInput.first().setInputFiles(SAMPLE_PROFILE_PATH);
    await window.waitForTimeout(1500);

    const mpInput = window.locator('input[type="file"][accept=".mp"]');
    await mpInput.last().setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
    await window.waitForTimeout(500);

    await expect(window.getByRole('heading', { name: 'G-code Preview' })).toBeVisible({ timeout: 5000 });
    await expect(window.getByRole('button', { name: 'Run Test' }).last()).toBeEnabled();
    await window.getByRole('button', { name: 'Cancel' }).click();
    await window.waitForTimeout(500);

    // ── Graph renders with chart axis labels ──
    await expect(window.getByRole('heading', { name: 'Stress-Strain Chart' })).toBeVisible();
    await expect(window.getByText('Force (N)', { exact: true })).toBeVisible();
    await expect(window.getByText('Position (mm)', { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Clear chart data' })).toBeVisible();

    // ── Manual motion changes position ──
    const positionText = window.locator('text=Machine Position (mm):').locator('..').first();
    const extractPositionMm = async (): Promise<number> => {
      const text = (await positionText.textContent()) || '';
      // UI may render with or without a space after the colon, so `\s*` handles both.
      const m = text.match(/Machine Position \(mm\):\s*([-\d.]+)/);
      if (!m) throw new Error(`Could not extract machine position from: ${text}`);
      return parseFloat(m[1]);
    };

    const enableBtn = window.getByRole('button', { name: 'Enable Motion' });
    if (await enableBtn.isVisible()) {
      await enableBtn.click();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });
    }
    const ipcEnabled = await window.evaluate(async () =>
      (globalThis as any).electron.ipcRenderer.invoke('set-motion-enabled', true),
    );
    expect(Boolean(ipcEnabled)).toBe(true);
    await expect(window.getByText('Enabled')).toBeVisible({ timeout: 5000 });

    await expect
      .poll(
        async () =>
          window.evaluate(async () => {
            const s = await (globalThis as any).electron.ipcRenderer.invoke(
              'device-latest-sample',
            );
            return Boolean(s && typeof s['Machine Position (mm)'] === 'number');
          }),
        { timeout: 15_000, intervals: [100, 200, 400] },
      )
      .toBe(true);

    await window.getByLabel('Move Distance (mm)').fill('12');
    await window.getByLabel('Move Speed (mm/s)').fill('25');

    const baselineSample = (await window.evaluate(async () =>
      (globalThis as any).electron.ipcRenderer.invoke('device-latest-sample'),
    )) as Record<string, number> | null;
    expect(
      baselineSample,
      'device-latest-sample returned null after passing readiness poll (bridge may have dropped the cache)',
    ).not.toBeNull();
    const baselinePosition = baselineSample!['Machine Position (mm)'];
    expect(Number.isFinite(baselinePosition)).toBe(true);

    const jogMm = 12;
    const jogSpeed = 25;

    // If we're already at an endstop, positive jog may not change position.
    try {
      await jogAndAssertDisplacementMm(
        window,
        baselinePosition,
        jogMm,
        jogSpeed,
        0.02,
        45_000,
      );
    } catch {
      await jogAndAssertDisplacementMm(
        window,
        baselinePosition,
        -jogMm,
        jogSpeed,
        0.02,
        45_000,
      );
    }

    // Chart still renders
    await expect(window.getByText('Force (N)', { exact: true })).toBeVisible();
    await expect(window.getByText('Position (mm)', { exact: true })).toBeVisible();

    // ── Test execution: start, verify running, completion ──
    await window.getByRole('button', { name: 'Run Test' }).click();
    await window.waitForTimeout(300);
    await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

    const sp2 = window.locator('input[type="file"][accept=".sp"]');
    await sp2.first().setInputFiles(SAMPLE_PROFILE_PATH);
    await window.waitForTimeout(1000);
    const mp2 = window.locator('input[type="file"][accept=".mp"]');
    await mp2.last().setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
    await window.waitForTimeout(500);

    await expect(window.getByRole('heading', { name: 'G-code Preview' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Run Test' }).last()).toBeEnabled();
    await window.getByRole('button', { name: 'Run Test' }).last().click();

    await expect(window.getByRole('button', { name: 'Test Running...' })).toBeVisible({ timeout: 10000 });
    await expect(window.getByRole('button', { name: 'Run Test' }).first()).toBeEnabled({ timeout: 15000 });
  });
});
