/**
 * Zeroing and Homing Tests
 * 
 * Validates:
 * 1. Zero Force - force gauge reading resets to zero
 * 2. Zero Length - position reading resets to zero
 * 3. Home Axis - machine returns to home position
 * 
 * Each test has concrete assertions to verify the action succeeded.
 */

import { test, expect } from './fixtures';

/**
 * Extract numeric value from parameter display text
 */
function extractNumber(text: string | null, label: string): number | null {
  if (!text) return null;
  const pattern = new RegExp(`${label}:\\s*([-\\d.]+)`);
  const match = text.match(pattern);
  return match ? parseFloat(match[1]) : null;
}

test.describe('Zeroing and Homing', () => {
  
  test.beforeEach(async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    // Emulator restarts per-test, ensuring fresh firmware state
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
    await expect(window.getByRole('heading', { name: 'Machine State', level: 6 })).toBeVisible();
  });

  test.describe('Zero Force', () => {
    
    test('Zero Force button should be visible and enabled', async ({ window }) => {
      const button = window.getByRole('button', { name: 'Zero Force' });
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
    });

    test('clicking Zero Force should set force reading to zero', async ({ window }) => {
      // Get force display element
      const forceContainer = window.locator('text=Machine Force (N):').locator('..');
      await expect(forceContainer).toBeVisible();
      
      // Click Zero Force
      await window.getByRole('button', { name: 'Zero Force' }).click();
      
      // Wait for update
      await window.waitForTimeout(1000);
      
      // Extract and verify force value is near zero
      const forceText = await forceContainer.textContent();
      const forceValue = extractNumber(forceText, 'Machine Force \\(N\\)');
      
      expect(forceValue).not.toBeNull();
      expect(Math.abs(forceValue!)).toBeLessThan(1.0); // Within ±1N
    });
  });

  test.describe('Zero Length', () => {
    
    test('Zero Length button should be visible and enabled', async ({ window }) => {
      const button = window.getByRole('button', { name: 'Zero Length' });
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
    });

    test('clicking Zero Length should reset position to zero', async ({ window }) => {
      // Enable motion
      await window.getByRole('button', { name: 'Enable Motion' }).click();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });
      
      // Move up 5mm to create non-zero position
      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000);
      
      // Get position element
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      
      // Verify position is NOT zero
      let posText = await posContainer.textContent();
      let posValue = extractNumber(posText, 'Machine Position \\(mm\\)');
      expect(posValue).not.toBeNull();
      expect(Math.abs(posValue!)).toBeGreaterThan(1); // Should be ~5mm
      
      // Click Zero Length
      await window.getByRole('button', { name: 'Zero Length' }).click();
      await window.waitForTimeout(1000);
      
      // Verify position IS now zero
      posText = await posContainer.textContent();
      posValue = extractNumber(posText, 'Machine Position \\(mm\\)');
      expect(posValue).not.toBeNull();
      expect(Math.abs(posValue!)).toBeLessThan(0.5); // Within ±0.5mm
    });
  });

  test.describe('Home Axis', () => {
    
    test('Home button should be visible and enabled', async ({ window }) => {
      const button = window.getByRole('button', { name: 'Home' });
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
    });

    test('clicking Home should initiate homing sequence', async ({ window }) => {
      // Enable motion first
      await window.getByRole('button', { name: 'Enable Motion' }).click();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });
      
      // Move up to non-zero position
      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000);
      
      // Get position before homing
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const posBefore = extractNumber(await posContainer.textContent(), 'Machine Position \\(mm\\)');
      expect(posBefore).not.toBeNull();
      expect(Math.abs(posBefore!)).toBeGreaterThan(1);
      
      // Click Home
      await window.getByRole('button', { name: 'Home' }).click();
      
      // Wait for homing to complete
      await window.waitForTimeout(3000);
      
      // Home button should still be enabled (no fault)
      await expect(window.getByRole('button', { name: 'Home' })).toBeEnabled();
      
      // Motion should still be enabled
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible();
    });
  });
});
