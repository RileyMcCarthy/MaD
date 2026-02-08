/**
 * Firmware Connection Tests
 * 
 * Tests for connecting to the firmware emulator via virtual serial port.
 */

import { test, expect } from './fixtures';

test.describe('Firmware Connection', () => {
  test('should detect emulator virtual port', async ({ listPorts, emulatorPort }) => {
    const ports = await listPorts();
    
    console.log('Available ports:', ports);
    expect(ports).toContain(emulatorPort);
    console.log(`✅ Emulator port ${emulatorPort} detected`);
  });

  test('should connect to emulator', async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    
    // Verify connection state
    const isConnected = await window.evaluate(async () => {
      return window.electron.ipcRenderer.invoke('device-connected');
    });
    
    expect(isConnected).toBe(true);
    console.log('✅ Connected to firmware emulator');
  });

  test('should receive machine state after connection', async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    
    // Wait for state updates to come in
    await window.waitForTimeout(3000);
    
    // Check if we're receiving state from device
    const state = await window.evaluate(async () => {
      return window.electron.ipcRenderer.invoke('device-state');
    });
    
    console.log('Machine state:', JSON.stringify(state).slice(0, 200));
    expect(state).toBeDefined();
    console.log('✅ Receiving machine state');
  });

  test('should report device responding after connection', async ({ connectToEmulator, window }) => {
    await connectToEmulator();
    
    // Wait for device to respond
    await window.waitForTimeout(3000);
    
    // Check if device is responding
    const isResponding = await window.evaluate(async () => {
      return window.electron.ipcRenderer.invoke('device-responding');
    });
    
    console.log('Device responding:', isResponding);
    expect(isResponding).toBe(true);
    console.log('✅ Device is responding');
  });
});
