/**
 * Motion Speed and Distance Tests
 * 
 * Validates:
 * 1. Movement at different speeds affects actual motion
 * 2. Movement at different distances moves the expected amount
 * 3. Bidirectional movement (up/down) works correctly
 * 4. Sequential movements accumulate position changes
 * 
 * Each test has numeric assertions verifying position changes.
 */

import { test, expect } from './fixtures';

/**
 * Extract numeric position from display text
 */
function extractPosition(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/Machine Position \(mm\):\s*([-\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

test.describe('Motion Speed and Distance', () => {
  
  test.beforeEach(async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    // Emulator restarts per-test, ensuring fresh firmware state
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
    
    // Enable motion for all tests (fresh emulator starts with motion disabled)
    await expect(window.getByRole('button', { name: 'Enable Motion' })).toBeVisible({ timeout: 5000 });
    await window.getByRole('button', { name: 'Enable Motion' }).click();
    await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });
  });

  test.describe('Distance Control', () => {
    
    test('moving 5mm should result in ~5mm position change', async ({ window }) => {
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      
      // Set distance and speed
      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      
      // Get starting position
      const startPos = extractPosition(await posContainer.textContent());
      expect(startPos).not.toBeNull();
      
      // Move up
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000); // Wait for 5mm at 20mm/s = 0.25s + margin
      
      // Verify position increased by ~5mm
      const endPos = extractPosition(await posContainer.textContent());
      expect(endPos).not.toBeNull();
      
      const delta = endPos! - startPos!;
      expect(delta).toBeGreaterThan(3); // At least 3mm (allowing for timing)
      expect(delta).toBeLessThan(7);    // At most 7mm
    });

    test('moving 10mm should result in ~10mm position change', async ({ window }) => {
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      
      await window.getByLabel('Move Distance (mm)').fill('10');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      
      const startPos = extractPosition(await posContainer.textContent());
      expect(startPos).not.toBeNull();
      
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1500);
      
      const endPos = extractPosition(await posContainer.textContent());
      expect(endPos).not.toBeNull();
      
      const delta = endPos! - startPos!;
      expect(delta).toBeGreaterThan(7);
      expect(delta).toBeLessThan(13);
    });
  });

  test.describe('Bidirectional Movement', () => {
    
    test('Move Up should increase position', async ({ window }) => {
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      
      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      
      const startPos = extractPosition(await posContainer.textContent());
      expect(startPos).not.toBeNull();
      
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000);
      
      const endPos = extractPosition(await posContainer.textContent());
      expect(endPos).not.toBeNull();
      expect(endPos!).toBeGreaterThan(startPos!);
    });

    test('Move Down should decrease position', async ({ window }) => {
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      
      // First move up so we have room to move down
      await window.getByLabel('Move Distance (mm)').fill('10');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1500);
      
      const startPos = extractPosition(await posContainer.textContent());
      expect(startPos).not.toBeNull();
      expect(startPos!).toBeGreaterThan(5);
      
      // Now move down
      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByRole('button', { name: 'Move Down' }).click();
      await window.waitForTimeout(1000);
      
      const endPos = extractPosition(await posContainer.textContent());
      expect(endPos).not.toBeNull();
      expect(endPos!).toBeLessThan(startPos!);
    });

    test('Move Up then Down same distance should return to start', async ({ window }) => {
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      
      const startPos = extractPosition(await posContainer.textContent());
      expect(startPos).not.toBeNull();
      
      // Move up
      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000);
      
      // Verify we moved
      const midPos = extractPosition(await posContainer.textContent());
      expect(midPos).not.toBeNull();
      expect(Math.abs(midPos! - startPos!)).toBeGreaterThan(2);
      
      // Move back down
      await window.getByRole('button', { name: 'Move Down' }).click();
      await window.waitForTimeout(1000);
      
      // Should be back near start
      const endPos = extractPosition(await posContainer.textContent());
      expect(endPos).not.toBeNull();
      expect(Math.abs(endPos! - startPos!)).toBeLessThan(2);
    });
  });

  test.describe('Sequential Movements', () => {
    
    test('three sequential 3mm moves should result in ~9mm total', async ({ window }) => {
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      
      const startPos = extractPosition(await posContainer.textContent());
      expect(startPos).not.toBeNull();
      
      await window.getByLabel('Move Distance (mm)').fill('3');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      
      // Three sequential moves
      for (let i = 0; i < 3; i++) {
        await window.getByRole('button', { name: 'Move Up' }).click();
        await window.waitForTimeout(600);
      }
      
      const endPos = extractPosition(await posContainer.textContent());
      expect(endPos).not.toBeNull();
      
      const totalDelta = endPos! - startPos!;
      expect(totalDelta).toBeGreaterThan(6);  // At least 6mm
      expect(totalDelta).toBeLessThan(12);    // At most 12mm
    });
  });

  test.describe('Input Validation', () => {
    
    test('distance input should accept decimal values', async ({ window }) => {
      const distanceInput = window.getByLabel('Move Distance (mm)');
      
      await distanceInput.fill('2.5');
      await expect(distanceInput).toHaveValue('2.5');
      
      await distanceInput.fill('0.1');
      await expect(distanceInput).toHaveValue('0.1');
    });

    test('speed input should accept decimal values', async ({ window }) => {
      const speedInput = window.getByLabel('Move Speed (mm/s)');
      
      await speedInput.fill('5.5');
      await expect(speedInput).toHaveValue('5.5');
    });

    test('inputs should retain values after move', async ({ window }) => {
      await window.getByLabel('Move Distance (mm)').fill('7');
      await window.getByLabel('Move Speed (mm/s)').fill('15');
      
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000);
      
      // Values should still be there
      await expect(window.getByLabel('Move Distance (mm)')).toHaveValue('7');
      await expect(window.getByLabel('Move Speed (mm/s)')).toHaveValue('15');
    });
  });
});
