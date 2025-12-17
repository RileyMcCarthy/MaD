/**
 * Basic connection and communication tests with firmware emulator
 */

import { test, expect } from '@playwright/test';
import {
  launchMaDControl,
  connectToEmulator,
  disconnect,
  getMachineState,
  getSampleData,
} from './helpers';

test.describe('Basic Connection Tests', () => {
  test('should launch MaDControl application', async () => {
    const { app, window } = await launchMaDControl();
    
    try {
      // Verify the window is visible
      expect(await window.title()).toBeTruthy();
      
      // Take a screenshot
      await window.screenshot({ path: 'test-results/screenshots/app-launch.png' });
      
      console.log('✅ Application launched successfully');
    } finally {
      await app.close();
    }
  });
  
  test('should detect firmware emulator virtual port', async () => {
    const { app, window } = await launchMaDControl();
    
    try {
      // Wait a bit for the app to initialize
      await window.waitForTimeout(2000);
      
      // Get list of available ports
      const ports = await window.evaluate(async () => {
        return window.electron.ipcRenderer.invoke('device-list-ports');
      });
      
      console.log('Available ports:', ports);
      
      // Should include the emulator port
      expect(ports).toContain('/tmp/tty.rpi');
      
      console.log('✅ Emulator port detected');
    } finally {
      await app.close();
    }
  });
  
  test('should connect to firmware emulator', async () => {
    const { app, window } = await launchMaDControl();
    
    try {
      await connectToEmulator(window);
      
      // Wait for initial data
      await window.waitForTimeout(1000);
      
      // Verify we're getting sample data
      const sampleData = await getSampleData(window);
      console.log('Sample data:', sampleData);
      
      expect(sampleData).toBeTruthy();
      
      // Take screenshot of connected state
      await window.screenshot({ path: 'test-results/screenshots/connected.png' });
      
      console.log('✅ Successfully connected to emulator');
      
      // Disconnect
      await disconnect(window);
    } finally {
      await app.close();
    }
  });
  
  test('should receive machine state updates', async () => {
    const { app, window } = await launchMaDControl();
    
    try {
      await connectToEmulator(window);
      
      // Wait for state updates
      await window.waitForTimeout(2000);
      
      const state = await getMachineState(window);
      console.log('Machine state:', state);
      
      expect(state).toBeTruthy();
      // State should be IDLE initially
      // expect(state.state).toBe('IDLE');
      
      console.log('✅ Receiving machine state updates');
      
      await disconnect(window);
    } finally {
      await app.close();
    }
  });
});

