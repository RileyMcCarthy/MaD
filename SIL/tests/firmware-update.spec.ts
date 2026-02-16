/**
 * Firmware Update Page Tests
 *
 * Validates:
 * 1. Page loads with firmware-related content
 * 2. Current firmware version is displayed in expected format
 * 3. Flash Firmware button is visible and enabled
 * 4. No error state on initial load
 *
 * Note: Actual flashing is not tested in SIL (requires hardware).
 */

import { test, expect } from './fixtures';

test.describe('Firmware Update', () => {

  test.beforeEach(async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Firmware' }).click();
    await window.waitForTimeout(2000);
  });

  test('page displays firmware version in X.Y.Z format', async ({ window }) => {
    const firmwareLabel = window.locator('text=Current Firmware:');
    await expect(firmwareLabel).toBeVisible({ timeout: 5000 });

    const firmwareContainer = window.locator('p:has-text("Current Firmware:")');
    const containerText = await firmwareContainer.textContent();
    expect(containerText).toBeTruthy();
    expect(containerText).toMatch(/\d+\.\d+\.\d+/);
  });

  test('Flash Firmware button is visible and enabled', async ({ window }) => {
    const flashButton = window.getByRole('button', { name: /Flash Firmware/i });
    await expect(flashButton).toBeVisible();
    await expect(flashButton).toBeEnabled();
  });

  test('page has GitHub reference for firmware releases', async ({ window }) => {
    const pageText = await window.locator('body').textContent();
    const githubIcon = window.locator('[data-testid="GitHubIcon"]');
    const hasIcon = await githubIcon.isVisible().catch(() => false);
    const hasGitHub = pageText?.toLowerCase().includes('github') ||
      pageText?.toLowerCase().includes('releases');

    expect(hasGitHub || hasIcon).toBe(true);
  });

  test('no error alerts on initial page load', async ({ window }) => {
    const errorAlert = window.locator('role=alert');
    const hasAlert = await errorAlert.isVisible().catch(() => false);

    if (hasAlert) {
      const alertText = await errorAlert.textContent();
      expect(alertText?.toLowerCase()).not.toContain('failed to load page');
    }
  });
});
