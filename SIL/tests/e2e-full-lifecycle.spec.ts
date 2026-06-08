/**
 * End-to-End Full Lifecycle Test
 *
 * Validates the complete UI workflow from profile creation through viewing
 * the recorded test data in the in-app viewer:
 *
 *  1. Connect to the emulator
 *  2. Create a sample profile via UI form + verify field values
 *  3. Load a motion profile that exercises all move types
 *  4. Preview G-code (Create page) and verify expected commands
 *  5. Enable motion on Dashboard
 *  6. Run the test through the Run Test dialog and watch it complete
 *  7. Verify a binary data file landed on the emulator SD card
 *  8. Navigate to Tests page and confirm the new run appears with status
 *     "Completed"
 *  9. Click the UI Download button → wait for status to flip to "Downloaded"
 *     (this exercises the same path the user takes, not the IPC fast-path)
 * 10. Verify the CSV file lives in the app's test-runs directory and contains
 *     a valid CSV body
 * 11. Click "View test data" → assert the TestRunViewer page renders:
 *       - Test name heading
 *       - Sample / Motion profile cards
 *       - Position vs Time chart
 *       - Stress-Strain chart
 *       - expected-gcode-baseline testid is finite
 * 12. Parse and validate CSV content (header, monotonic timestamps, trajectory)
 */

import { test, expect } from './fixtures';
import path from 'path';
import fs from 'fs';

const FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures');
const SAMPLE_PROFILE_PATH = path.join(FIXTURES_DIR, 'sample-profile.sp');
const MOTION_PROFILE_E2E_PATH = path.join(FIXTURES_DIR, 'motion-profile-e2e.mp');
const SD_TEST_DIR = path.resolve(__dirname, '../sd/test');

type CsvSample = {
  time_us: number;
  force_mN: number;
  position_um: number;
  setpoint_um: number;
};

function parseCSV(csv: string): { header: string; data: CsvSample[] } {
  const lines = csv.split('\n').filter((l) => l.trim() !== '');
  const header = lines[0];
  const data = lines.slice(1).map((line) => {
    const [time_us, force_mN, position_um, setpoint_um] = line.split(',').map(Number);
    return { time_us, force_mN, position_um, setpoint_um };
  });
  return { header, data };
}

