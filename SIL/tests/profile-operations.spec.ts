/**
 * Profile Save and Edit Operations Tests
 * 
 * Validates:
 * 1. Profile forms can be filled and modified
 * 2. Loaded profiles show correct values
 * 3. Profile modifications are reflected in the UI
 * 4. Save buttons are functional
 * 
 * Each test has assertions for specific form field values.
 */

import { test, expect } from './fixtures';
import path from 'path';

const FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures');
const SAMPLE_PROFILE_PATH = path.join(FIXTURES_DIR, 'sample-profile.sp');
const MOTION_PROFILE_SIMPLE_PATH = path.join(FIXTURES_DIR, 'motion-profile-simple.mp');

test.describe('Profile Operations', () => {
  
  test.beforeEach(async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Create' }).click();
    await window.waitForTimeout(500);
    
    // Verify we're on the Create page
    await expect(window.getByRole('heading', { name: 'Sample Profile' })).toBeVisible();
  });

  test.describe('Sample Profile Form', () => {
    
    test('all form fields should be visible', async ({ window }) => {
      await expect(window.getByLabel('Max Force (N)')).toBeVisible();
      await expect(window.getByLabel('Max Velocity (mm/s)')).toBeVisible();
      await expect(window.getByLabel('Max Displacement (mm)')).toBeVisible();
      await expect(window.getByLabel('Sample Width (mm)')).toBeVisible();
      await expect(window.getByLabel('Sample Thickness (mm)')).toBeVisible();
      await expect(window.getByLabel('Sample Name')).toBeVisible();
    });

    test('form fields should accept numeric input', async ({ window }) => {
      await window.getByLabel('Max Force (N)').fill('100');
      await expect(window.getByLabel('Max Force (N)')).toHaveValue('100');
      
      await window.getByLabel('Max Velocity (mm/s)').fill('50');
      await expect(window.getByLabel('Max Velocity (mm/s)')).toHaveValue('50');
      
      await window.getByLabel('Max Displacement (mm)').fill('200');
      await expect(window.getByLabel('Max Displacement (mm)')).toHaveValue('200');
    });

    test('sample name should accept text input', async ({ window }) => {
      await window.getByLabel('Sample Name').fill('TEST-SERIAL-001');
      await expect(window.getByLabel('Sample Name')).toHaveValue('TEST-SERIAL-001');
    });

    test('loading profile should populate all fields correctly', async ({ window }) => {
      const fileInput = window.locator('input[type="file"][accept=".sp"]').first();
      await fileInput.setInputFiles(SAMPLE_PROFILE_PATH);
      await window.waitForTimeout(500);
      
      // Verify all values from fixture (sample-profile.sp)
      await expect(window.getByLabel('Max Force (N)')).toHaveValue('50');
      await expect(window.getByLabel('Max Velocity (mm/s)')).toHaveValue('25');
      await expect(window.getByLabel('Max Displacement (mm)')).toHaveValue('100');
      await expect(window.getByLabel('Sample Width (mm)')).toHaveValue('10');
      await expect(window.getByLabel('Sample Thickness (mm)')).toHaveValue('2');
      await expect(window.getByLabel('Sample Name')).toHaveValue('TEST001');
    });

    test('loaded values can be modified', async ({ window }) => {
      // Load profile
      const fileInput = window.locator('input[type="file"][accept=".sp"]').first();
      await fileInput.setInputFiles(SAMPLE_PROFILE_PATH);
      await window.waitForTimeout(500);
      
      // Modify a value
      await window.getByLabel('Max Force (N)').fill('75');
      await expect(window.getByLabel('Max Force (N)')).toHaveValue('75');
      
      // Other values should remain unchanged
      await expect(window.getByLabel('Max Velocity (mm/s)')).toHaveValue('25');
      await expect(window.getByLabel('Sample Name')).toHaveValue('TEST001');
    });

    test('Save Sample Profile button should be enabled', async ({ window }) => {
      const saveButton = window.getByRole('button', { name: 'Save Sample Profile' });
      await expect(saveButton).toBeVisible();
      await expect(saveButton).toBeEnabled();
    });
  });

  test.describe('Motion Profile Form', () => {
    
    test('Add Set button should be visible and functional', async ({ window }) => {
      const addSetButton = window.getByRole('button', { name: 'Add Set' });
      await expect(addSetButton).toBeVisible();
      
      // Click to add a set
      await addSetButton.click();
      await window.waitForTimeout(300);
      
      // Should now have Add Move button(s) visible
      const addMoveButton = window.getByRole('button', { name: 'Add Move' });
      await expect(addMoveButton.first()).toBeVisible();
    });

    test('adding a move should show move parameters', async ({ window }) => {
      // Add set first
      await window.getByRole('button', { name: 'Add Set' }).click();
      await window.waitForTimeout(200);
      
      // Add move
      await window.getByRole('button', { name: 'Add Move' }).first().click();
      await window.waitForTimeout(300);
      
      // Should have number inputs for move parameters
      const numberInputs = window.locator('input[type="number"]');
      const count = await numberInputs.count();
      
      // Should have more inputs now (position, velocity, etc.)
      expect(count).toBeGreaterThan(6); // 6 sample profile fields + move fields
    });

    test('loading motion profile should populate form fields', async ({ window }) => {
      const fileInput = window.locator('input[type="file"][accept=".mp"]');
      await fileInput.setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
      await window.waitForTimeout(500);
      
      // The simple profile has a set named "Tension Cycle" - check the Set Name input
      const setNameInput = window.getByLabel('Set Name');
      await expect(setNameInput).toHaveValue('Tension Cycle');
    });

    test('Save Motion Profile button should be enabled', async ({ window }) => {
      const saveButton = window.getByRole('button', { name: 'Save Motion Profile' });
      await expect(saveButton).toBeVisible();
      await expect(saveButton).toBeEnabled();
    });
  });

  test.describe('G-Code Preview', () => {
    
    test('loading motion profile should show G-code preview', async ({ window }) => {
      const fileInput = window.locator('input[type="file"][accept=".mp"]');
      await fileInput.setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
      await window.waitForTimeout(500);

      // Click the Preview G-code button to generate the preview
      await window.getByRole('button', { name: 'Preview G-code' }).click();
      await window.waitForTimeout(500);
      
      // Look for G-code commands in page
      const pageText = await window.locator('body').textContent();
      
      // Should contain G-code commands
      const hasGCode = pageText?.includes('G90') || 
                       pageText?.includes('G1') || 
                       pageText?.includes('G122');
      expect(hasGCode).toBe(true);
    });

    test('G-code should include G122 STOP command', async ({ window }) => {
      const fileInput = window.locator('input[type="file"][accept=".mp"]');
      await fileInput.setInputFiles(MOTION_PROFILE_SIMPLE_PATH);
      await window.waitForTimeout(500);

      // Click the Preview G-code button to generate the preview
      await window.getByRole('button', { name: 'Preview G-code' }).click();
      await window.waitForTimeout(500);
      
      // Verify G122 is in the generated G-code
      const pageText = await window.locator('body').textContent();
      expect(pageText).toContain('G122');
    });
  });
});
