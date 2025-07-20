import { test as base, ElectronApplication, Page, _electron as electron } from '@playwright/test';
import path from 'path';

// Extend basic test by providing "electronApp" and "page" fixtures.
export const test = base.extend<{
  electronApp: ElectronApplication;
  page: Page;
}>({
  electronApp: async ({}, use) => {
    // Launch Electron app from the built files
    const electronApp = await electron.launch({
      args: [
        path.join(__dirname, '../../../release/app/dist/main/main.js'),
        '--no-sandbox',
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--headless',
      ],
      // Set environment for headless operation
      env: {
        ...process.env,
        DISPLAY: ':99',
        ELECTRON_HEADLESS: '1',
      },
      // Enable for debugging
      // env: { ...process.env, ELECTRON_DEV: '1' },
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
    
    await use(page);
  },
});

export { expect } from '@playwright/test';