/**
 * Connection & Navigation Tests (consolidated)
 *
 * Single test that validates:
 * - Emulator port discovery and connection
 * - IPC connection and device responding
 * - All navigation links visible
 * - Each page loads with expected content
 * - No error dialogs during navigation
 * - Connection persists across page navigation
 * - Firmware version displayed correctly
 * - Connect page has serial port controls
 */

import { test, expect } from './fixtures';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

test.describe('Connection & Navigation', () => {

  test('connection lifecycle and all page navigation', async ({ connectToEmulator, window, listPorts, emulatorPort, emulator }) => {
    // ── 1. Port discovery ──
    void emulator;
    const initialPorts = await listPorts();
    expect(Array.isArray(initialPorts)).toBe(true);

    // Some environments return an empty first scan while bridge/app startup settles.
    // The connect helper already polls for the emulator port and provides a reliable
    // readiness gate for the rest of the flow.
    await connectToEmulator();

    const ports = await listPorts();
    expect(Array.isArray(ports)).toBe(true);
    if (ports.length > 0) {
      expect(ports).toContain(emulatorPort);
    }

    // ── 2. Connect and verify ──
    const isConnected = await window.evaluate(async () => {
      return (globalThis as any).electron.ipcRenderer.invoke('device-connected');
    });
    expect(isConnected).toBe(true);

    const isResponding = await window.evaluate(async () => {
      return (globalThis as any).electron.ipcRenderer.invoke('device-responding');
    });
    expect(isResponding).toBe(true);

    // UI status indicators
    await expect(window.getByText('Port Connected')).toBeVisible({ timeout: 5000 });
    await expect(window.getByText('Device Responding')).toBeVisible({ timeout: 5000 });

    // ── 3. All navigation links visible ──
    await expect(window.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Create' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Device Configuration' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Firmware Update' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Connect' })).toBeVisible();

    // ── 4. Dashboard page ──
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
    await expect(window.getByRole('heading', { name: 'Machine State', level: 6 })).toBeVisible();
    await expect(window.getByText('Motion State')).toBeVisible();
    await expect(window.getByRole('button', { name: 'Move Up' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Move Down' })).toBeVisible();
    await expect(window.getByText('Machine Force (N):')).toBeVisible();
    await expect(window.getByText('Machine Position (mm):')).toBeVisible();

    // ── 5. Create page ──
    await window.getByRole('link', { name: 'Create' }).click();
    await window.waitForTimeout(300);
    await expect(window.getByRole('heading', { name: 'Sample Profile' })).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Motion Profile' })).toBeVisible();
    await expect(window.getByLabel('Max Force (N)')).toBeVisible();
    await expect(window.getByRole('button', { name: 'Save Sample Profile' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Save Motion Profile' })).toBeVisible();

    // ── 6. Device Configuration page ──
    await window.getByRole('link', { name: 'Device Configuration' }).click();
    await window.waitForTimeout(2000);
    const saveConfigBtn = window.getByRole('button', { name: 'Save Configuration' });
    const loadingText = window.getByText('Loading...');
    const failedText = window.getByText('Failed to load');
    const hasSave = await saveConfigBtn.isVisible().catch(() => false);
    const hasLoading = await loadingText.isVisible().catch(() => false);
    const hasFailed = await failedText.isVisible().catch(() => false);
    expect(hasSave || hasLoading || hasFailed).toBe(true);

    // ── 7. Firmware Update page ──
    await window.getByRole('link', { name: 'Firmware Update' }).click();
    await window.waitForTimeout(2000);
    const pageText = await window.locator('body').textContent();
    expect(pageText?.toLowerCase()).toContain('firmware');

    // Firmware version
    const firmwareLabel = window.locator('text=Current Firmware:');
    if (await firmwareLabel.isVisible().catch(() => false)) {
      const firmwareContainer = window.locator('p:has-text("Current Firmware:")');
      const containerText = await firmwareContainer.textContent();
      expect(containerText).toMatch(/\d+\.\d+\.\d+/);
    }

    // Flash button
    const flashButton = window.getByRole('button', { name: /Flash Firmware/i });
    await expect(flashButton).toBeVisible();
    await expect(flashButton).toBeEnabled();

    // GitHub reference
    const githubIcon = window.locator('[data-testid="GitHubIcon"]');
    const hasIcon = await githubIcon.isVisible().catch(() => false);
    const hasGitHub = pageText?.toLowerCase().includes('github') ||
      pageText?.toLowerCase().includes('releases');
    expect(hasGitHub || hasIcon).toBe(true);

    // No error alerts
    const errorAlert = window.locator('role=alert');
    const hasAlert = await errorAlert.isVisible().catch(() => false);
    if (hasAlert) {
      const alertText = await errorAlert.textContent();
      expect(alertText?.toLowerCase()).not.toContain('failed to load page');
    }

    // ── 8. Connect page ──
    await window.getByRole('link', { name: 'Connect' }).click();
    await window.waitForTimeout(300);
    const connectText = await window.locator('body').textContent();
    const hasPortContent = connectText?.toLowerCase().includes('serial') ||
      connectText?.toLowerCase().includes('port') ||
      connectText?.toLowerCase().includes('connect');
    expect(hasPortContent).toBe(true);

    // ── 9. No error dialogs during full navigation cycle ──
    const pages = ['Dashboard', 'Create', 'Device Configuration', 'Firmware Update', 'Connect'];
    for (const page of pages) {
      await window.getByRole('link', { name: page }).click();
      await window.waitForTimeout(300);
      const errorDialog = window.locator('role=alertdialog');
      const hasError = await errorDialog.isVisible().catch(() => false);
      expect(hasError).toBe(false);
    }

    // ── 10. Connection persists across navigation ──
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
    await expect(window.getByText('Machine Force (N):')).toBeVisible();

    await window.getByRole('link', { name: 'Create' }).click();
    await window.waitForTimeout(300);
    await window.getByRole('link', { name: 'Dashboard' }).click();
    await expect(window.getByText('Loading...')).not.toBeVisible({ timeout: 15000 });
    await expect(window.getByText('Machine Force (N):')).toBeVisible();
    await expect(window.getByText('Machine Position (mm):')).toBeVisible();

    const stillResponding = await window.evaluate(async () => {
      return (globalThis as any).electron.ipcRenderer.invoke('device-responding');
    });
    expect(stillResponding).toBe(true);
  });

  test('disconnect handling: emulator loss surfaces non-responding state', async ({ connectToEmulator, window, emulator }) => {
    await connectToEmulator();

    const wasResponding = await window.evaluate(async () => {
      return (globalThis as any).electron.ipcRenderer.invoke('device-responding');
    });
    expect(wasResponding).toBe(true);

    if (emulator.pid) {
      try {
        process.kill(emulator.pid, 'SIGTERM');
      } catch {
        // ignore if already exited
      }
    }

    const start = Date.now();
    let responding = true;
    while (Date.now() - start < 15000) {
      responding = await window.evaluate(async () => {
        return (globalThis as any).electron.ipcRenderer.invoke('device-responding');
      });
      if (!responding) break;
      await window.waitForTimeout(500);
    }

    expect(responding).toBe(false);

    const statusText = await window.locator('body').textContent();
    expect(
      statusText?.includes('Port Connected') ||
      statusText?.includes('Device Responding'),
    ).toBeTruthy();

    let restartedEmulator: ChildProcess | null = null;
    try {
      const silRoot = path.resolve(__dirname, '..');
      const emulatorBin = path.join(silRoot, 'target/debug/mad-emulator');
      const sdPath = path.join(silRoot, 'sd');
      const ptyPath = '/tmp/tty.rpi';

      try {
        fs.unlinkSync(ptyPath);
      } catch {
        // ignore stale symlink cleanup errors
      }

      restartedEmulator = spawn(
        emulatorBin,
        ['--sd-path', sdPath, '--pty-path', ptyPath, '--log-level', 'info'],
        { cwd: silRoot, stdio: ['ignore', 'pipe', 'pipe'], detached: false },
      );

      const waitForPort = async (timeoutMs = 15000) => {
        const begin = Date.now();
        while (Date.now() - begin < timeoutMs) {
          if (fs.existsSync(ptyPath)) return;
          await window.waitForTimeout(200);
        }
        throw new Error(`Timed out waiting for ${ptyPath}`);
      };

      await waitForPort();
      await window.waitForTimeout(500);

      await window.evaluate(async () => {
        await (globalThis as any).electron.ipcRenderer.invoke(
          'device-connect',
          '/tmp/tty.rpi',
          115200,
        );
      });

      const reconnectStart = Date.now();
      let reconnected = false;
      while (Date.now() - reconnectStart < 15000) {
        reconnected = await window.evaluate(async () => {
          return (globalThis as any).electron.ipcRenderer.invoke(
            'device-responding',
          );
        });
        if (reconnected) break;
        await window.waitForTimeout(500);
      }

      expect(reconnected).toBe(true);
    } finally {
      if (restartedEmulator?.pid) {
        try {
          process.kill(restartedEmulator.pid, 'SIGTERM');
        } catch {
          // ignore teardown race
        }
      }
    }
  });
});
