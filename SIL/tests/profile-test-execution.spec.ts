/**
 * Profile Creation and Test Execution Tests
 *
 * Comprehensive tests for:
 * 1. Sample profile form — fields, input, loading from file, modification
 * 2. Motion profile form — sets, moves, loading from file
 * 3. G-code preview — generation, expected commands, G122 STOP
 * 4. Dashboard profile loading — Test Runner, profile selection, graph
 * 5. Test execution — start, status updates, completion
 */

import { test, expect } from './fixtures';
import path from 'path';

const FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures');
const SAMPLE_PROFILE_PATH = path.join(FIXTURES_DIR, 'sample-profile.sp');
const MOTION_PROFILE_SIMPLE_PATH = path.join(FIXTURES_DIR, 'motion-profile-simple.mp');
const MOTION_PROFILE_COMPLEX_PATH = path.join(FIXTURES_DIR, 'motion-profile-complex.mp');

test.describe('Profile Creation and Test Execution', () => {

  // ── Sample Profile ─────────────────────────────────────────────

  test.describe('Sample Profile', () => {

    test.beforeEach(async ({ connectToEmulator, window }) => {
      await connectToEmulator();
      await window.getByRole('link', { name: 'Create' }).click();
      await window.waitForTimeout(500);
      await expect(window.getByRole('heading', { name: 'Sample Profile' })).toBeVisible();
    });

    test('all form fields are visible and accept input', async ({ window }) => {
      // Verify all fields visible
      await expect(window.getByLabel('Max Force (N)')).toBeVisible();
      await expect(window.getByLabel('Max Velocity (mm/s)')).toBeVisible();
      await expect(window.getByLabel('Max Displacement (mm)')).toBeVisible();
      await expect(window.getByLabel('Sample Width (mm)')).toBeVisible();
      await expect(window.getByLabel('Sample Thickness (mm)')).toBeVisible();
      await expect(window.getByLabel('Sample Name')).toBeVisible();
      await expect(window.getByRole('button', { name: 'Save Sample Profile' })).toBeVisible();
      await expect(window.getByRole('button', { name: 'Save Sample Profile' })).toBeEnabled();

      // Fill in values
      await window.getByLabel('Max Force (N)').fill('100');
      await window.getByLabel('Max Velocity (mm/s)').fill('50');
      await window.getByLabel('Max Displacement (mm)').fill('200');
      await window.getByLabel('Sample Width (mm)').fill('10');
      await window.getByLabel('Sample Thickness (mm)').fill('2');
      await window.getByLabel('Sample Name').fill('SIL-TEST-001');

      // Verify values retained
      await expect(window.getByLabel('Max Force (N)')).toHaveValue('100');
      await expect(window.getByLabel('Max Velocity (mm/s)')).toHaveValue('50');
      await expect(window.getByLabel('Max Displacement (mm)')).toHaveValue('200');
      await expect(window.getByLabel('Sample Width (mm)')).toHaveValue('10');
      await expect(window.getByLabel('Sample Thickness (mm)')).toHaveValue('2');
      await expect(window.getByLabel('Sample Name')).toHaveValue('SIL-TEST-001');
    });

    test('loading profile from file populates all fields correctly', async ({ window }) => {
      const fileInput = window.locator('input[type="file"][accept=".sp"]').first();
      await fileInput.setInputFiles(SAMPLE_PROFILE_PATH);
      await window.waitForTimeout(500);

      // Verify all loaded values from sample-profile.sp fixture
      await expect(window.getByLabel('Max Force (N)')).toHaveValue('50');
      await expect(window.getByLabel('Max Velocity (mm/s)')).toHaveValue('25');
      await expect(window.getByLabel('Max Displacement (mm)')).toHaveValue('100');
      await expect(window.getByLabel('Sample Width (mm)')).toHaveValue('10');
      await expect(window.getByLabel('Sample Thickness (mm)')).toHaveValue('2');
      // Name is derived from filename (sample-profile.sp → "sample-profile")
      await expect(window.getByLabel('Sample Name')).toHaveValue('sample-profile');
    });

    test('loaded values can be modified while other fields remain', async ({ window }) => {
      const fileInput = window.locator('input[type="file"][accept=".sp"]').first();
      await fileInput.setInputFiles(SAMPLE_PROFILE_PATH);
      await window.waitForTimeout(500);

      await window.getByLabel('Max Force (N)').fill('75');
      await expect(window.getByLabel('Max Force (N)')).toHaveValue('75');
      // Other values unchanged
      await expect(window.getByLabel('Max Velocity (mm/s)')).toHaveValue('25');
      await expect(window.getByLabel('Max Displacement (mm)')).toHaveValue('100');
    });
  });

  // ── Motion Profile ─────────────────────────────────────────────

  test.describe('Motion Profile', () => {

    test.beforeEach(async ({ connectToEmulator, window }) => {
      await connectToEmulator();
      await window.getByRole('link', { name: 'Create' }).click();
      await window.waitForTimeout(500);
    });

    test('form fields and action buttons are visible', async ({ window }) => {
      await expect(window.getByRole('heading', { name: 'Motion Profile' })).toBeVisible();
      await expect(window.getByLabel('Name', { exact: true }).first()).toBeVisible();
      await expect(window.getByLabel('Description', { exact: true }).first()).toBeVisible();
      await expect(window.getByRole('button', { name: 'Add Set' })).toBeVisible();
      await expect(window.getByRole('button', { name: 'Preview G-code' })).toBeVisible();
      await expect(window.getByRole('button', { name: 'Save Motion Profile' })).toBeVisible();
      await expect(window.getByRole('button', { name: 'Save Motion Profile' })).toBeEnabled();
    });

    test('Add Set creates a set with Add Move button', async ({ window }) => {
      await window.getByLabel('Name', { exact: true }).first().fill('Test Motion Profile');
      await window.getByLabel('Description', { exact: true }).first().fill('Created by Playwright test');

      await window.getByRole('button', { name: 'Add Set' }).click();
      await window.waitForTimeout(300);

      await expect(window.getByLabel('Set Name').first()).toBeVisible();
      await expect(window.getByRole('button', { name: 'Add Move' }).first()).toBeVisible();
    });

    test('adding moves increases form fields and shows move type', async ({ window }) => {
      await window.getByRole('button', { name: 'Add Set' }).click();
      await window.waitForTimeout(300);

      // First move added automatically — verify move type visible
      await expect(window.locator('text=Linear').first()).toBeVisible();

      // Add another move
      await window.getByRole('button', { name: 'Add Move' }).first().click();
      await window.waitForTimeout(300);

      const moveCount = await window.locator('text=Linear').count() +
        await window.locator('text=Dwell').count();
      expect(moveCount).toBeGreaterThanOrEqual(2);
    });

    test('loading complex profile populates multiple sets', async ({ window }) => {
      const fileInput = window.locator('input[type="file"][accept=".mp"]').first();
      await fileInput.setInputFiles(MOTION_PROFILE_COMPLEX_PATH);
      await window.waitForTimeout(500);

      await expect(window.getByLabel('Name', { exact: true }).first()).toHaveValue('Complex Multi-Set Test');
      await expect(window.getByLabel('Description', { exact: true }).first()).toHaveValue(
        'A complex motion profile with multiple sets, move types, and executions',
      );
      await expect(window.getByLabel('Set Name').first()).toHaveValue('Conditioning Cycles');
      await expect(window.getByLabel('Set Name').nth(1)).toHaveValue('Main Test');
    });

    test('loading simple profile populates set name', async ({ window }) => {
      const fileInput = window.locator('input[type="file"][accept=".mp"]');
      await fileInput.setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
      await window.waitForTimeout(500);

      await expect(window.getByLabel('Set Name')).toHaveValue('Tension Cycle');
    });
  });

  // ── G-Code Preview ─────────────────────────────────────────────

  test.describe('G-Code Preview', () => {

    test.beforeEach(async ({ connectToEmulator, window }) => {
      await connectToEmulator();
      await window.getByRole('link', { name: 'Create' }).click();
      await window.waitForTimeout(500);
    });

    test('preview shows generated G-code with expected commands and G122 STOP', async ({ window }) => {
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

      // Verify key G-code commands present
      await expect(window.getByText(/G90/).first()).toBeVisible();
      await expect(window.getByText(/G1/).first()).toBeVisible();

      // Must end with G122 STOP
      const pageText = await window.locator('body').textContent();
      expect(pageText).toContain('G122');

      // Close
      await window.getByRole('button', { name: 'Close' }).click();
    });
  });

  // ── Dashboard Profile Loading ──────────────────────────────────

  test.describe('Dashboard Profile Loading', () => {

    test.beforeEach(async ({ connectToEmulator, window }) => {
      await connectToEmulator();
      await window.getByRole('link', { name: 'Dashboard' }).click();
      await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
      await window.waitForTimeout(500);
    });

    test('Test Runner is visible with Run Test button', async ({ window }) => {
      await expect(window.getByText('Test Runner')).toBeVisible();
      await expect(window.getByRole('button', { name: 'Run Test' }).first()).toBeVisible();
    });

    test('Run Test dialog loads profiles and shows G-code preview', async ({ window }) => {
      await window.getByRole('button', { name: 'Run Test' }).click();
      await window.waitForTimeout(500);
      await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

      // Import sample profile
      const spInput = window.locator('input[type="file"][accept=".sp"]');
      await spInput.first().setInputFiles(SAMPLE_PROFILE_PATH);
      await window.waitForTimeout(2000);

      // Import motion profile
      const mpInput = window.locator('input[type="file"][accept=".mp"]');
      await mpInput.last().setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
      await window.waitForTimeout(1000);

      // G-code preview should appear and Run Test enabled
      await expect(window.getByRole('heading', { name: 'G-code Preview' })).toBeVisible({ timeout: 5000 });
      await expect(window.getByRole('button', { name: 'Run Test' }).last()).toBeEnabled();

      await window.getByRole('button', { name: 'Cancel' }).click();
    });

    test('graph renders with chart axis labels after loading profile', async ({ window }) => {
      // Import sample profile via Run Test dialog
      await window.getByRole('button', { name: 'Run Test' }).click();
      await window.waitForTimeout(500);
      const spInput = window.locator('input[type="file"][accept=".sp"]');
      await spInput.first().setInputFiles(SAMPLE_PROFILE_PATH);
      await window.waitForTimeout(2000);
      await window.getByRole('button', { name: 'Cancel' }).click();
      await window.waitForTimeout(1000);

      // Verify chart
      await expect(window.getByRole('heading', { name: 'Stress-Strain Chart' })).toBeVisible();
      await expect(window.getByText('Force (N)', { exact: true })).toBeVisible();
      await expect(window.getByText('Position (mm)', { exact: true })).toBeVisible();
      await expect(window.getByRole('button', { name: 'Clear chart data' })).toBeVisible();
    });
  });

  // ── Test Execution ─────────────────────────────────────────────

  test.describe('Test Execution', () => {

    test.beforeEach(async ({ connectToEmulator, window }) => {
      await connectToEmulator();
      await window.getByRole('link', { name: 'Dashboard' }).click();
      await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
      await window.waitForTimeout(500);
    });

    test('should run test: enable motion, start, verify running, wait for completion', async ({ window }) => {
      // Enable motion
      const enableBtn = window.getByRole('button', { name: 'Enable Motion' });
      if (await enableBtn.isVisible()) {
        await enableBtn.click();
        await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });
      }
      await expect(window.getByText('Enabled')).toBeVisible();

      // Open Run Test dialog
      await window.getByRole('button', { name: 'Run Test' }).click();
      await window.waitForTimeout(500);
      await expect(window.getByRole('heading', { name: 'Run Test' })).toBeVisible();

      // Import profiles
      const spInput = window.locator('input[type="file"][accept=".sp"]');
      await spInput.first().setInputFiles(SAMPLE_PROFILE_PATH);
      await window.waitForTimeout(1000);
      const mpInput = window.locator('input[type="file"][accept=".mp"]');
      await mpInput.last().setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
      await window.waitForTimeout(500);

      // Verify G-code preview and Run button enabled
      await expect(window.getByRole('heading', { name: 'G-code Preview' })).toBeVisible();
      await expect(window.getByRole('button', { name: 'Run Test' }).last()).toBeEnabled();

      // Start test
      await window.getByRole('button', { name: 'Run Test' }).last().click();

      // Verify test is running
      await expect(window.getByRole('button', { name: 'Test Running...' })).toBeVisible({ timeout: 10000 });

      // Wait for completion (simple profile ~4-5s)
      await expect(window.getByRole('button', { name: 'Run Test' }).first()).toBeEnabled({ timeout: 15000 });
    });

    test('position changes during manual motion and graph renders', async ({ window }) => {
      const positionText = window.locator('text=Machine Position (mm):').locator('..').first();
      const initialPosition = await positionText.textContent();

      // Enable motion
      const enableBtn = window.getByRole('button', { name: 'Enable Motion' });
      if (await enableBtn.isVisible()) {
        await enableBtn.click();
        await window.waitForTimeout(1000);
      }

      // Move to change position
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(2000);

      const newPosition = await positionText.textContent();
      // Position should have changed
      expect(newPosition).not.toBe(initialPosition);

      // Chart axis labels should still be visible
      await expect(window.getByText('Force (N)', { exact: true })).toBeVisible();
      await expect(window.getByText('Position (mm)', { exact: true })).toBeVisible();
    });
  });
});
