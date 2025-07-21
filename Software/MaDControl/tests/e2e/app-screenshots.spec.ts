import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

test.describe('MaD Control App Screenshots', () => {
  let electronApp: any;
  let page: any;

  test.beforeAll(async () => {
    // Launch the Electron app with no-sandbox for CI environments
    electronApp = await electron.launch({
      args: [
        path.join(__dirname, '../../release/app/dist/main/main.js'),
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security'
      ],
      executablePath: process.env.ELECTRON_EXECUTABLE || undefined,
    });

    // Get the first page (main window)
    page = await electronApp.firstWindow();
    
    // Wait for the app to be ready
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000); // Allow React components to render and load fully
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test('should capture dashboard page screenshot', async () => {
    // Wait for the app to be fully loaded
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000); // Extra wait for all components to render
    
    // Take screenshot
    await page.screenshot({ 
      path: 'test-results/screenshots/dashboard.png',
      fullPage: true 
    });

    // Verify the page loaded correctly
    await expect(page).toHaveTitle(/MAD Control|MaD Control|Electron/i);
  });

  test('should capture settings page screenshot', async () => {
    // Try to navigate to settings if there's a way to do so
    try {
      // Try to find settings navigation
      const settingsButton = page.locator('text=Settings').first();
      if (await settingsButton.isVisible({ timeout: 5000 })) {
        await settingsButton.click();
        await page.waitForTimeout(1500);
      }
    } catch {
      // Try alternative selectors
      try {
        const settingsLink = page.locator('[data-testid="settings"], .settings-link, a[href*="settings"]').first();
        if (await settingsLink.isVisible({ timeout: 5000 })) {
          await settingsLink.click();
          await page.waitForTimeout(1500);
        }
      } catch {
        console.log('Settings page not found, taking screenshot of current page');
      }
    }
    
    // Wait for page to load
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    
    // Take screenshot
    await page.screenshot({ 
      path: 'test-results/screenshots/settings.png',
      fullPage: true 
    });
  });

  test('should capture serial communication page screenshot', async () => {
    // Try to navigate to serial/communication section
    try {
      const serialButton = page.locator('text=Serial, text=Communication').first();
      if (await serialButton.isVisible({ timeout: 5000 })) {
        await serialButton.click();
        await page.waitForTimeout(1500);
      }
    } catch {
      try {
        const serialLink = page.locator('[data-testid="serial"], .serial-link, a[href*="serial"]').first();
        if (await serialLink.isVisible({ timeout: 5000 })) {
          await serialLink.click();
          await page.waitForTimeout(1500);
        }
      } catch {
        console.log('Serial communication page not found, taking screenshot of current page');
      }
    }
    
    // Wait for page to load
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    
    // Take screenshot
    await page.screenshot({ 
      path: 'test-results/screenshots/serial-communication.png',
      fullPage: true 
    });
  });

  test('should capture test control page screenshot', async () => {
    // Try to navigate to test control section
    try {
      const controlButton = page.locator('text=Test Control, text=Control').first();
      if (await controlButton.isVisible({ timeout: 5000 })) {
        await controlButton.click();
        await page.waitForTimeout(1500);
      }
    } catch {
      try {
        const controlLink = page.locator('[data-testid="test-control"], .control-link, a[href*="control"]').first();
        if (await controlLink.isVisible({ timeout: 5000 })) {
          await controlLink.click();
          await page.waitForTimeout(1500);
        }
      } catch {
        console.log('Test control page not found, taking screenshot of current page');
      }
    }
    
    // Wait for page to load
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    
    // Take screenshot
    await page.screenshot({ 
      path: 'test-results/screenshots/test-control.png',
      fullPage: true 
    });
  });
});