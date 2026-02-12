/**
 * Connects to /tmp/tty.rpi and verifies connection status via IPC completes.
 * Run via: make test  (Rust emulator starts per-test via fixtures)
 */

import { test, expect } from './fixtures';

test.describe('Serial Connection', () => {
  
  test('connects to /tmp/tty.rpi and reports connected', async ({ window, connectToEmulator }) => {
    // Use the shared fixture to connect to the emulator
    await connectToEmulator();
    
    // Verify the port is now connected
    const connected = await window.evaluate(async () => {
      return window.electron.ipcRenderer.invoke('device-connected');
    });
    
    expect(connected).toBe(true);
    
    // Verify the UI shows connected status
    await expect(window.getByText('Port Connected')).toBeVisible({ timeout: 5000 });
  });

  test('device responds after connection', async ({ window, connectToEmulator }) => {
    await connectToEmulator();
    
    // The connectToEmulator fixture already verifies device is responding
    // But let's also check the UI
    await expect(window.getByText('Device Responding')).toBeVisible({ timeout: 5000 });
  });
  
  test('device-responding returns true after connection', async ({ window, connectToEmulator }) => {
    await connectToEmulator();
    
    // Verify the device-responding IPC handler returns true
    const responding = await window.evaluate(async () => {
      return window.electron.ipcRenderer.invoke('device-responding');
    });
    
    expect(responding).toBe(true);
  });
  
  test('can list available serial ports', async ({ window, waitForIPC, emulatorPort, emulator }) => {
    // emulator fixture ensures the Rust emulator is running
    void emulator;
    await waitForIPC();
    
    // Get list of ports
    const ports: string[] = await window.evaluate(async () => {
      return window.electron.ipcRenderer.invoke('device-list-ports');
    });
    
    // Should be an array containing the emulator port
    expect(Array.isArray(ports)).toBe(true);
    expect(ports).toContain(emulatorPort);
  });
});
