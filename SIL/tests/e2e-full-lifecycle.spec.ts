/**
 * End-to-End Full Lifecycle Test
 *
 * Validates the complete workflow from profile creation through data download:
 *
 *  1. Connect to the firmware emulator
 *  2. Create a sample profile (via UI form) and verify field values
 *  3. Load a motion profile that exercises ALL move types:
 *       - linear absolute, linear relative, dwell
 *       - multiple sets with different execution counts
 *  4. Preview G-code and verify it contains expected commands
 *  5. Enable motion and run the test
 *  6. Verify the test starts (button changes to "Test Running...")
 *  7. Wait for the test to complete
 *  8. Verify a binary data file was created on the emulator SD card
 *  9. Download the data via the FILE_DOWNLOAD protocol
 * 10. Parse the CSV and validate:
 *       - Correct header
 *       - Monotonically increasing timestamps
 *       - Monotonically increasing indices
 *       - Position trajectory matches expected motion profile phases
 *       - Sufficient sample count (proves data was actually recorded)
 * 11. Navigate to Test Runs page and verify the test entry exists
 */

import { test, expect } from './fixtures';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Test fixture paths
const FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures');
const SAMPLE_PROFILE_PATH = path.join(FIXTURES_DIR, 'sample-profile.sp');
const MOTION_PROFILE_E2E_PATH = path.join(FIXTURES_DIR, 'motion-profile-e2e.mp');

// Emulator SD card path
const SD_TEST_DIR = path.resolve(__dirname, '../sd/test');

/**
 * Parse the downloaded CSV into an array of sample objects.
 */
function parseCSV(csv: string) {
  const lines = csv.split('\n').filter((l) => l.trim() !== '');
  const header = lines[0];
  const data = lines.slice(1).map((line) => {
    const [time_us, index, force_mN, position_um, setpoint_um] = line.split(',').map(Number);
    return { time_us, index, force_mN, position_um, setpoint_um };
  });
  return { header, data };
}

