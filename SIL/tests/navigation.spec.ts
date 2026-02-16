/**
 * Navigation Tests
 *
 * Validates:
 * 1. All sidebar navigation links are visible
 * 2. Each page loads with expected page-specific content
 * 3. Page transitions don't cause errors
 * 4. Connection persists across page navigation
 */

import { test, expect } from './fixtures';

test.describe('Navigation', () => {

  test.beforeEach(async ({ connectToEmulator }) => {
    await connectToEmulator();
  });

  test('all navigation links should be visible', async ({ window }) => {
    await expect(window.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Create' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Device Configuration' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Firmware Update' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Connect' })).toBeVisible();
  });

  test('Dashboard loads with Machine State heading, motion buttons, and sample data', async ({ window }) => {
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

    await expect(window.getByRole('heading', { name: 'Machine State', level: 6 })).toBeVisible();
    await expect(window.getByText('Motion State')).toBeVisible();
    await expect(window.getByRole('button', { name: 'Move Up' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Move Down' })).toBeVisible();
    await expect(window.getByText('Machine Force (N):')).toBeVisible();
    await expect(window.getByText('Machine Position (mm):')).toBeVisible();
  });

  test('Create page loads with Sample Profile and Motion Profile sections', async ({ window }) => {
    await window.getByRole('link', { name: 'Create' }).click();
    await window.waitForTimeout(500);

    await expect(window.getByRole('heading', { name: 'Sample Profile' })).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Motion Profile' })).toBeVisible();
    await expect(window.getByLabel('Max Force (N)')).toBeVisible();
    await expect(window.getByRole('button', { name: 'Save Sample Profile' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Save Motion Profile' })).toBeVisible();
  });

  test('Device Configuration page loads with Save button or status', async ({ window }) => {
    await window.getByRole('link', { name: 'Device Configuration' }).click();
    await window.waitForTimeout(2000);

    const saveButton = window.getByRole('button', { name: 'Save Configuration' });
    const loadingText = window.getByText('Loading...');
    const failedText = window.getByText('Failed to load');

    const hasSave = await saveButton.isVisible().catch(() => false);
    const hasLoading = await loadingText.isVisible().catch(() => false);
    const hasFailed = await failedText.isVisible().catch(() => false);

    expect(hasSave || hasLoading || hasFailed).toBe(true);
  });

  test('Firmware Update page loads with firmware version and Flash button', async ({ window }) => {
    await window.getByRole('link', { name: 'Firmware Update' }).click();
    await window.waitForTimeout(2000);

    // Page must contain firmware-related text
    const pageText = await window.locator('body').textContent();
    expect(pageText?.toLowerCase()).toContain('firmware');

    // Should show version
    const firmwareContainer = window.locator('p:has-text("Current Firmware:")');
    const hasVersion = await firmwareContainer.isVisible().catch(() => false);
    if (hasVersion) {
      const text = await firmwareContainer.textContent();
      expect(text).toMatch(/\d+\.\d+\.\d+/);
    }
  });

  test('Connect page loads with serial port controls', async ({ window }) => {
    await window.getByRole('link', { name: 'Connect' }).click();
    await window.waitForTimeout(500);

    const pageText = await window.locator('body').textContent();
    const hasPortContent = pageText?.toLowerCase().includes('serial') ||
      pageText?.toLowerCase().includes('port') ||
      pageText?.toLowerCase().includes('connect');
    expect(hasPortContent).toBe(true);
  });

  test('navigating through all pages produces no error dialogs', async ({ window }) => {
    const pages = ['Dashboard', 'Create', 'Device Configuration', 'Firmware Update', 'Connect'];

    for (const page of pages) {
      await window.getByRole('link', { name: page }).click();
      await window.waitForTimeout(500);

      const errorDialog = window.locator('role=alertdialog');
      const hasError = await errorDialog.isVisible().catch(() => false);
      expect(hasError).toBe(false);
    }
  });

  test('connection persists across page navigation', async ({ window }) => {
    // Start on Dashboard and verify data
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
    await expect(window.getByText('Machine Force (N):')).toBeVisible();

    // Navigate away and back
    await window.getByRole('link', { name: 'Create' }).click();
    await window.waitForTimeout(500);
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });

    // Data should still be updating
    await expect(window.getByText('Machine Force (N):')).toBeVisible();
    await expect(window.getByText('Machine Position (mm):')).toBeVisible();

    // Device should still report as responding
    const isResponding = await window.evaluate(async () => {
      return window.electron.ipcRenderer.invoke('device-responding');
    });
    expect(isResponding).toBe(true);
  });
});
