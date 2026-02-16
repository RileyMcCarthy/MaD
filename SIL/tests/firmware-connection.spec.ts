/**
 * Firmware Connection Tests
 *
 * Validates the complete serial connection lifecycle:
 * 1. Emulator virtual port is discoverable
 * 2. Connection succeeds and IPC reports connected
 * 3. Firmware responds and sends machine state
 * 4. UI reflects connection status
 */

import { test, expect } from './fixtures';

test.describe('Firmware Connection', () => {

  test('should list available ports and detect emulator port', async ({ listPorts, emulatorPort, emulator }) => {
    // emulator fixture ensures the Rust emulator is running
    void emulator;
    const ports = await listPorts();

    expect(Array.isArray(ports)).toBe(true);
    expect(ports.length).toBeGreaterThan(0);
    expect(ports).toContain(emulatorPort);
  });

  test('should connect, receive state, and UI shows status', async ({ connectToEmulator, window }) => {
    await connectToEmulator();

    // Verify IPC reports connected
    const isConnected = await window.evaluate(async () => {
      return window.electron.ipcRenderer.invoke('device-connected');
    });
    expect(isConnected).toBe(true);

    // Verify IPC reports device responding
    const isResponding = await window.evaluate(async () => {
      return window.electron.ipcRenderer.invoke('device-responding');
    });
    expect(isResponding).toBe(true);

    // Verify UI shows connected status indicators
    await expect(window.getByText('Port Connected')).toBeVisible({ timeout: 5000 });
    await expect(window.getByText('Device Responding')).toBeVisible({ timeout: 5000 });

    // Verify machine state is being received via the UI (state is pushed, not pulled)
    await expect(window.getByText('Machine State')).toBeVisible({ timeout: 5000 });
  });
});
