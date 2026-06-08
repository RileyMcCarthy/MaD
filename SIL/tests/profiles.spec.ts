/**
 * Profile Operations (consolidated)
 *
 * One test covering the full profile + Test Runner surface:
 *   - Create page form behavior for sample profile + motion profile
 *   - G-code preview from Create page
 *   - Dashboard Test Runner: open dialog, load profiles, preview G-code
 *   - Live dashboard charts + manual jog from dashboard
 *   - Full test execution via Run Test dialog
 */

import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import path from 'path';

const FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures');
const SAMPLE_PROFILE_PATH = path.join(FIXTURES_DIR, 'sample-profile.sp');
const MOTION_PROFILE_SIMPLE_PATH = path.join(FIXTURES_DIR, 'motion-profile-simple.mp');
const MOTION_PROFILE_COMPLEX_PATH = path.join(FIXTURES_DIR, 'motion-profile-complex.mp');

/** IPC jog (G91+G0 with ACK ordering); assert |Δposition| via DOM or last sample. */
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

  test('create page + dashboard runner + execution end-to-end', async ({
    connectToEmulator,
    window,
  }) => {
    await connectToEmulator();

    // ── 1. Create page: sample profile form ────────────────────────────
    await window.getByRole('link', { name: 'Create' }).click();
    await window.waitForTimeout(300);
    await expect(window.getByRole('heading', { name: 'Sample Profile' })).toBeVisible();

    await expect(window.getByLabel('Max Force (N)')).toBeVisible();
    await expect(window.getByLabel('Max Velocity (mm/s)')).toBeVisible();
    await expect(window.getByLabel('Max Displacement (mm)')).toBeVisible();
    await expect(window.getByLabel('Sample Width (mm)')).toBeVisible();
    await expect(window.getByLabel('Sample Thickness (mm)')).toBeVisible();
    await expect(window.getByLabel('Sample Name')).toBeVisible();

    await window.getByLabel('Max Force (N)').fill('100');
    await expect(window.getByLabel('Max Force (N)')).toHaveValue('100');
    await window.getByLabel('Max Velocity (mm/s)').fill('50');
    await window.getByLabel('Max Displacement (mm)').fill('200');
    await window.getByLabel('Sample Name').fill('TEST-SERIAL-001');
    await expect(window.getByLabel('Sample Name')).toHaveValue('TEST-SERIAL-001');

    const saveSampleBtn = window.getByRole('button', { name: 'Save Sample Profile' });
    await expect(saveSampleBtn).toBeEnabled();

    // Load sample profile from file
    const spInputCreate = window.locator('input[type="file"][accept=".sp"]').first();
    await spInputCreate.setInputFiles(SAMPLE_PROFILE_PATH);
    await window.waitForTimeout(500);
    await expect(window.getByLabel('Max Force (N)')).toHaveValue('50');
    await expect(window.getByLabel('Max Velocity (mm/s)')).toHaveValue('25');
    await expect(window.getByLabel('Max Displacement (mm)')).toHaveValue('100');
    await expect(window.getByLabel('Sample Width (mm)')).toHaveValue('10');
    await expect(window.getByLabel('Sample Thickness (mm)')).toHaveValue('2');
    await expect(window.getByLabel('Sample Name')).toHaveValue('sample-profile');

    // Modify and verify others unchanged
    await window.getByLabel('Max Force (N)').fill('75');
    await expect(window.getByLabel('Max Force (N)')).toHaveValue('75');
    await expect(window.getByLabel('Max Velocity (mm/s)')).toHaveValue('25');

    // ── 2. Motion profile form, sets, moves, load both fixtures ────────
    await expect(window.getByRole('heading', { name: 'Motion Profile' })).toBeVisible();
    await expect(window.getByLabel('Name', { exact: true }).first()).toBeVisible();
    await expect(window.getByRole('button', { name: 'Add Set' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Save Motion Profile' })).toBeEnabled();

    await window.getByLabel('Name', { exact: true }).first().fill('Test Motion Profile');
    await window
      .getByLabel('Description', { exact: true })
      .first()
      .fill('Created by Playwright test');
    await window.getByRole('button', { name: 'Add Set' }).click();
    await window.waitForTimeout(300);
    await expect(window.getByLabel('Set Name').first()).toBeVisible();
    await expect(window.getByRole('button', { name: 'Add Move' }).first()).toBeVisible();

    // Add a move and verify
    await expect(window.locator('text=Linear').first()).toBeVisible();
    await window.getByRole('button', { name: 'Add Move' }).first().click();
    await window.waitForTimeout(200);
    const moveCount =
      (await window.locator('text=Linear').count()) +
      (await window.locator('text=Dwell').count());
    expect(moveCount).toBeGreaterThanOrEqual(2);

    // Load simple, then complex profile
    const mpInput = window.locator('input[type="file"][accept=".mp"]');
    await mpInput.setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
    await window.waitForTimeout(500);
    await expect(window.getByLabel('Set Name')).toHaveValue('Tension Cycle');

    await mpInput.setInputFiles(MOTION_PROFILE_COMPLEX_PATH);
    await window.waitForTimeout(500);
    await expect(window.getByLabel('Name', { exact: true }).first()).toHaveValue('Complex Multi-Set Test');
    await expect(window.getByLabel('Set Name').first()).toHaveValue('Conditioning Cycles');
    await expect(window.getByLabel('Set Name').nth(1)).toHaveValue('Main Test');

    // Switch back to simple for the rest of the run.
    await mpInput.setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
    await window.waitForTimeout(300);

    // ── 3. G-code preview from Create page ─────────────────────────────
    await window.getByRole('button', { name: 'Preview G-code' }).click();
    await window.waitForTimeout(500);
    await expect(window.getByText('Generated G-code and Graph')).toBeVisible();
    await expect(window.getByText(/G90/).first()).toBeVisible();
    await expect(window.getByText(/G1/).first()).toBeVisible();
    const previewText = await window.locator('body').textContent();
    expect(previewText).toContain('G122');
    await window.getByRole('button', { name: 'Close' }).click();
    await window.waitForTimeout(300);

    // ── 4. Dashboard: Test Runner visible ──────────────────────────────
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
    await window.waitForTimeout(300);
    await expect(window.getByRole('heading', { name: 'Test Runner' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Run Test' }).first()).toBeVisible();

    // ── 5. Open Run Test dialog → preview, then cancel ─────────────────
    await window.getByRole('button', { name: 'Run Test' }).click();
    await window.waitForTimeout(300);
    await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

    let spInput = window.locator('input[type="file"][accept=".sp"]');
    await spInput.first().setInputFiles(SAMPLE_PROFILE_PATH);
    await window.waitForTimeout(1500);

    let mpInputDialog = window.locator('input[type="file"][accept=".mp"]');
    await mpInputDialog.last().setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
    await window.waitForTimeout(500);

    await expect(window.getByRole('heading', { name: 'G-code Preview' })).toBeVisible({ timeout: 5000 });
    await expect(window.getByRole('button', { name: 'Run Test' }).last()).toBeEnabled();
    await window.getByRole('button', { name: 'Cancel' }).click();
    await window.waitForTimeout(500);

    // ── 6. Live charts present + manual motion ─────────────────────────
    await expect(window.getByRole('heading', { name: 'Stress-Strain Chart' })).toBeVisible();
    await expect(window.getByText(/Coordinate System:/)).toBeVisible();
    await expect(
      window
        .getByText('No sample data available')
        .or(window.getByText('Strain (%)', { exact: true })),
    ).toBeVisible();

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
            const s = await (globalThis as any).electron.ipcRenderer.invoke('device-latest-sample');
            return Boolean(s && typeof s['Machine Position (mm)'] === 'number');
          }),
        { timeout: 15_000, intervals: [100, 200, 400] },
      )
      .toBe(true);

    const baselineSample = (await window.evaluate(async () =>
      (globalThis as any).electron.ipcRenderer.invoke('device-latest-sample'),
    )) as Record<string, number> | null;
    expect(baselineSample).not.toBeNull();
    const baselinePosition = baselineSample!['Machine Position (mm)'];
    expect(Number.isFinite(baselinePosition)).toBe(true);

    // If we're at an endstop, positive jog may not change position — try both directions.
    try {
      await jogAndAssertDisplacementMm(window, baselinePosition, 12, 25, 0.02, 45_000);
    } catch {
      await jogAndAssertDisplacementMm(window, baselinePosition, -12, 25, 0.02, 45_000);
    }
    await expect(window.getByText(/Coordinate System:/)).toBeVisible();

    // ── 7. Run a test through the dialog and watch it complete ─────────
    await window.getByRole('button', { name: 'Run Test' }).click();
    await window.waitForTimeout(300);
    await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

    spInput = window.locator('input[type="file"][accept=".sp"]');
    await spInput.first().setInputFiles(SAMPLE_PROFILE_PATH);
    await window.waitForTimeout(1000);
    mpInputDialog = window.locator('input[type="file"][accept=".mp"]');
    await mpInputDialog.last().setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
    await window.waitForTimeout(500);

    await expect(window.getByRole('heading', { name: 'G-code Preview' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Run Test' }).last()).toBeEnabled();
    await window.getByRole('button', { name: 'Run Test' }).last().click();

    await expect(window.getByRole('button', { name: 'Test Running...' })).toBeVisible({ timeout: 10000 });
    await expect(window.getByRole('button', { name: 'Run Test' }).first()).toBeEnabled({ timeout: 30000 });
  });
});
