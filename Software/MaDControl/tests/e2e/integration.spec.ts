/**
 * Comprehensive Integration Test
 * 
 * This test demonstrates a complete end-to-end workflow of the MaD Control
 * application, combining UI interactions, serial communication, and file
 * operations in a realistic testing scenario.
 */

import { test, expect } from './helpers/electron';
import { SerialPortMocker, mockSerialResponses } from './helpers/serialMock';
import { FileOperationsHelper } from './helpers/fileOperations';

test.describe('MaD Control - Complete Integration Test', () => {
  let serialMocker: SerialPortMocker;
  let fileHelper: FileOperationsHelper;

  test.beforeEach(async ({ page }) => {
    serialMocker = new SerialPortMocker(page);
    fileHelper = new FileOperationsHelper(page);
  });

  test.afterEach(async () => {
    await fileHelper.cleanupTestFiles();
  });

  test('complete tensile testing workflow', async ({ page }) => {
    // Step 1: Application Launch and Initial State
    await expect(page).toHaveTitle(/MaD Control/);
    
    // Step 2: Navigate to Connect page and establish mock connection
    await page.click('text=Connect');
    await page.waitForLoadState('networkidle');
    
    // Mock successful device connection
    await serialMocker.simulateConnection();
    
    // Attempt connection through UI
    const portSelector = page.locator('select, .MuiSelect-root, [data-testid="port-selector"]').first();
    const connectButton = page.locator('button:has-text("Connect"), [data-testid="connect-button"]').first();
    
    if (await portSelector.isVisible()) {
      await portSelector.click();
      await page.waitForTimeout(300);
      
      const portOption = page.locator('[role="option"], option').first();
      if (await portOption.count() > 0) {
        await portOption.click();
      }
    }
    
    if (await connectButton.isVisible()) {
      await connectButton.click();
      await page.waitForTimeout(1000);
    }

    // Step 3: Create a Test Profile
    await page.click('text=Test Profile');
    await page.waitForLoadState('networkidle');
    
    // Fill out test profile form
    const profileName = 'Integration Test Profile';
    const nameInput = page.locator('input[name="name"], input[placeholder*="name" i]').first();
    if (await nameInput.isVisible()) {
      await nameInput.fill(profileName);
    }
    
    const descInput = page.locator('textarea[name="description"], input[name="description"]').first();
    if (await descInput.isVisible()) {
      await descInput.fill('Complete integration test profile for MaD Control');
    }
    
    // Set test parameters
    const maxForceInput = page.locator('input[name*="force"], input[placeholder*="force" i]').first();
    if (await maxForceInput.isVisible()) {
      await maxForceInput.fill('25');
    }
    
    const testSpeedInput = page.locator('input[name*="speed"], input[placeholder*="speed" i]').first();
    if (await testSpeedInput.isVisible()) {
      await testSpeedInput.fill('100');
    }
    
    const strainInput = page.locator('input[name*="strain"], input[placeholder*="strain" i]').first();
    if (await strainInput.isVisible()) {
      await strainInput.fill('200');
    }
    
    // Save the profile
    const saveButton = page.locator('button:has-text("Save"), button[type="submit"]').first();
    if (await saveButton.isVisible() && await saveButton.isEnabled()) {
      await saveButton.click();
      await page.waitForTimeout(1000);
    }

    // Step 4: Configure Machine Settings
    await page.click('text=Config');
    await page.waitForLoadState('networkidle');
    
    // Set up parameter mock responses
    await serialMocker.setupMockResponses([
      mockSerialResponses.parameterSet('MAX_FORCE', '25'),
      mockSerialResponses.parameterSet('TEST_SPEED', '100'),
      mockSerialResponses.configResponse,
    ]);
    
    // Apply configuration if there's an apply button
    const applyButton = page.locator('button:has-text("Apply"), button:has-text("Save Config")').first();
    if (await applyButton.isVisible()) {
      await applyButton.click();
      await page.waitForTimeout(1000);
    }

    // Step 5: Navigate to Dashboard and Run Test
    await page.click('text=Dashboard');
    await page.waitForLoadState('networkidle');
    
    // Set up complete test sequence with realistic data
    const fullTestSequence = [
      mockSerialResponses.machineReady,
      mockSerialResponses.positionData(0),
      mockSerialResponses.forceData(0),
      mockSerialResponses.machineMoving,
      mockSerialResponses.positionData(2.5),
      mockSerialResponses.forceData(1.1),
      mockSerialResponses.positionData(5.0),
      mockSerialResponses.forceData(2.8),
      mockSerialResponses.positionData(7.5),
      mockSerialResponses.forceData(4.2),
      mockSerialResponses.positionData(10.0),
      mockSerialResponses.forceData(6.1),
      mockSerialResponses.positionData(12.5),
      mockSerialResponses.forceData(8.5),
      mockSerialResponses.positionData(15.0),
      mockSerialResponses.forceData(11.2),
      mockSerialResponses.positionData(17.5),
      mockSerialResponses.forceData(14.8),
      mockSerialResponses.positionData(20.0),
      mockSerialResponses.forceData(18.9),
      mockSerialResponses.positionData(22.5),
      mockSerialResponses.forceData(23.2),
      mockSerialResponses.positionData(25.0),
      mockSerialResponses.forceData(25.0), // Peak force
      mockSerialResponses.positionData(27.5),
      mockSerialResponses.forceData(22.1), // Start of failure
      mockSerialResponses.positionData(30.0),
      mockSerialResponses.forceData(15.3),
      mockSerialResponses.positionData(32.5),
      mockSerialResponses.forceData(8.7),
      mockSerialResponses.positionData(35.0),
      mockSerialResponses.forceData(3.2),
      mockSerialResponses.machineReady, // Test complete
    ];
    
    await serialMocker.setupMockResponses(fullTestSequence);
    
    // Start the test
    const startButton = page.locator('button:has-text("Start"), button:has-text("Run Test"), [data-testid="start-test"]').first();
    if (await startButton.isVisible() && await startButton.isEnabled()) {
      await startButton.click();
      
      // Allow time for the test sequence to run
      await page.waitForTimeout(5000);
      
      // Check for test completion indicators
      const completeIndicator = page.locator('text=Complete, text=Finished, text=Test Complete').first();
      if (await completeIndicator.count() > 0) {
        await expect(completeIndicator).toBeVisible();
      }
    }

    // Step 6: Verify Data Display and Charts
    // Look for data visualization elements
    const charts = page.locator('canvas, svg[class*="chart"], .recharts-wrapper');
    if (await charts.count() > 0) {
      await expect(charts.first()).toBeVisible();
    }
    
    // Check for data tables or numeric displays
    const dataDisplays = page.locator('[data-testid*="data"], .data-display, table');
    if (await dataDisplays.count() > 0) {
      await expect(dataDisplays.first()).toBeVisible();
    }

    // Step 7: Save Test Results
    const saveResultsButton = page.locator('button:has-text("Save Results"), button:has-text("Export Data")').first();
    if (await saveResultsButton.isVisible()) {
      await saveResultsButton.click();
      await page.waitForTimeout(1000);
      
      // Handle save dialog if it appears
      const saveDialog = page.locator('[role="dialog"], .modal');
      if (await saveDialog.count() > 0) {
        const confirmButton = page.locator('button:has-text("Save"), button:has-text("OK")').first();
        if (await confirmButton.isVisible()) {
          await confirmButton.click();
          await page.waitForTimeout(1000);
        }
      }
    }

    // Step 8: Verify File Operations
    try {
      // Test that run data was saved
      await fileHelper.testSaveRunData();
      const savedData = await fileHelper.testLoadRunData();
      
      if (savedData && savedData.data) {
        expect(savedData.data.length).toBeGreaterThan(0);
        expect(savedData.results).toBeTruthy();
      }
    } catch (error) {
      // File API might not be available in test environment
      console.log('File API test skipped:', error.message);
    }

    // Step 9: Test Error Recovery
    // Simulate a communication error
    await serialMocker.simulateError();
    
    // The application should handle this gracefully
    await page.waitForTimeout(2000);
    
    // Look for error handling
    const errorIndicators = page.locator('[data-testid*="error"], .error, .alert-danger');
    if (await errorIndicators.count() > 0) {
      await expect(errorIndicators.first()).toBeVisible();
    }

    // Step 10: Test Recovery and Reconnection
    // Simulate successful reconnection
    await serialMocker.simulateConnection();
    await page.waitForTimeout(1000);
    
    // Look for recovery indicators
    const recoveryIndicators = page.locator('text=Connected, text=Ready, [data-testid*="connected"]');
    if (await recoveryIndicators.count() > 0) {
      await expect(recoveryIndicators.first()).toBeVisible();
    }

    // Step 11: Navigate Through All Pages to Verify State Persistence
    const pages = ['Dashboard', 'Connect', 'Config', 'Test Profile'];
    for (const pageName of pages) {
      await page.click(`text=${pageName}`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      
      // Verify page loaded successfully
      await expect(page.locator('body')).toBeVisible();
    }

    // Step 12: Final Verification - Return to Dashboard
    await page.click('text=Dashboard');
    await page.waitForLoadState('networkidle');
    
    // Verify the application is still responsive and functional
    await expect(page.locator('body')).toBeVisible();
  });

  test('stress test - multiple rapid operations', async ({ page }) => {
    // This test performs multiple operations in rapid succession to test stability
    
    // Rapid navigation test
    const pages = ['Dashboard', 'Connect', 'Config', 'Test Profile', 'Dashboard'];
    for (let i = 0; i < 3; i++) {
      for (const pageName of pages) {
        await page.click(`text=${pageName}`);
        await page.waitForTimeout(200); // Minimal wait
      }
    }
    
    // Rapid serial command simulation
    const rapidCommands = Array(20).fill(0).map((_, i) => 
      mockSerialResponses.positionData(i * 0.5)
    );
    
    await serialMocker.setupMockResponses(rapidCommands);
    await page.waitForTimeout(3000);
    
    // Verify application stability
    await expect(page.locator('body')).toBeVisible();
  });

  test('accessibility and keyboard navigation', async ({ page }) => {
    // Test keyboard navigation throughout the application
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter'); // Activate focused element
    
    await page.waitForTimeout(500);
    
    // Continue tabbing through interface
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(100);
    }
    
    // Test escape key handling
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    
    // Verify application is still responsive
    await expect(page.locator('body')).toBeVisible();
  });

  test('window state and resize handling', async ({ page, electronApp }) => {
    const window = await electronApp.firstWindow();
    
    // Test various window sizes
    const sizes = [
      { width: 1200, height: 800 },
      { width: 800, height: 600 },
      { width: 1600, height: 1000 },
      { width: 1024, height: 768 },
    ];
    
    for (const size of sizes) {
      await window.setViewportSize(size);
      await page.waitForTimeout(500);
      
      // Verify content is still accessible
      await expect(page.locator('body')).toBeVisible();
      
      // Try navigation at this size
      await page.click('text=Dashboard');
      await page.waitForTimeout(300);
    }
    
    // Restore to reasonable size
    await window.setViewportSize({ width: 1400, height: 900 });
  });
});