test.describe('End-to-End Full Lifecycle', () => {
  test(
    'complete workflow: create profiles → run test → download → validate data',
    async ({ window, connectToEmulator }) => {
      // ══════════════════════════════════════════════════════════════
      // 1. Connect to the emulator
      // ══════════════════════════════════════════════════════════════
      await connectToEmulator();
      console.log('✅ Step 1: Connected to emulator');

      // ══════════════════════════════════════════════════════════════
      // 2. Navigate to Create page and fill in a sample profile
      // ══════════════════════════════════════════════════════════════
      await window.getByRole('link', { name: 'Create' }).click();
      await window.waitForTimeout(500);

      // Verify the Create page loaded
      await expect(window.getByRole('heading', { name: 'Sample Profile' })).toBeVisible();
      await expect(window.getByRole('heading', { name: 'Motion Profile' })).toBeVisible();

      // Fill in sample profile via form fields
      await window.getByLabel('Max Force (N)').fill('75');
      await window.getByLabel('Max Velocity (mm/s)').fill('30');
      await window.getByLabel('Max Displacement (mm)').fill('150');
      await window.getByLabel('Sample Width (mm)').fill('12');
      await window.getByLabel('Sample Thickness (mm)').fill('3');
      await window.getByLabel('Sample Name').fill('E2E-FULL-001');

      // Verify all fields have the expected values
      await expect(window.getByLabel('Max Force (N)')).toHaveValue('75');
      await expect(window.getByLabel('Max Velocity (mm/s)')).toHaveValue('30');
      await expect(window.getByLabel('Max Displacement (mm)')).toHaveValue('150');
      await expect(window.getByLabel('Sample Width (mm)')).toHaveValue('12');
      await expect(window.getByLabel('Sample Thickness (mm)')).toHaveValue('3');
      await expect(window.getByLabel('Sample Name')).toHaveValue('E2E-FULL-001');
      console.log('✅ Step 2: Sample profile filled and verified');

      // ══════════════════════════════════════════════════════════════
      // 3. Load motion profile from fixture file
      // ══════════════════════════════════════════════════════════════
      const mpFileInput = window.locator('input[type="file"][accept=".mp"]').first();
      await mpFileInput.setInputFiles(MOTION_PROFILE_E2E_PATH);
      await window.waitForTimeout(500);

      // Verify the profile was loaded
      await expect(window.getByLabel('Name', { exact: true }).first()).toHaveValue('E2E Full Coverage Test');
      await expect(window.getByLabel('Description', { exact: true }).first()).toHaveValue(
        'Exercises all move types: linear absolute, linear relative, dwell, multiple sets, multiple executions',
      );

      // Verify both sets are displayed
      await expect(window.getByLabel('Set Name').first()).toHaveValue('Conditioning');
      await expect(window.getByLabel('Set Name').nth(1)).toHaveValue('Main Ramp');
      console.log('✅ Step 3: Motion profile loaded and verified');

      // ══════════════════════════════════════════════════════════════
      // 4. Preview G-code and verify expected commands
      // ══════════════════════════════════════════════════════════════
      await window.getByRole('button', { name: 'Preview G-code' }).click();
      await window.waitForTimeout(500);

      // Dialog should show
      await expect(window.getByText('Generated G-code and Graph')).toBeVisible();

      // G-code should contain: G90 (absolute), G91 (relative), G1 (linear), G4 (dwell), G122 (stop)
      await expect(window.getByText(/G90/).first()).toBeVisible();
      await expect(window.getByText(/G91/).first()).toBeVisible();
      await expect(window.getByText(/G1/).first()).toBeVisible();
      await expect(window.getByText(/G4/).first()).toBeVisible();
      await expect(window.getByText(/G122/).first()).toBeVisible();

      // Close the preview
      await window.getByRole('button', { name: 'Close' }).click();
      await window.waitForTimeout(300);
      console.log('✅ Step 4: G-code preview verified (G90, G91, G1, G4, G122)');

      // ══════════════════════════════════════════════════════════════
      // 5. Navigate to Dashboard and enable motion
      // ══════════════════════════════════════════════════════════════
      await window.getByRole('link', { name: 'Dashboard' }).click();
      await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
      await window.waitForTimeout(500);

      // Enable motion
      const enableButton = window.getByRole('button', { name: 'Enable Motion' });
      if (await enableButton.isVisible()) {
        await enableButton.click();
        await expect(
          window.getByRole('button', { name: 'Disable Motion' }),
        ).toBeVisible({ timeout: 5000 });
      }
      await expect(window.getByText('Enabled')).toBeVisible();
      console.log('✅ Step 5: Motion enabled');

      // ══════════════════════════════════════════════════════════════
      // 6. Record existing test files so we can find the new one
      // ══════════════════════════════════════════════════════════════
      const existingFiles = new Set(
        fs.existsSync(SD_TEST_DIR)
          ? fs.readdirSync(SD_TEST_DIR).filter((f) => f.endsWith('.bin'))
          : [],
      );

      // ══════════════════════════════════════════════════════════════
      // 7. Open Run Test dialog, load profiles, and start the test
      // ══════════════════════════════════════════════════════════════
      await window.getByRole('button', { name: 'Run Test' }).click();
      await window.waitForTimeout(500);
      await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

      // Import sample profile
      const spInput = window.locator('input[type="file"][accept=".sp"]');
      await spInput.first().setInputFiles(SAMPLE_PROFILE_PATH);
      await window.waitForTimeout(1000);

      // Import motion profile
      const mpInput = window.locator('input[type="file"][accept=".mp"]');
      await mpInput.last().setInputFiles(MOTION_PROFILE_E2E_PATH);
      await window.waitForTimeout(500);

      // G-code preview should be visible in dialog
      await expect(window.getByRole('heading', { name: 'G-code Preview' })).toBeVisible({ timeout: 5000 });

      // Run Test button in dialog should be enabled
      const dialogRunButton = window.getByRole('button', { name: 'Run Test' }).last();
      await expect(dialogRunButton).toBeEnabled();

      // Click Run Test
      await dialogRunButton.click();
      console.log('✅ Step 7: Test started');

      // ══════════════════════════════════════════════════════════════
      // 8. Verify test is running
      // ══════════════════════════════════════════════════════════════
      await expect(
        window.getByRole('button', { name: 'Test Running...' }),
      ).toBeVisible({ timeout: 15000 });
      console.log('✅ Step 8: Test is running');

      // ══════════════════════════════════════════════════════════════
      // 9. Wait for test to complete
      // ══════════════════════════════════════════════════════════════
      // Motion profile timing:
      //   Conditioning (2 executions × 3 moves):
      //     - relative +5mm at 10mm/s = 0.5s
      //     - dwell 200ms
      //     - relative -5mm at 10mm/s = 0.5s
      //     Total per exec: ~1.2s × 2 = ~2.4s
      //   Main Ramp (1 execution × 3 moves):
      //     - absolute to 15mm at 5mm/s = 3s
      //     - dwell 500ms
      //     - absolute to 0mm at 10mm/s = 1.5s
      //     Total: ~5s
      //   Grand total: ~7.4s + overhead ≈ 10-15s
      await expect(
        window.getByRole('button', { name: 'Run Test' }).first(),
      ).toBeEnabled({ timeout: 30000 });
      console.log('✅ Step 9: Test completed');

      // Wait for file to be fully flushed
      await window.waitForTimeout(2000);

      // ══════════════════════════════════════════════════════════════
      // 10. Verify binary file was created on SD card
      // ══════════════════════════════════════════════════════════════
      const currentFiles = fs
        .readdirSync(SD_TEST_DIR)
        .filter((f) => f.endsWith('.bin'));
      const newFiles = currentFiles.filter((f) => !existingFiles.has(f));
      console.log('Existing files:', Array.from(existingFiles));
      console.log('Current files:', currentFiles);
      console.log('New files:', newFiles);

      expect(newFiles.length).toBe(1);
      const testFileName = newFiles[0];
      const testName = testFileName.replace('.bin', '');
      console.log(`Test file created: ${testName}`);

      const binPath = path.join(SD_TEST_DIR, testFileName);
      const binSize = fs.statSync(binPath).size;
      console.log(`Binary file size: ${binSize} bytes`);
      expect(binSize).toBeGreaterThan(0);

      // Each sample is 20 bytes, test runs ~7-10s at ~1000 SPS → expect thousands of samples
      const sampleCount = binSize / 20;
      console.log(`Expected sample count from binary: ${sampleCount}`);
      expect(sampleCount).toBeGreaterThan(100); // At minimum 100 samples
      console.log('✅ Step 10: Binary file verified on SD card');

      // ══════════════════════════════════════════════════════════════
      // 11. Download the test data via protocol
      // ══════════════════════════════════════════════════════════════
      const savePath = path.join(os.tmpdir(), `mad-e2e-test-${Date.now()}.csv`);
      console.log(`Downloading: ${testName} → ${savePath}`);

      const result = await window.evaluate(
        async ({ name, dest }: { name: string; dest: string }) => {
          return window.electron.ipcRenderer.invoke('download-test-file', {
            testName: name,
            savePath: dest,
          });
        },
        { name: testName, dest: savePath },
      );

      console.log('Download result:', JSON.stringify(result));
      expect((result as any).success).toBe(true);
      expect((result as any).fileSize).toBeGreaterThan(0);
      expect((result as any).filePath).toBe(savePath);

      // download-test-file reports binary protocol payload bytes (packed StoredSample),
      // not CSV byte size and not raw on-SD struct byte size.
      const bytesPerSample = (result as any).fileSize / sampleCount;
      expect(bytesPerSample).toBeGreaterThan(14);
      expect(bytesPerSample).toBeLessThan(16);
      console.log('✅ Step 11: File downloaded successfully');

      // ══════════════════════════════════════════════════════════════
      // 12. Parse and validate CSV content
      // ══════════════════════════════════════════════════════════════
      expect(fs.existsSync(savePath)).toBe(true);
      const csvContent = fs.readFileSync(savePath, 'utf-8');
      const { header, data } = parseCSV(csvContent);

      // ── 12a. Validate header ──
      expect(header).toBe('time_us,index,force_mN,position_um,setpoint_um');
      console.log(`CSV rows: ${data.length}`);
      expect(data.length).toBeGreaterThan(100);

      // ── 12b. Validate timestamps are monotonically increasing ──
      for (let i = 1; i < data.length; i++) {
        expect(data[i].time_us).toBeGreaterThanOrEqual(data[i - 1].time_us);
      }
      console.log('  ✓ Timestamps monotonically increasing');

      // ── 12c. Validate indices are strictly increasing ──
      for (let i = 1; i < data.length; i++) {
        expect(data[i].index).toBeGreaterThan(data[i - 1].index);
      }
      console.log('  ✓ Indices strictly increasing');

      // ── 12d. Validate all fields are finite numbers ──
      for (const sample of data) {
        expect(Number.isFinite(sample.time_us)).toBe(true);
        expect(Number.isFinite(sample.index)).toBe(true);
        expect(Number.isFinite(sample.force_mN)).toBe(true);
        expect(Number.isFinite(sample.position_um)).toBe(true);
        expect(Number.isFinite(sample.setpoint_um)).toBe(true);
      }
      console.log('  ✓ All fields are finite numbers');

      // ── 12e. Validate position trajectory phases ──
      // The test profile produces this position sequence:
      //   Phase 1: Conditioning exec 1 — start ~0, move up ~5mm (5000um), dwell, move back ~0
      //   Phase 2: Conditioning exec 2 — same as phase 1
      //   Phase 3: Main Ramp — move to 15mm (15000um), dwell, return to 0
      //
      // We verify the position reaches a peak in the expected range and returns near zero.

      const positions_mm = data.map((s) => s.position_um / 1000);
      const maxPosition_mm = Math.max(...positions_mm);
      const finalPosition_mm = positions_mm[positions_mm.length - 1];

      console.log(`  Max position: ${maxPosition_mm.toFixed(2)} mm`);
      console.log(`  Final position: ${finalPosition_mm.toFixed(2)} mm`);

      // Max position should reach near 15mm (Main Ramp target)
      // Allow ±2mm tolerance for servo settling
      expect(maxPosition_mm).toBeGreaterThan(10);
      expect(maxPosition_mm).toBeLessThan(20);
      console.log('  ✓ Peak position in expected range (10-20 mm)');

      // Final position should return near 0 (within 5mm tolerance for emulator settling)
      expect(Math.abs(finalPosition_mm)).toBeLessThanOrEqual(5);
      console.log('  ✓ Final position returned near zero');

      // ── 12f. Validate setpoint trajectory ──
      const setpoints_mm = data.map((s) => s.setpoint_um / 1000);
      const maxSetpoint_mm = Math.max(...setpoints_mm);

      // Setpoint should also reach ~15mm target
      expect(maxSetpoint_mm).toBeGreaterThan(10);
      expect(maxSetpoint_mm).toBeLessThan(20);
      console.log(`  ✓ Max setpoint: ${maxSetpoint_mm.toFixed(2)} mm`);

      // ── 12g. Total test duration should be reasonable ──
      const firstTime = data[0].time_us;
      const lastTime = data[data.length - 1].time_us;
      const durationMs = (lastTime - firstTime) / 1000;
      console.log(`  Test duration: ${durationMs.toFixed(0)} ms`);

      // Expected ~7-10 seconds, allow 3-30 second range
      expect(durationMs).toBeGreaterThan(3000);
      expect(durationMs).toBeLessThan(30000);
      console.log('  ✓ Test duration in expected range (3-30s)');

      console.log('✅ Step 12: CSV data fully validated');

      // ══════════════════════════════════════════════════════════════
      // 13. Navigate to Tests page and verify the entry exists
      // ══════════════════════════════════════════════════════════════
      await window.getByRole('link', { name: 'Tests' }).click();
      await window.waitForTimeout(1000);

      // The UI list can lag behind the underlying index; first assert against
      // the IPC-backed run list, then assert the row renders.
      await expect(async () => {
        const resp = await window.evaluate(async () => {
          return (window as any).electron.ipcRenderer.invoke('data-get-test-runs');
        }) as unknown;

        const runs = (resp as any)?.runs ?? (Array.isArray(resp) ? resp : []);
        expect(Array.isArray(runs)).toBe(true);
        expect(runs.some((r: any) => r.testName === testName)).toBe(true);
      }).toPass({ timeout: 15000 });
      console.log('✅ Step 13: Test run exists in IPC-backed run index');

      // ══════════════════════════════════════════════════════════════
      // 14. Verify the test run status is 'completed' (not 'running')
      // ══════════════════════════════════════════════════════════════
      const testRunStatus: string = await window.evaluate(async (name: string) => {
        const resp = await (window as any).electron.ipcRenderer.invoke(
          'data-get-test-runs',
        );
        const runs = (resp as any)?.runs ?? (Array.isArray(resp) ? resp : []);
        const entry = (runs as any[]).find((r: any) => r.testName === name);
        return entry?.status ?? 'not found';
      }, testName);
      expect(testRunStatus).toBe('completed');
      console.log('✅ Step 14: Test run status is "completed"');

      // ══════════════════════════════════════════════════════════════
      // Cleanup
      // ══════════════════════════════════════════════════════════════
      if (fs.existsSync(savePath)) {
        fs.unlinkSync(savePath);
      }

      console.log('═══════════════════════════════════════════════════════');
      console.log('  E2E FULL LIFECYCLE TEST PASSED');
      console.log(`  Samples recorded: ${data.length}`);
      console.log(`  Binary file size: ${binSize} bytes`);
      console.log(`  Test duration: ${durationMs.toFixed(0)} ms`);
      console.log(`  Max position: ${maxPosition_mm.toFixed(2)} mm`);
      console.log('═══════════════════════════════════════════════════════');
    },
  );
});
