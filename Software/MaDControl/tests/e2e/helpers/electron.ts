import { test as base, ElectronApplication, Page, _electron as electron } from '@playwright/test';
import path from 'path';

// Extend basic test by providing "electronApp" and "page" fixtures.
export const test = base.extend<{
  electronApp: ElectronApplication;
  page: Page;
}>({
  electronApp: async ({}, use) => {
    // Launch Electron app from the packaged build
    const electronApp = await electron.launch({
      executablePath: path.join(__dirname, '../../../release/build/linux-unpacked/mad-control'),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-web-security',
      ],
      // Set environment to production
      env: {
        ...process.env,
        NODE_ENV: 'production',
        ELECTRON_DEV: '0',
      },
    });

    // Use the app
    await use(electronApp);

    // Clean up
    await electronApp.close();
  },
  page: async ({ electronApp }, use) => {
    // Get the first BrowserWindow that has been opened
    const page = await electronApp.firstWindow();
    
    // Wait for the app to be ready
    await page.waitForLoadState('domcontentloaded');
    
    // Enable console logging to see React errors
    page.on('console', msg => {
      console.log(`[CONSOLE] ${msg.type()}: ${msg.text()}`);
    });
    
    page.on('pageerror', err => {
      console.log(`[PAGE ERROR] ${err.message}`);
    });
    
    // Wait a bit longer for React to load
    await page.waitForTimeout(5000);
    
    await use(page);
  },
});

