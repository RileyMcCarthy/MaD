/**
 * Dashboard and Motion Control Tests
 *
 * Comprehensive tests for the Dashboard page covering:
 * - Status display (Machine State panel, sample data readouts)
 * - Motion enable/disable with state verification
 * - Manual motion control (Move Up, Move Down) with position assertions
 * - Distance accuracy (5mm, 10mm moves)
 * - Bidirectional and sequential movement
 * - Zeroing (force and length)
 * - Homing
 * - Safety (motion prevented when disabled, disable mid-move)
 */

import { test, expect } from './fixtures';

/**
 * Extract numeric value from a UI text container using a label pattern.
 */
function extractValue(text: string | null, label: string): number | null {
  if (!text) return null;
  const pattern = new RegExp(`${label}:\\s*([-\\d.]+)`);
  const match = text.match(pattern);
  return match ? parseFloat(match[1]) : null;
}

const getPosition = async (posContainer: any) =>
  extractValue(await posContainer.textContent(), 'Machine Position \\(mm\\)');

const getSamplePosition = async (container: any) =>
  extractValue(await container.textContent(), 'Sample Position \\(mm\\)');

const getSampleForce = async (container: any) =>
  extractValue(await container.textContent(), 'Sample Force \\(N\\)');

test.describe('Dashboard and Motion Control', () => {

  test.beforeEach(async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
    await expect(window.getByRole('heading', { name: 'Machine State', level: 6 })).toBeVisible();
  });

  // ── Dashboard Display ───────────────────────────────────────────

  test.describe('Dashboard Display', () => {

    test('machine status shows state fields with correct initial values', async ({ window }) => {
      await expect(window.getByRole('heading', { name: 'Machine State', level: 6 })).toBeVisible();

      // Motion State should start "Disabled" on fresh emulator
      const motionStateRow = window.locator('text=Motion State').locator('..');
      await expect(motionStateRow).toContainText('Disabled');

      // Test State should be "Idle"
      const testStateRow = window.locator('text=Test State').locator('..');
      await expect(testStateRow).toContainText('Idle');
    });

    test('sample data displays finite numeric values', async ({ window }) => {
      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const forceContainer = window.locator('text=Machine Force (N):').locator('..');

      const posValue = getPosition(posContainer);
      expect(await posValue).not.toBeNull();
      expect(Number.isFinite(await posValue)).toBe(true);

      const forceValue = extractValue(await forceContainer.textContent(), 'Machine Force \\(N\\)');
      expect(forceValue).not.toBeNull();
      expect(Number.isFinite(forceValue)).toBe(true);
    });

    test('move inputs accept and retain values', async ({ window }) => {
      const distanceInput = window.getByLabel('Move Distance (mm)');
      const speedInput = window.getByLabel('Move Speed (mm/s)');

      await distanceInput.fill('7.5');
      await speedInput.fill('25');

      await expect(distanceInput).toHaveValue('7.5');
      await expect(speedInput).toHaveValue('25');
    });
  });

  // ── Motion Enable/Disable ──────────────────────────────────────

  test.describe('Motion Enable/Disable', () => {

    test('Enable Motion changes state from Disabled to Enabled', async ({ window }) => {
      const enableBtn = window.getByRole('button', { name: 'Enable Motion' });
      const disableBtn = window.getByRole('button', { name: 'Disable Motion' });
      const stateRow = window.locator('text=Motion State').locator('..');

      // Starts disabled
      await expect(enableBtn).toBeVisible({ timeout: 5000 });
      await expect(stateRow).toContainText('Disabled');

      // Enable
      await enableBtn.click();
      await expect(disableBtn).toBeVisible({ timeout: 5000 });
      await expect(stateRow).toContainText('Enabled', { timeout: 5000 });
    });

    test('Disable Motion changes state from Enabled back to Disabled', async ({ window }) => {
      const enableBtn = window.getByRole('button', { name: 'Enable Motion' });
      const disableBtn = window.getByRole('button', { name: 'Disable Motion' });
      const stateRow = window.locator('text=Motion State').locator('..');

      await expect(enableBtn).toBeVisible({ timeout: 5000 });
      await enableBtn.click();
      await expect(disableBtn).toBeVisible({ timeout: 5000 });
      await expect(stateRow).toContainText('Enabled', { timeout: 5000 });

      await disableBtn.click();
      await expect(enableBtn).toBeVisible({ timeout: 5000 });
      await expect(stateRow).toContainText('Disabled', { timeout: 5000 });
    });
  });

  // ── Manual Motion Control ──────────────────────────────────────

  test.describe('Manual Motion Control', () => {

    test('Move Up 5mm increases position by approximately 5mm', async ({ window }) => {
      // Enable motion
      await window.getByRole('button', { name: 'Enable Motion' }).click();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });

      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const initialPos = await getPosition(posContainer);
      expect(initialPos).not.toBeNull();

      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000);

      const finalPos = await getPosition(posContainer);
      expect(finalPos).not.toBeNull();
      const delta = finalPos! - initialPos!;
      expect(delta).toBeGreaterThan(3);
      expect(delta).toBeLessThan(7);
    });

    test('Move Up 10mm increases position by approximately 10mm', async ({ window }) => {
      await window.getByRole('button', { name: 'Enable Motion' }).click();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });

      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const startPos = await getPosition(posContainer);
      expect(startPos).not.toBeNull();

      await window.getByLabel('Move Distance (mm)').fill('10');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1500);

      const endPos = await getPosition(posContainer);
      expect(endPos).not.toBeNull();
      const delta = endPos! - startPos!;
      expect(delta).toBeGreaterThan(7);
      expect(delta).toBeLessThan(13);
    });

    test('Move Down decreases position after moving up', async ({ window }) => {
      await window.getByRole('button', { name: 'Enable Motion' }).click();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });

      const posContainer = window.locator('text=Machine Position (mm):').locator('..');

      // Move up first
      await window.getByLabel('Move Distance (mm)').fill('10');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1500);

      const startPos = await getPosition(posContainer);
      expect(startPos).not.toBeNull();
      expect(startPos!).toBeGreaterThan(5);

      // Move down
      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByRole('button', { name: 'Move Down' }).click();
      await window.waitForTimeout(1000);

      const endPos = await getPosition(posContainer);
      expect(endPos).not.toBeNull();
      expect(endPos!).toBeLessThan(startPos!);
      expect(startPos! - endPos!).toBeGreaterThan(2);
    });

    test('Move Up then Down same distance returns near start position', async ({ window }) => {
      await window.getByRole('button', { name: 'Enable Motion' }).click();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });

      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const startPos = await getPosition(posContainer);
      expect(startPos).not.toBeNull();

      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByLabel('Move Speed (mm/s)').fill('20');

      // Up
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000);
      const midPos = await getPosition(posContainer);
      expect(midPos).not.toBeNull();
      expect(Math.abs(midPos! - startPos!)).toBeGreaterThan(2);

      // Down
      await window.getByRole('button', { name: 'Move Down' }).click();
      await window.waitForTimeout(1000);
      const endPos = await getPosition(posContainer);
      expect(endPos).not.toBeNull();
      expect(Math.abs(endPos! - startPos!)).toBeLessThan(2);
    });

    test('sequential 3mm moves accumulate correctly (~9mm total)', async ({ window }) => {
      await window.getByRole('button', { name: 'Enable Motion' }).click();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });

      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const startPos = await getPosition(posContainer);
      expect(startPos).not.toBeNull();

      await window.getByLabel('Move Distance (mm)').fill('3');
      await window.getByLabel('Move Speed (mm/s)').fill('20');

      for (let i = 0; i < 3; i++) {
        await window.getByRole('button', { name: 'Move Up' }).click();
        await window.waitForTimeout(600);
      }

      const endPos = await getPosition(posContainer);
      expect(endPos).not.toBeNull();
      const totalDelta = endPos! - startPos!;
      expect(totalDelta).toBeGreaterThan(6);
      expect(totalDelta).toBeLessThan(12);
    });

    test('inputs retain values after move completes', async ({ window }) => {
      await window.getByRole('button', { name: 'Enable Motion' }).click();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });

      await window.getByLabel('Move Distance (mm)').fill('7');
      await window.getByLabel('Move Speed (mm/s)').fill('15');
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000);

      await expect(window.getByLabel('Move Distance (mm)')).toHaveValue('7');
      await expect(window.getByLabel('Move Speed (mm/s)')).toHaveValue('15');
    });
  });

  // ── Zeroing ─────────────────────────────────────────────────────

  test.describe('Zeroing', () => {

    test('Zero Length resets sample position to zero', async ({ window }) => {
      await window.getByRole('button', { name: 'Enable Motion' }).click();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });

      // Move to create non-zero sample position
      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000);

      const samplePosContainer = window.locator('text=Sample Position (mm):').locator('..');
      const posBefore = await getSamplePosition(samplePosContainer);
      expect(posBefore).not.toBeNull();
      expect(Math.abs(posBefore!)).toBeGreaterThan(2);

      // Zero Length
      await window.getByRole('button', { name: 'Zero Length' }).click();

      await expect(async () => {
        const pos = await getSamplePosition(samplePosContainer);
        expect(pos).not.toBeNull();
        expect(Math.abs(pos!)).toBeLessThan(1);
      }).toPass({ timeout: 5000 });
    });

    test('Zero Force resets sample force to zero', async ({ window }) => {
      const sampleForceContainer = window.locator('text=Sample Force (N):').locator('..');

      await window.getByRole('button', { name: 'Zero Force' }).click();

      await expect(async () => {
        const force = await getSampleForce(sampleForceContainer);
        expect(force).not.toBeNull();
        expect(Math.abs(force!)).toBeLessThan(1);
      }).toPass({ timeout: 3000 });
    });
  });

  // ── Homing ──────────────────────────────────────────────────────

  test.describe('Homing', () => {

    test('Home initiates homing sequence without fault', async ({ window }) => {
      await window.getByRole('button', { name: 'Enable Motion' }).click();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible({ timeout: 5000 });

      // Move to non-zero position
      await window.getByLabel('Move Distance (mm)').fill('5');
      await window.getByLabel('Move Speed (mm/s)').fill('20');
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000);

      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const posBefore = await getPosition(posContainer);
      expect(posBefore).not.toBeNull();
      expect(Math.abs(posBefore!)).toBeGreaterThan(1);

      // Home
      await window.getByRole('button', { name: 'Home' }).click();
      await window.waitForTimeout(3000);

      // No fault — Home button still enabled, motion still enabled
      await expect(window.getByRole('button', { name: 'Home' })).toBeEnabled();
      await expect(window.getByRole('button', { name: 'Disable Motion' })).toBeVisible();
    });
  });

  // ── Safety ──────────────────────────────────────────────────────

  test.describe('Safety', () => {

    test('motion is prevented when disabled', async ({ window }) => {
      const enableBtn = window.getByRole('button', { name: 'Enable Motion' });
      await expect(enableBtn).toBeVisible({ timeout: 5000 });

      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const initialPos = await getPosition(posContainer);
      expect(initialPos).not.toBeNull();

      // Try to move while disabled
      await window.getByRole('button', { name: 'Move Up' }).click();
      await window.waitForTimeout(1000);

      const finalPos = await getPosition(posContainer);
      expect(finalPos).not.toBeNull();
      expect(Math.abs(finalPos! - initialPos!)).toBeLessThan(0.5);
    });

    test('disabling motion mid-move stops movement', async ({ window }) => {
      const enableBtn = window.getByRole('button', { name: 'Enable Motion' });
      const disableBtn = window.getByRole('button', { name: 'Disable Motion' });

      await expect(enableBtn).toBeVisible({ timeout: 5000 });
      await enableBtn.click();
      await expect(disableBtn).toBeVisible({ timeout: 5000 });

      // Start long slow move
      await window.getByLabel('Move Distance (mm)').fill('50');
      await window.getByLabel('Move Speed (mm/s)').fill('5');
      await window.getByRole('button', { name: 'Move Up' }).click();

      // Interrupt
      await window.waitForTimeout(500);
      await disableBtn.click();
      await expect(enableBtn).toBeVisible({ timeout: 5000 });

      const posContainer = window.locator('text=Machine Position (mm):').locator('..');
      const stoppedPos = await getPosition(posContainer);
      expect(stoppedPos).not.toBeNull();

      await window.waitForTimeout(1000);
      const laterPos = await getPosition(posContainer);
      expect(laterPos).not.toBeNull();
      expect(Math.abs(laterPos! - stoppedPos!)).toBeLessThan(0.5);

      // Should have moved less than full distance
      expect(stoppedPos!).toBeLessThan(45);
    });
  });
});
