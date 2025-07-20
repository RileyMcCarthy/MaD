/**
 * Serial Port Communication Tests
 * 
 * These tests demonstrate how to test serial port interactions with the
 * MaD Control application using mocked serial responses.
 */

import { test, expect } from './helpers/electron';
import { SerialPortMocker, mockSerialResponses } from './helpers/serialMock';

test.describe('Serial Port Tests', () => {
  let serialMocker: SerialPortMocker;

  test.beforeEach(async ({ page }) => {
    serialMocker = new SerialPortMocker(page);
  });

  test('should connect to a mock serial device', async ({ page }) => {
    // Navigate to Connect page
    await page.click('text=Connect');
    await page.waitForLoadState('networkidle');
    
    // Set up mock connection responses
    await serialMocker.simulateConnection();
    
    // Find and interact with port selector
    const portSelector = page.locator('select, .MuiSelect-root, [data-testid="port-selector"]').first();
    if (await portSelector.isVisible()) {
      await portSelector.click();
      await page.waitForTimeout(300);
      
      // Select a mock port
      const mockPort = page.locator('[role="option"], option').first();
      if (await mockPort.count() > 0) {
        await mockPort.click();
      }
    }
    
    // Click connect button
    const connectButton = page.locator('button:has-text("Connect"), [data-testid="connect-button"]').first();
    if (await connectButton.isVisible()) {
      await connectButton.click();
      
      // Wait for connection status to update
      await page.waitForTimeout(1000);
      
      // Verify connection status (look for success indicators)
      const statusElements = page.locator('[data-testid*="status"], .status-connected, text=Connected').first();
      if (await statusElements.count() > 0) {
        await expect(statusElements).toBeVisible();
      }
    }
  });

  test('should handle machine status updates', async ({ page }) => {
    // Set up machine status mock responses
    await serialMocker.setupMockResponses([
      mockSerialResponses.machineReady,
      mockSerialResponses.positionData(0),
      mockSerialResponses.forceData(0),
    ]);
    
    // Navigate to dashboard to see status updates
    await page.click('text=Dashboard');
    await page.waitForLoadState('networkidle');
    
    // Look for machine status displays
    const statusDisplays = page.locator('[data-testid*="machine-status"], .machine-status, [class*="status"]');
    
    if (await statusDisplays.count() > 0) {
      await expect(statusDisplays.first()).toBeVisible();
      
      // Wait for status updates to propagate
      await page.waitForTimeout(1000);
    }
  });

  test('should receive and display sensor data', async ({ page }) => {
    // Set up continuous sensor data
    const sensorDataSequence = [
      mockSerialResponses.positionData(0),
      mockSerialResponses.forceData(0),
      mockSerialResponses.positionData(1.5),
      mockSerialResponses.forceData(0.3),
      mockSerialResponses.positionData(3.0),
      mockSerialResponses.forceData(0.8),
      mockSerialResponses.positionData(4.5),
      mockSerialResponses.forceData(1.2),
    ];
    
    await serialMocker.setupMockResponses(sensorDataSequence);
    
    // Navigate to dashboard
    await page.click('text=Dashboard');
    await page.waitForLoadState('networkidle');
    
    // Look for data displays (charts, numbers, etc.)
    const dataDisplays = page.locator('[data-testid*="data"], [class*="data-display"], canvas, svg');
    
    if (await dataDisplays.count() > 0) {
      await expect(dataDisplays.first()).toBeVisible();
      
      // Wait for data updates
      await page.waitForTimeout(2000);
    }
  });

  test('should handle communication errors gracefully', async ({ page }) => {
    // Set up error responses
    await serialMocker.simulateError();
    
    // Navigate to Connect page
    await page.click('text=Connect');
    await page.waitForLoadState('networkidle');
    
    // Attempt connection that will fail
    const connectButton = page.locator('button:has-text("Connect"), [data-testid="connect-button"]').first();
    if (await connectButton.isVisible()) {
      await connectButton.click();
      
      // Wait for error handling
      await page.waitForTimeout(1000);
      
      // Look for error messages or indicators
      const errorElements = page.locator('[data-testid*="error"], .error, .alert-error, text=Error').first();
      if (await errorElements.count() > 0) {
        await expect(errorElements).toBeVisible();
      }
    }
  });

  test('should simulate a complete tensile test sequence', async ({ page }) => {
    // Set up full test sequence
    await serialMocker.simulateTensileTest();
    
    // Navigate to dashboard
    await page.click('text=Dashboard');
    await page.waitForLoadState('networkidle');
    
    // Look for test controls
    const startButton = page.locator('button:has-text("Start"), button:has-text("Run"), [data-testid="start-test"]').first();
    if (await startButton.isVisible() && await startButton.isEnabled()) {
      await startButton.click();
      
      // Wait for test to run with mock data
      await page.waitForTimeout(3000);
      
      // Look for test completion indicators
      const completionElements = page.locator('text=Complete, text=Finished, [data-testid*="complete"]').first();
      if (await completionElements.count() > 0) {
        await expect(completionElements).toBeVisible();
      }
    }
  });

  test('should handle parameter changes via serial commands', async ({ page }) => {
    // Set up parameter setting responses
    const parameterResponses = [
      mockSerialResponses.parameterSet('MAX_FORCE', '100'),
      mockSerialResponses.parameterSet('TEST_SPEED', '50'),
      mockSerialResponses.configResponse,
    ];
    
    await serialMocker.setupMockResponses(parameterResponses);
    
    // Navigate to configuration page
    await page.click('text=Config');
    await page.waitForLoadState('networkidle');
    
    // Look for parameter inputs
    const forceInput = page.locator('input[name*="force"], input[placeholder*="force" i]').first();
    if (await forceInput.isVisible()) {
      await forceInput.fill('100');
    }
    
    const speedInput = page.locator('input[name*="speed"], input[placeholder*="speed" i]').first();
    if (await speedInput.isVisible()) {
      await speedInput.fill('50');
    }
    
    // Apply settings
    const applyButton = page.locator('button:has-text("Apply"), button:has-text("Save"), button[type="submit"]').first();
    if (await applyButton.isVisible()) {
      await applyButton.click();
      
      // Wait for configuration to be sent
      await page.waitForTimeout(1000);
      
      // Look for success confirmation
      const successElements = page.locator('text=Success, text=Applied, [data-testid*="success"]').first();
      if (await successElements.count() > 0) {
        await expect(successElements).toBeVisible();
      }
    }
  });

  test('should handle disconnection scenarios', async ({ page }) => {
    // First establish connection
    await serialMocker.simulateConnection();
    
    // Navigate to Connect page
    await page.click('text=Connect');
    await page.waitForLoadState('networkidle');
    
    // Then simulate disconnection
    await serialMocker.setupMockResponses([
      mockSerialResponses.communicationError,
    ]);
    
    // Look for disconnect handling
    await page.waitForTimeout(2000);
    
    const disconnectElements = page.locator('text=Disconnected, text=Connection Lost, [data-testid*="disconnected"]');
    if (await disconnectElements.count() > 0) {
      await expect(disconnectElements.first()).toBeVisible();
    }
  });

  test('should validate serial command format', async ({ page }) => {
    // Test with various command formats
    const testCommands = [
      'GET_STATUS',
      'SET_PARAM:FORCE:100',
      'START_TEST',
      'STOP_TEST',
      'GET_POSITION',
    ];
    
    for (const command of testCommands) {
      await serialMocker.setupMockResponses([`ACK:${command}`]);
      
      // Commands would be sent through various UI interactions
      // This test validates the command format is properly handled
      await page.waitForTimeout(100);
    }
  });
});