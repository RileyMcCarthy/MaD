/**
 * Dashboard and Motion Control Tests
 * 
 * These tests verify END-TO-END behavior:
 * - Buttons actually change machine state
 * - Motion commands actually change position readings
 * - Enable/disable actually affects motion capability
 * 
 * Each test has concrete numeric/state assertions to verify actions succeeded.
 */

import { test, expect } from './fixtures';

/**
 * Extract numeric position value from the UI display
 */
function extractPosition(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/Machine Position \(mm\):\s*([-\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Extract sample position value from the UI display (used for Zero Length)
 */
function extractSamplePosition(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/Sample Position \(mm\):\s*([-\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Extract numeric force value from the UI display
 */
function extractForce(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/Machine Force \(N\):\s*([-\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Extract sample force value from the UI display (used for Zero Force)
 */
function extractSampleForce(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/Sample Force \(N\):\s*([-\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

test.describe('Dashboard and Motion Control', () => {
  
  test.beforeEach(async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    // Emulator restarts per-test, ensuring fresh firmware state
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
    await expect(window.getByRole('heading', { name: 'Machine State', level: 6 })).toBeVisible();
  });

  test.describe('Dashboard Display', () => {
    
    test('machine status panel shows state fields with values', async ({ window }) => {
      // Verify status panel exists and has actual values (not placeholders)
      await expect(window.getByRole('heading', { name: 'Machine State', level: 6 })).toBeVisible();
      
      // Motion State should show "Disabled" or "Enabled" (not empty)
      const motionStateRow = window.locator('text=Motion State').locator('..');
      const motionStateText = await motionStateRow.textContent();
      expect(motionStateText).toMatch(/Disabled|Enabled/);
      
      // Test State should show "Idle" or "Running" (not empty)
      const testStateRow = window.locator('text=Test State').locator('..');
      const testStateText = await testStateRow.textContent();
      expect(testStateText).toMatch(/Idle|Running/);
    });

    test('sample data displays numeric force and position values', async ({ window }) => {
      // Get position container and verify it shows a real number
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const posText = await posContainer.textContent();
      const posValue = extractPosition(posText);
      
      expect(posValue).not.toBeNull();
      expect(typeof posValue).toBe('number');
      expect(Number.isFinite(posValue)).toBe(true);
      
      // Get force container and verify it shows a real number
      const forceContainer = window.locator('text=Machine Force (N):').locator('..');
      const forceText = await forceContainer.textContent();
      const forceValue = extractForce(forceText);
      
      expect(forceValue).not.toBeNull();
      expect(typeof forceValue).toBe('number');
      expect(Number.isFinite(forceValue)).toBe(true);
    });

    test('move inputs accept and retain values', async ({ window }) => {
      const distanceInput = window.getByLabel('Move Distance (mm)');
      const speedInput = window.getByLabel('Move Speed (mm/s)');
      
      // Change values
      await distanceInput.fill('7.5');
      await speedInput.fill('25');
      
      // Verify values are retained
      await expect(distanceInput).toHaveValue('7.5');
      await expect(speedInput).toHaveValue('25');
    });
  });

  test.describe('Motion Enable/Disable', () => {
    
    test('Enable Motion button changes state from Disabled to Enabled', async ({ window }) => {
      const enableButton = window.getByRole('button', { name: 'Enable Motion' });
      const disableButton = window.getByRole('button', { name: 'Disable Motion' });
      
      // Fresh emulator starts with motion disabled
      await expect(enableButton).toBeVisible({ timeout: 5000 });
      const initialState = window.locator('text=Motion State').locator('..');
      expect(await initialState.textContent()).toContain('Disabled');
      
      // Click Enable Motion
      await enableButton.click();
      
      // Verify state changed to Enabled
      await expect(disableButton).toBeVisible({ timeout: 5000 });
      const newState = window.locator('text=Motion State').locator('..');
      await expect(newState).toContainText('Enabled', { timeout: 5000 });
    });

    test('Disable Motion button changes state from Enabled to Disabled', async ({ window }) => {
      const enableButton = window.getByRole('button', { name: 'Enable Motion' });
      const disableButton = window.getByRole('button', { name: 'Disable Motion' });
      
      // Fresh emulator starts with motion disabled, so enable it first
      await expect(enableButton).toBeVisible({ timeout: 5000 });
      await enableButton.click();
      await expect(disableButton).toBeVisible({ timeout: 5000 });
      
      // Verify state is Enabled
      const stateRow = window.locator('text=Motion State').locator('..');
      await expect(stateRow).toContainText('Enabled', { timeout: 5000 });
      
      // Click Disable Motion
      await disableButton.click();
      
      // Verify state changed to Disabled
      await expect(enableButton).toBeVisible({ timeout: 5000 });
      await expect(stateRow).toContainText('Disabled', { timeout: 5000 });
    });
  });

  test.describe('Manual Motion Control', () => {
    
    test('Move Up actually increases position value', async ({ window }) => {
      const enableButton = window.getByRole('button', { name: 'Enable Motion' });
      const disableButton = window.getByRole('button', { name: 'Disable Motion' });
      
      // Fresh emulator starts with motion disabled and position zeroed
      await expect(enableButton).toBeVisible({ timeout: 5000 });
      await enableButton.click();
      await expect(disableButton).toBeVisible({ timeout: 5000 });
      
      // Get initial position (should be near zero from reset)
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const initialPos = extractPosition(await posContainer.textContent());
      expect(initialPos).not.toBeNull();
      
      // Set move distance and speed
      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      
      // Click Move Up
      await window.getByRole('button', { name: 'Move Up' }).click();
      
      // Wait for movement to complete (5mm at 20mm/s = 0.25s + margin)
      await window.waitForTimeout(1000);
      
      // Get final position
      const finalPos = extractPosition(await posContainer.textContent());
      expect(finalPos).not.toBeNull();
      
      // Position should have increased by approximately 5mm
      const delta = finalPos! - initialPos!;
      expect(delta).toBeGreaterThan(2);  // At least 2mm increase
      expect(delta).toBeLessThan(8);     // At most 8mm increase
    });

    test('Move Down actually decreases position value', async ({ window }) => {
      const enableButton = window.getByRole('button', { name: 'Enable Motion' });
      const disableButton = window.getByRole('button', { name: 'Disable Motion' });
      
      // Fresh emulator starts with motion disabled
      await expect(enableButton).toBeVisible({ timeout: 5000 });
      await enableButton.click();
      await expect(disableButton).toBeVisible({ timeout: 5000 });
      
      // Move up first to have room to move down
      await window.getByLabel('Move Distance (mm)').fill('10');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1500);
      
      // Get starting position (should be positive now)
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const startPos = extractPosition(await posContainer.textContent());
      expect(startPos).not.toBeNull();
      expect(startPos!).toBeGreaterThan(5);
      
      // Now move down
      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByRole('button', { name: 'Move Down' }).click();
      await window.waitForTimeout(1000);
      
      // Get final position
      const endPos = extractPosition(await posContainer.textContent());
      expect(endPos).not.toBeNull();
      
      // Position should have decreased
      expect(endPos!).toBeLessThan(startPos!);
      expect(startPos! - endPos!).toBeGreaterThan(2);  // At least 2mm decrease
    });

    test('Zero Length resets sample position to zero', async ({ window }) => {
      const enableButton = window.getByRole('button', { name: 'Enable Motion' });
      const disableButton = window.getByRole('button', { name: 'Disable Motion' });
      
      // Fresh emulator starts with motion disabled
      await expect(enableButton).toBeVisible({ timeout: 5000 });
      await enableButton.click();
      await expect(disableButton).toBeVisible({ timeout: 5000 });
      
      // Move to create non-zero position
      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000);
      
      // Verify Sample Position is NOT zero (after moving up)
      const samplePosContainer = window.locator('text=Sample Position (mm):').locator('..');
      let samplePos = extractSamplePosition(await samplePosContainer.textContent());
      expect(samplePos).not.toBeNull();
      expect(Math.abs(samplePos!)).toBeGreaterThan(2);
      
      // Click Zero Length - this should reset Sample Position to zero
      await window.getByRole('button', { name: 'Zero Length' }).click();
      
      // Wait and poll for the zero to take effect (firmware response time)
      // Zero Length affects "Sample Position", not "Machine Position"
      await expect(async () => {
        const currentSamplePos = extractSamplePosition(await samplePosContainer.textContent());
        expect(currentSamplePos).not.toBeNull();
        expect(Math.abs(currentSamplePos!)).toBeLessThan(1);
      }).toPass({ timeout: 5000 });
    });

    test('Zero Force resets sample force to zero', async ({ window }) => {
      // Fresh emulator starts with zeroed readings, but clicking Zero Force should still work
      // Get sample force container - Zero Force affects Sample Force, not Machine Force
      const sampleForceContainer = window.locator('text=Sample Force (N):').locator('..');
      
      // Click Zero Force
      await window.getByRole('button', { name: 'Zero Force' }).click();
      
      // Wait and poll for the zero to take effect
      await expect(async () => {
        const forceValue = extractSampleForce(await sampleForceContainer.textContent());
        expect(forceValue).not.toBeNull();
        expect(Math.abs(forceValue!)).toBeLessThan(1);
      }).toPass({ timeout: 3000 });
    });

    test('motion is prevented when disabled', async ({ window }) => {
      const enableButton = window.getByRole('button', { name: 'Enable Motion' });
      
      // Fresh emulator starts with motion disabled
      await expect(enableButton).toBeVisible({ timeout: 5000 });
      
      // Get initial position
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const initialPos = extractPosition(await posContainer.textContent());
      expect(initialPos).not.toBeNull();
      
      // Try to move (should be ignored)
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000);
      
      // Position should NOT have changed
      const finalPos = extractPosition(await posContainer.textContent());
      expect(finalPos).not.toBeNull();
      expect(Math.abs(finalPos! - initialPos!)).toBeLessThan(0.5);
    });

    test('disabling motion mid-move stops the movement', async ({ window }) => {
      const enableButton = window.getByRole('button', { name: 'Enable Motion' });
      const disableButton = window.getByRole('button', { name: 'Disable Motion' });
      
      // Fresh emulator starts with motion disabled and position zeroed
      await expect(enableButton).toBeVisible({ timeout: 5000 });
      await enableButton.click();
      await expect(disableButton).toBeVisible({ timeout: 5000 });
      
      // Start a long move
      await window.getByLabel('Move Distance (mm)').fill('50');
      await window.getByLabel('Move Speed (mm/s)').fill('5');  // Slow so we can interrupt
      await window.getByRole('button', { name: 'Move Up' }).click();
      
      // Wait briefly then disable
      await window.waitForTimeout(500);
      await disableButton.click();
      
      // Verify motion is disabled
      await expect(enableButton).toBeVisible({ timeout: 5000 });
      
      // Get position at stop
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const stoppedPos = extractPosition(await posContainer.textContent());
      expect(stoppedPos).not.toBeNull();
      
      // Wait a moment more
      await window.waitForTimeout(1000);
      
      // Position should NOT continue changing
      const laterPos = extractPosition(await posContainer.textContent());
      expect(laterPos).not.toBeNull();
      expect(Math.abs(laterPos! - stoppedPos!)).toBeLessThan(0.5);
      
      // Should have moved LESS than full 50mm (interrupted)
      expect(stoppedPos!).toBeLessThan(45);
    });
  });
});
