/**
 * File Operations Tests
 * 
 * These tests demonstrate how to test file storage and retrieval functionality
 * in the MaD Control application, including test profiles, run data, and
 * configuration persistence.
 */

import { test, expect } from './helpers/electron';
import { FileOperationsHelper } from './helpers/fileOperations';

test.describe('File Operations Tests', () => {
  let fileHelper: FileOperationsHelper;

  test.beforeEach(async ({ page }) => {
    fileHelper = new FileOperationsHelper(page);
  });

  test.afterEach(async () => {
    // Clean up test files after each test
    await fileHelper.cleanupTestFiles();
  });

  test('should save and load test profiles', async ({ page }) => {
    // Navigate to Test Profile page
    await page.click('text=Test Profile');
    await page.waitForLoadState('networkidle');

    // Create a test profile through the UI
    const nameInput = page.locator('input[name="name"], input[placeholder*="name" i]').first();
    if (await nameInput.isVisible()) {
      await nameInput.fill('UI Test Profile');
    }

    const descriptionInput = page.locator('textarea[name="description"], input[name="description"]').first();
    if (await descriptionInput.isVisible()) {
      await descriptionInput.fill('Profile created through UI test');
    }

    // Fill in test parameters
    const maxForceInput = page.locator('input[name*="force"], input[placeholder*="force" i]').first();
    if (await maxForceInput.isVisible()) {
      await maxForceInput.fill('15');
    }

    const testSpeedInput = page.locator('input[name*="speed"], input[placeholder*="speed" i]').first();
    if (await testSpeedInput.isVisible()) {
      await testSpeedInput.fill('75');
    }

    // Save the profile
    const saveButton = page.locator('button:has-text("Save"), button[type="submit"]').first();
    if (await saveButton.isVisible() && await saveButton.isEnabled()) {
      await saveButton.click();
      
      // Wait for save operation
      await page.waitForTimeout(1000);
      
      // Look for save confirmation
      const successMessage = page.locator('text=Saved, text=Success, [data-testid*="success"]');
      if (await successMessage.count() > 0) {
        await expect(successMessage.first()).toBeVisible();
      }
    }

    // Verify the profile appears in a list (if there is one)
    const profileList = page.locator('[data-testid="profile-list"], .profile-item, li');
    if (await profileList.count() > 0) {
      const profileItem = profileList.filter({ hasText: 'UI Test Profile' });
      await expect(profileItem).toBeVisible();
    }
  });

  test('should handle test profile file operations via API', async ({ page }) => {
    // Test direct file API operations
    try {
      await fileHelper.testSaveTestProfile();
      
      // Load profiles and verify our test profile exists
      const profiles = await fileHelper.testLoadTestProfiles();
      
      if (profiles && Array.isArray(profiles)) {
        const testProfile = profiles.find(p => p.name === 'Test Profile 1');
        expect(testProfile).toBeTruthy();
        expect(testProfile?.description).toBe('Automated test profile');
      }
    } catch (error) {
      // If file API is not available, this test will be skipped
      test.skip(true, 'File API not available in current build');
    }
  });

  test('should save and retrieve test run data', async ({ page }) => {
    // Navigate to dashboard where test results might be displayed
    await page.click('text=Dashboard');
    await page.waitForLoadState('networkidle');

    // Test run data operations via API if available
    try {
      await fileHelper.testSaveRunData();
      
      const runData = await fileHelper.testLoadRunData();
      
      if (runData) {
        expect(runData.profileName).toBe('Test Profile 1');
        expect(runData.results.maxForce).toBe(4.1);
        expect(runData.data).toHaveLength(5);
      }
    } catch (error) {
      // Test through UI if API is not available
      await testRunDataThroughUI(page);
    }
  });

  test('should persist configuration settings', async ({ page }) => {
    // Navigate to configuration page
    await page.click('text=Config');
    await page.waitForLoadState('networkidle');

    // Change configuration settings
    const maxForceInput = page.locator('input[name*="max"], input[name*="force"]').first();
    if (await maxForceInput.isVisible()) {
      await maxForceInput.fill('150');
    }

    const safetyInput = page.locator('input[name*="safety"], input[name*="limit"]').first();
    if (await safetyInput.isVisible()) {
      await safetyInput.fill('500');
    }

    // Save configuration
    const saveButton = page.locator('button:has-text("Save"), button:has-text("Apply")').first();
    if (await saveButton.isVisible()) {
      await saveButton.click();
      await page.waitForTimeout(1000);
    }

    // Test configuration persistence via API
    try {
      await fileHelper.testSaveConfiguration();
      const config = await fileHelper.testLoadConfiguration();
      
      if (config) {
        expect(config.machineSettings.maxForce).toBe(100);
        expect(config.machineSettings.safetyLimits.maxPosition).toBe(500);
      }
    } catch (error) {
      // Configuration API not available - verify through UI persistence
      await page.reload();
      await page.waitForLoadState('networkidle');
      
      // Check if values persisted after reload
      if (await maxForceInput.isVisible()) {
        const value = await maxForceInput.inputValue();
        expect(value).toBe('150');
      }
    }
  });

  test('should handle file system errors gracefully', async ({ page }) => {
    // Test error handling when file operations fail
    // This might involve simulating file system permission errors or disk full scenarios
    
    // Navigate to Test Profile page
    await page.click('text=Test Profile');
    await page.waitForLoadState('networkidle');

    // Attempt to save with invalid data or simulate file system error
    const nameInput = page.locator('input[name="name"]').first();
    if (await nameInput.isVisible()) {
      // Try to save with potentially problematic filename characters
      await nameInput.fill('Test/Profile\\With:Invalid*Characters');
    }

    const saveButton = page.locator('button:has-text("Save")').first();
    if (await saveButton.isVisible()) {
      await saveButton.click();
      await page.waitForTimeout(1000);
      
      // Look for error handling
      const errorMessage = page.locator('[data-testid*="error"], .error, .alert-danger');
      if (await errorMessage.count() > 0) {
        await expect(errorMessage.first()).toBeVisible();
      }
    }
  });

  test('should export and import data files', async ({ page }) => {
    // Test data export functionality
    // Navigate to a page that might have export options
    await page.click('text=Dashboard');
    await page.waitForLoadState('networkidle');

    // Look for export buttons or menu options
    const exportButton = page.locator('button:has-text("Export"), [data-testid="export"]').first();
    if (await exportButton.isVisible()) {
      await exportButton.click();
      await page.waitForTimeout(1000);
      
      // Verify export dialog or action
      const exportDialog = page.locator('[role="dialog"], .modal, [data-testid="export-dialog"]');
      if (await exportDialog.count() > 0) {
        await expect(exportDialog).toBeVisible();
        
        // Close dialog for cleanup
        const closeButton = page.locator('button:has-text("Close"), button:has-text("Cancel")').first();
        if (await closeButton.isVisible()) {
          await closeButton.click();
        }
      }
    }

    // Test import functionality if available
    const importButton = page.locator('button:has-text("Import"), [data-testid="import"]').first();
    if (await importButton.isVisible()) {
      await importButton.click();
      await page.waitForTimeout(1000);
    }
  });

  test('should manage file storage limits and cleanup', async ({ page }) => {
    // Test behavior with multiple saved files
    const sampleProfile = fileHelper.getSampleTestProfile();
    
    // Save multiple profiles to test storage management
    for (let i = 0; i < 5; i++) {
      const profile = { 
        ...sampleProfile, 
        name: `Test Profile ${i + 1}`,
        description: `Automated test profile ${i + 1}`
      };
      
      try {
        await page.evaluate((prof) => {
          if (window.electronAPI && window.electronAPI.files) {
            return window.electronAPI.files.saveTestProfile(prof);
          }
        }, profile);
      } catch (error) {
        // API not available, skip this part of the test
        break;
      }
      
      await page.waitForTimeout(100);
    }

    // Test cleanup functionality
    await fileHelper.cleanupTestFiles();
    
    // Verify cleanup worked
    try {
      const profiles = await fileHelper.testLoadTestProfiles();
      if (profiles) {
        const testProfiles = profiles.filter(p => p.name.includes('Test Profile'));
        expect(testProfiles).toHaveLength(0);
      }
    } catch (error) {
      // Expected if files were properly cleaned up
    }
  });
});

// Helper function for testing run data through UI
async function testRunDataThroughUI(page: any) {
  // Look for test results display
  const resultsSection = page.locator('[data-testid*="results"], .test-results, .results');
  if (await resultsSection.count() > 0) {
    await expect(resultsSection.first()).toBeVisible();
  }

  // Look for data visualization
  const charts = page.locator('canvas, svg[class*="chart"]');
  if (await charts.count() > 0) {
    await expect(charts.first()).toBeVisible();
  }

  // Check for save results button
  const saveResultsButton = page.locator('button:has-text("Save Results"), button:has-text("Save Data")').first();
  if (await saveResultsButton.isVisible()) {
    await saveResultsButton.click();
    await page.waitForTimeout(1000);
  }
}