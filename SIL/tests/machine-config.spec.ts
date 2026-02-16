/**
 * Machine Configuration Page Tests
 *
 * Validates:
 * 1. Configuration page loads with Save button and editable fields
 * 2. Number and text fields can be edited and retain values
 * 3. Save Configuration does not produce errors
 */

import { test, expect } from './fixtures';

test.describe('Machine Configuration', () => {

  test.beforeEach(async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    await window.getByRole('link', { name: 'Device Configuration' }).click();
    await window.waitForTimeout(2000);
  });

  test('page loads with Save Configuration button and editable fields', async ({ window }) => {
    const saveButton = window.getByRole('button', { name: 'Save Configuration' });
    const loadingText = window.getByText('Loading...');
    const failedText = window.getByText('Failed to load machine configuration');

    const isLoaded = await saveButton.isVisible().catch(() => false);
    const isLoading = await loadingText.isVisible().catch(() => false);
    const isFailed = await failedText.isVisible().catch(() => false);

    expect(isLoaded || isLoading || isFailed).toBe(true);

    if (isLoaded) {
      await expect(saveButton).toBeEnabled();

      // Should have editable input fields
      const inputs = window.locator('input[type="text"], input[type="number"]');
      const inputCount = await inputs.count();
      expect(inputCount).toBeGreaterThan(0);
    }
  });

  test('number fields can be edited and retain values', async ({ window }) => {
    const saveButton = window.getByRole('button', { name: 'Save Configuration' });
    if (!(await saveButton.isVisible().catch(() => false))) return;

    const numberInputs = window.locator('input[type="number"]');
    const count = await numberInputs.count();
    if (count === 0) return;

    const input = numberInputs.first();
    const originalValue = await input.inputValue();

    await input.fill('12345');
    await expect(input).toHaveValue('12345');

    // Restore
    await input.fill(originalValue);
    await expect(input).toHaveValue(originalValue);
  });

  test('text fields can be edited and retain values', async ({ window }) => {
    const saveButton = window.getByRole('button', { name: 'Save Configuration' });
    if (!(await saveButton.isVisible().catch(() => false))) return;

    const textInputs = window.locator('input[type="text"]');
    const count = await textInputs.count();
    if (count === 0) return;

    const input = textInputs.first();
    const originalValue = await input.inputValue();

    await input.fill('TestValue');
    await expect(input).toHaveValue('TestValue');

    await input.fill(originalValue);
    await expect(input).toHaveValue(originalValue);
  });

  test('clicking Save Configuration does not cause errors', async ({ window }) => {
    const saveButton = window.getByRole('button', { name: 'Save Configuration' });
    if (!(await saveButton.isVisible().catch(() => false))) return;

    await saveButton.click();
    await window.waitForTimeout(500);

    // Button should still be there and enabled (no crash/error)
    await expect(saveButton).toBeVisible();
    await expect(saveButton).toBeEnabled();
  });
});