test.describe('End-to-End Full Lifecycle', () => {
  test('full UI lifecycle: create → run → download via UI → view → validate', async ({
    window,
    connectToEmulator,
  }) => {
    // ── 1. Connect to the emulator ─────────────────────────────────────
    await connectToEmulator();

    // ── 2. Fill in a sample profile via Create page form ───────────────
    await window.getByRole('link', { name: 'Create' }).click();
    await window.waitForTimeout(500);

    await expect(window.getByRole('heading', { name: 'Sample Profile' })).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Motion Profile' })).toBeVisible();

    await window.getByLabel('Max Force (N)').fill('75');
    await window.getByLabel('Max Velocity (mm/s)').fill('30');
    await window.getByLabel('Max Displacement (mm)').fill('150');
    await window.getByLabel('Sample Width (mm)').fill('12');
    await window.getByLabel('Sample Thickness (mm)').fill('3');
    await window.getByLabel('Sample Name').fill('E2E-FULL-001');

    await expect(window.getByLabel('Max Force (N)')).toHaveValue('75');
    await expect(window.getByLabel('Max Velocity (mm/s)')).toHaveValue('30');
    await expect(window.getByLabel('Max Displacement (mm)')).toHaveValue('150');
    await expect(window.getByLabel('Sample Width (mm)')).toHaveValue('12');
    await expect(window.getByLabel('Sample Thickness (mm)')).toHaveValue('3');
    await expect(window.getByLabel('Sample Name')).toHaveValue('E2E-FULL-001');

    // ── 3. Load motion profile from fixture file ───────────────────────
    const mpFileInput = window.locator('input[type="file"][accept=".mp"]').first();
    await mpFileInput.setInputFiles(MOTION_PROFILE_E2E_PATH);
    await window.waitForTimeout(500);

    await expect(window.getByLabel('Name', { exact: true }).first()).toHaveValue(
      'E2E Full Coverage Test',
    );
    await expect(window.getByLabel('Description', { exact: true }).first()).toHaveValue(
      'Exercises all move types: linear absolute, linear relative, dwell, multiple sets, multiple executions',
    );
    await expect(window.getByLabel('Set Name').first()).toHaveValue('Conditioning');
    await expect(window.getByLabel('Set Name').nth(1)).toHaveValue('Main Ramp');

    // ── 4. Preview G-code from Create page ─────────────────────────────
    await window.getByRole('button', { name: 'Preview G-code' }).click();
    await window.waitForTimeout(500);

    await expect(window.getByText('Generated G-code and Graph')).toBeVisible();
    await expect(window.getByText(/G90/).first()).toBeVisible();
    await expect(window.getByText(/G91/).first()).toBeVisible();
    await expect(window.getByText(/G1/).first()).toBeVisible();
    await expect(window.getByText(/G4/).first()).toBeVisible();
    await expect(window.getByText(/G122/).first()).toBeVisible();

    await window.getByRole('button', { name: 'Close' }).click();
    await window.waitForTimeout(300);

    // ── 5. Dashboard: enable motion ────────────────────────────────────
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
    await window.waitForTimeout(500);

    const enableButton = window.getByRole('button', { name: 'Enable Motion' });
    if (await enableButton.isVisible()) {
      await enableButton.click();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({
        timeout: 5000,
      });
    }
    await expect(window.getByText('Enabled')).toBeVisible();

    // ── 6. Run the test through the Run Test dialog ────────────────────
    const existingFiles = new Set(
      fs.existsSync(SD_TEST_DIR)
        ? fs.readdirSync(SD_TEST_DIR).filter((f) => f.endsWith('.bin'))
        : [],
    );

    await window.getByRole('button', { name: 'Run Test' }).click();
    await window.waitForTimeout(500);
    await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

    const spInput = window.locator('input[type="file"][accept=".sp"]');
    await spInput.first().setInputFiles(SAMPLE_PROFILE_PATH);
    await window.waitForTimeout(1000);

    const mpInput = window.locator('input[type="file"][accept=".mp"]');
    await mpInput.last().setInputFiles(MOTION_PROFILE_E2E_PATH);
    await window.waitForTimeout(500);

    await expect(window.getByRole('heading', { name: 'G-code Preview' })).toBeVisible({
      timeout: 5000,
    });

    const dialogRunButton = window.getByRole('button', { name: 'Run Test' }).last();
    await expect(dialogRunButton).toBeEnabled();
    await dialogRunButton.click();

    await expect(window.getByRole('button', { name: 'Test Running...' })).toBeVisible({
      timeout: 15000,
    });

    await expect(window.getByRole('button', { name: 'Run Test' }).first()).toBeEnabled({
      timeout: 30000,
    });
    await window.waitForTimeout(2000);

    // ── 7. Verify binary file landed on emulator SD ────────────────────
    const currentFiles = fs.readdirSync(SD_TEST_DIR).filter((f) => f.endsWith('.bin'));
    const newFiles = currentFiles.filter((f) => !existingFiles.has(f));
    expect(newFiles.length).toBe(1);
    const testFileName = newFiles[0];
    const testName = testFileName.replace('.bin', '');

    const binPath = path.join(SD_TEST_DIR, testFileName);
    const binSize = fs.statSync(binPath).size;
    expect(binSize).toBeGreaterThan(0);

    // ── 8. Navigate to Tests page and verify the new row appears ──────
    await window.getByRole('link', { name: 'Tests' }).click();
    await window.waitForTimeout(500);
    await window.getByRole('button', { name: 'Refresh' }).click();

    // Wait until the IPC index sees the run, then make sure the row renders.
    await expect(async () => {
      const resp = (await window.evaluate(async () =>
        (globalThis as any).electron.ipcRenderer.invoke('data-get-test-runs'),
      )) as { runs?: Array<{ testName: string; status: string }> };
      const runs = resp?.runs ?? [];
      expect(runs.some((r) => r.testName === testName)).toBe(true);
    }).toPass({ timeout: 15000 });

    const row = window.locator('tr', { hasText: testName }).first();
    await expect(row).toBeVisible({ timeout: 5000 });

    // Status should be "Completed" before download.
    await expect(row.getByText('Completed')).toBeVisible({ timeout: 5000 });

    // ── 9. Click the UI Download button and wait for "Downloaded" ─────
    await row.getByRole('button', { name: 'Download test data' }).click();

    // Status flips to "Downloaded" once the CSV is written + state updates.
    await expect(row.getByText('Downloaded')).toBeVisible({ timeout: 30_000 });

    // ── 10. Verify CSV file exists in app test-runs directory ─────────
    const testRunsDir = (await window.evaluate(async () =>
      (globalThis as any).electron.ipcRenderer.invoke('data-get-test-runs-dir'),
    )) as string;
    const csvPath = path.join(testRunsDir, `${testName}.csv`);
    expect(fs.existsSync(csvPath)).toBe(true);
    expect(fs.statSync(csvPath).size).toBeGreaterThan(0);

    // ── 11. Click View → assert viewer renders ─────────────────────────
    await row.getByRole('button', { name: 'View test data' }).click();

    // Test-name heading
    await expect(
      window.getByRole('heading', { name: testName, level: 4 }),
    ).toBeVisible({ timeout: 10_000 });

    // Profile info cards
    await expect(window.getByRole('heading', { name: 'Sample Profile' })).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Motion Profile' })).toBeVisible();

    // Position vs Time chart heading
    await expect(
      window.getByText('Position vs Time (Actual vs Expected)'),
    ).toBeVisible({ timeout: 5000 });

    // Stress-Strain chart heading (will be either chart or "no data" — the heading
    // itself is always rendered when the run is downloaded).
    await expect(window.getByRole('heading', { name: 'Stress-Strain' })).toBeVisible();

    // Expected-G-code baseline testid carries finite anchor data.
    const baselineText = await window.getByTestId('expected-gcode-baseline').textContent();
    expect(baselineText).toBeTruthy();
    const parsed = JSON.parse(baselineText || '{}') as {
      initialSampleMm: number;
      expectedStartMm: number | null;
    };
    expect(Number.isFinite(parsed.initialSampleMm)).toBe(true);
    expect(parsed.expectedStartMm).not.toBeNull();
    expect(Number.isFinite(parsed.expectedStartMm as number)).toBe(true);

    // ── 12. Parse the downloaded CSV and validate content ─────────────
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    const { header, data } = parseCSV(csvContent);
    expect(header).toBe('time_us,force_mN,position_um,setpoint_um');
    expect(data.length).toBeGreaterThan(100);

    // Timestamps monotonic
    for (let i = 1; i < data.length; i++) {
      expect(data[i].time_us).toBeGreaterThanOrEqual(data[i - 1].time_us);
    }

    // All fields finite
    for (const sample of data) {
      expect(Number.isFinite(sample.time_us)).toBe(true);
      expect(Number.isFinite(sample.force_mN)).toBe(true);
      expect(Number.isFinite(sample.position_um)).toBe(true);
      expect(Number.isFinite(sample.setpoint_um)).toBe(true);
    }

    // Trajectory: peak ~15mm, returns near zero
    const positions_mm = data.map((s) => s.position_um / 1000);
    const maxPosition_mm = Math.max(...positions_mm);
    const finalPosition_mm = positions_mm[positions_mm.length - 1];
    expect(maxPosition_mm).toBeGreaterThan(10);
    expect(maxPosition_mm).toBeLessThan(20);
    expect(Math.abs(finalPosition_mm)).toBeLessThanOrEqual(5);

    // Setpoint also reaches ~15mm
    const setpoints_mm = data.map((s) => s.setpoint_um / 1000);
    const maxSetpoint_mm = Math.max(...setpoints_mm);
    expect(maxSetpoint_mm).toBeGreaterThan(10);
    expect(maxSetpoint_mm).toBeLessThan(20);

    // Duration sanity check
    const firstTime = data[0].time_us;
    const lastTime = data[data.length - 1].time_us;
    const durationMs = (lastTime - firstTime) / 1000;
    expect(durationMs).toBeGreaterThan(3000);
    expect(durationMs).toBeLessThan(30000);
  });
});
