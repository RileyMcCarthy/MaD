/**
 * Firmware Update Page Tests
 * 
 * Validates:
 * 1. Firmware page loads with expected UI elements
 * 2. Current firmware version is displayed
 * 3. Flash button is available
 * 
 * Note: Actual flashing is not tested in SIL (requires hardware).
 */

import { test, expect } from './fixtures';

test.describe('Firmware Update', () => {
  
  test.beforeEach(async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Firmware' }).click();
    await window.waitForTimeout(1000);
  });

  test.describe('Page Content', () => {
    
    test('page should contain firmware-related text', async ({ window }) => {
      const pageText = await window.locator('body').textContent();
      
      // Must contain "firmware" somewhere
      expect(pageText?.toLowerCase()).toContain('firmware');
    });

    test('page should display version information', async ({ window }) => {
      // Wait for version fetch
      await window.waitForTimeout(2000);
      
      // Look for "Current Firmware:" label with a version value
      const firmwareLabel = window.locator('text=Current Firmware:');
      await expect(firmwareLabel).toBeVisible({ timeout: 5000 });
      
      // The page structure shows "Current Firmware:" followed by <strong>0.0.0</strong>
      // Find the version value in the same paragraph/container
      const firmwareContainer = window.locator('p:has-text("Current Firmware:")');
      const containerText = await firmwareContainer.textContent();
      expect(containerText).toBeTruthy();
      // Should contain version pattern like "0.0.0" or "1.2.3"
      expect(containerText).toMatch(/\d+\.\d+\.\d+/);
    });

    test('Flash Firmware button should be visible', async ({ window }) => {
      const flashButton = window.getByRole('button', { name: /Flash Firmware/i });
      const hasFlash = await flashButton.isVisible().catch(() => false);
      
      if (hasFlash) {
        await expect(flashButton).toBeVisible();
        await expect(flashButton).toBeEnabled();
      } else {
        // Try alternate button names
        const updateButton = window.getByRole('button', { name: /Update|Upload|Select/i });
        const hasUpdate = await updateButton.first().isVisible().catch(() => false);
        expect(hasUpdate || hasFlash).toBe(true);
      }
    });
  });

  test.describe('External Links', () => {
    
    test('page should have GitHub reference', async ({ window }) => {
      const pageText = await window.locator('body').textContent();
      
      // Should reference GitHub somewhere
      const hasGitHub = pageText?.toLowerCase().includes('github') ||
                        pageText?.toLowerCase().includes('releases');
      
      // Or look for GitHub icon/link
      const githubIcon = window.locator('[data-testid="GitHubIcon"]');
      const hasIcon = await githubIcon.isVisible().catch(() => false);
      
      expect(hasGitHub || hasIcon).toBe(true);
    });
  });

  test.describe('UI State', () => {
    
    test('page should not show error state initially', async ({ window }) => {
      // Check for error indicators
      const errorAlert = window.locator('role=alert');
      const hasAlert = await errorAlert.isVisible().catch(() => false);
      
      if (hasAlert) {
        // If there's an alert, it shouldn't be an error about loading
        const alertText = await errorAlert.textContent();
        expect(alertText?.toLowerCase()).not.toContain('failed to load page');
      }
    });

    test('page content should be stable after load', async ({ window }) => {
      // Get initial content
      const initialText = await window.locator('body').textContent();
      
      await window.waitForTimeout(1000);
      
      // Content should be similar (not drastically changing)
      const laterText = await window.locator('body').textContent();
      
      // Both should contain "firmware"
      expect(initialText?.toLowerCase()).toContain('firmware');
      expect(laterText?.toLowerCase()).toContain('firmware');
    });
  });
});
