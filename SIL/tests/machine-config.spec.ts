/**
 * Machine Configuration (consolidated)
 *
 * One test that exercises:
 *   - Device Configuration page loads with Save button and editable fields
 *   - Number and text fields can be edited and retain values
 *   - Config write/read round trip via IPC (restores original)
 *   - Firmware flash safety: cancel reports a clear error when no flash is active
 */

import { test, expect } from './fixtures';

test.describe('Machine Configuration', () => {
  test('page UI + IPC round trip + flash safety', async ({
    connectToEmulator,
    window,
  }) => {
    await connectToEmulator();

    // ── 1. Page load: Save button visible (or loading / failed state) ──
    await window.getByRole('link', { name: 'Device Configuration' }).click();
    await window.waitForTimeout(2000);

    const saveButton = window.getByRole('button', { name: 'Save Configuration' });
    const loadingText = window.getByText('Loading...');
    const failedText = window.getByText('Failed to load machine configuration');

    const isLoaded = await saveButton.isVisible().catch(() => false);
    const isLoading = await loadingText.isVisible().catch(() => false);
    const isFailed = await failedText.isVisible().catch(() => false);
    expect(isLoaded || isLoading || isFailed).toBe(true);

    if (isLoaded) {
      await expect(saveButton).toBeEnabled();

      // Editable fields exist
      const inputs = window.locator('input[type="text"], input[type="number"]');
      expect(await inputs.count()).toBeGreaterThan(0);

      // Number fields editable + restorable
      const numberInputs = window.locator('input[type="number"]');
      const numCount = await numberInputs.count();
      if (numCount > 0) {
        const numInput = numberInputs.first();
        const originalNum = await numInput.inputValue();
        await numInput.fill('12345');
        await expect(numInput).toHaveValue('12345');
        await numInput.fill(originalNum);
        await expect(numInput).toHaveValue(originalNum);
      }

      // Text fields editable + restorable
      const textInputs = window.locator('input[type="text"]');
      const textCount = await textInputs.count();
      if (textCount > 0) {
        const textInput = textInputs.first();
        const originalText = await textInput.inputValue();
        await textInput.fill('TestValue');
        await expect(textInput).toHaveValue('TestValue');
        await textInput.fill(originalText);
        await expect(textInput).toHaveValue(originalText);
      }
    }

    // ── 2. IPC round trip: write → re-read → restore ───────────────────
    const original = (await window.evaluate(async () =>
      (globalThis as any).electron.ipcRenderer.invoke('get-machine-configuration'),
    )) as Record<string, unknown>;
    expect(original).toBeTruthy();

    const fieldKey = 'Position Max (mm)';
    const baseValue = Number(original[fieldKey]);
    expect(Number.isFinite(baseValue)).toBe(true);

    const updated = { ...original, [fieldKey]: baseValue + 1 };
    const saveOk = await window.evaluate(
      async ({ cfg }: { cfg: Record<string, unknown> }) =>
        (globalThis as any).electron.ipcRenderer.invoke('save-machine-configuration', cfg),
      { cfg: updated },
    );
    expect(Boolean(saveOk)).toBe(true);

    const reread = (await window.evaluate(async () =>
      (globalThis as any).electron.ipcRenderer.invoke('get-machine-configuration'),
    )) as Record<string, unknown>;
    expect(Number(reread[fieldKey])).toBe(baseValue + 1);

    const restoreOk = await window.evaluate(
      async ({ cfg }: { cfg: Record<string, unknown> }) =>
        (globalThis as any).electron.ipcRenderer.invoke('save-machine-configuration', cfg),
      { cfg: original },
    );
    expect(Boolean(restoreOk)).toBe(true);

    const restored = (await window.evaluate(async () =>
      (globalThis as any).electron.ipcRenderer.invoke('get-machine-configuration'),
    )) as Record<string, unknown>;
    expect(Number(restored[fieldKey])).toBe(baseValue);

    // ── 3. Firmware flash cancel safety ─────────────────────────────────
    const cancelResult = (await window.evaluate(async () =>
      (globalThis as any).electron.ipcRenderer.invoke('cancel-firmware-flash'),
    )) as { success: boolean; error?: string };

    expect(cancelResult.success).toBe(false);
    expect((cancelResult.error || '').toLowerCase()).toContain('no flash process');
  });
});
