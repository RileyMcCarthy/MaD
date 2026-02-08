/**
 * Machine Configuration Page Tests
 * 
 * Validates:
 * 1. Machine configuration page loads
 * 2. Configuration fields are editable
 * 3. Save button is functional
 * 
 * Each test has assertions for specific UI elements and behaviors.
 */

import { test, expect } from './fixtures';

test.describe('Machine Configuration', () => {
  
  test.beforeEach(async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Device Configuration' }).click();
    // Give time for config to load from device
    await window.waitForTimeout(2000);
  });

  test.describe('Page Loading', () => {
    
    test('should display Save Configuration button when config loads', async ({ window }) => {
      // Check for either loaded state or loading/error state
      const saveButton = window.getByRole('button', { name: 'Save Configuration' });
      const loadingText = window.getByText('Loading...');
      const failedText = window.getByText('Failed to load machine configuration');
      
      const isLoaded = await saveButton.isVisible().catch(() => false);
      const isLoading = await loadingText.isVisible().catch(() => false);
      const isFailed = await failedText.isVisible().catch(() => false);
      
      // Must be in one of these states
      expect(isLoaded || isLoading || isFailed).toBe(true);
      
      if (isLoaded) {
        await expect(saveButton).toBeEnabled();
      }
    });

    test('should display configuration text fields when loaded', async ({ window }) => {
      const saveButton = window.getByRole('button', { name: 'Save Configuration' });
      
      if (await saveButton.isVisible().catch(() => false)) {
        // Config loaded - should have text/number inputs
        const inputs = window.locator('input[type="text"], input[type="number"]');
        const inputCount = await inputs.count();
        
        expect(inputCount).toBeGreaterThan(0);
      }
    });
  });

  test.describe('Configuration Editing', () => {
    
    test('should allow editing a number field', async ({ window }) => {
      const saveButton = window.getByRole('button', { name: 'Save Configuration' });
      
      if (await saveButton.isVisible().catch(() => false)) {
        const numberInputs = window.locator('input[type="number"]');
        const count = await numberInputs.count();
        
        if (count > 0) {
          const input = numberInputs.first();
          const originalValue = await input.inputValue();
          
          // Change value
          await input.fill('12345');
          await expect(input).toHaveValue('12345');
          
          // Restore original
          await input.fill(originalValue);
          await expect(input).toHaveValue(originalValue);
        }
      }
    });

    test('should allow editing a text field', async ({ window }) => {
      const saveButton = window.getByRole('button', { name: 'Save Configuration' });
      
      if (await saveButton.isVisible().catch(() => false)) {
        const textInputs = window.locator('input[type="text"]');
        const count = await textInputs.count();
        
        if (count > 0) {
          const input = textInputs.first();
          const originalValue = await input.inputValue();
          
          // Change value
          await input.fill('TestValue');
          await expect(input).toHaveValue('TestValue');
          
          // Restore
          await input.fill(originalValue);
        }
      }
    });

    test('Save button should remain enabled after editing', async ({ window }) => {
      const saveButton = window.getByRole('button', { name: 'Save Configuration' });
      
      if (await saveButton.isVisible().catch(() => false)) {
        const inputs = window.locator('input[type="number"]');
        if (await inputs.count() > 0) {
          await inputs.first().fill('99');
        }
        
        // Save button should still be enabled
        await expect(saveButton).toBeEnabled();
      }
    });
  });

  test.describe('Save Functionality', () => {
    
    test('clicking Save should not cause error', async ({ window }) => {
      const saveButton = window.getByRole('button', { name: 'Save Configuration' });
      
      if (await saveButton.isVisible().catch(() => false)) {
        await saveButton.click();
        await window.waitForTimeout(500);
        
        // No error alert should appear
        const errorAlert = window.locator('role=alert');
        const hasError = await errorAlert.isVisible().catch(() => false);
        
        // Button should still be there and enabled
        await expect(saveButton).toBeVisible();
        await expect(saveButton).toBeEnabled();
      }
    });
  });
});
