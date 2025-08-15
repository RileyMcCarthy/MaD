import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';

/**
 * Launches the Electron application with proper configuration for testing
 */
export async function launchElectronApp(): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const appPath = process.env.MAD_CONTROL_DIST_PATH;

  console.log(`Environment variables:`);
  console.log(`  MAD_CONTROL_DIST_PATH: ${appPath}`);
  console.log(`  ELECTRON_DISABLE_SANDBOX: ${process.env.ELECTRON_DISABLE_SANDBOX}`);
  console.log(`  DISPLAY: ${process.env.DISPLAY}`);

  if (!appPath) {
    throw new Error('MAD_CONTROL_DIST_PATH environment variable not set');
  }

  console.log(`Launching Electron app: ${appPath}`);
  console.log(`App main.js exists: ${fs.existsSync(appPath)}`);

  if (!fs.existsSync(appPath)) {
    throw new Error(`App main.js not found at: ${appPath}`);
  }

  try {
    console.log('Launching MaD Control Electron app...');
    console.log(`Display environment: ${process.env.DISPLAY}`);

    // Launch using Electron CLI with the built app main.js
    const electronApp = await electron.launch({
      args: [
        appPath,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-gpu',
        '--disable-gpu-sandbox',
      ],
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ':99',
        ELECTRON_DISABLE_SANDBOX: '1',
      },
      timeout: 90000, // Increased timeout for CI environments
    });

    console.log('Executable launched successfully, waiting for first window...');
    console.log('This may take up to 60 seconds in CI environments...');

    // Get the first page (main window) with extended timeout for CI environments
    const page = await electronApp.firstWindow({ timeout: 60000 });

    console.log('✓ First window obtained successfully');

    // Setup console log monitoring
    page.on('console', (msg) => {
      console.log(`Console ${msg.type()}: ${msg.text()}`);
    });

    // Setup error monitoring
    page.on('pageerror', (error) => {
      console.log(`Page error: ${error.message}`);
    });

    console.log('Waiting for app to be ready...');
    // Wait for the app to be ready
    await page.waitForLoadState('domcontentloaded');

    // Wait for React to load
    await page.waitForSelector('#root', { timeout: 10000 });
    await page.waitForTimeout(5000); // Give extra time for React components to render

    console.log('✓ App is fully loaded and ready');

    return { electronApp, page };
  } catch (error) {
    console.log('❌ Failed to launch Electron app:', error);
    console.error('Error type:', error.constructor.name);
    console.error('Error details:', error.message);
    console.log(`App main.js path: ${appPath}`);
    console.log(`App main.js exists: ${fs.existsSync(appPath)}`);

    // Additional debugging for timeout errors
    if (error.message.includes('timeout') || error.message.includes('Timeout')) {
      console.error('This appears to be a timeout error. Possible causes:');
      console.error('1. Electron app is not creating a window');
      console.error('2. Display server (Xvfb) is not running properly');
      console.error('3. App is failing to load renderer content');
      console.error('4. Sandbox restrictions are preventing window creation');
      console.error('');
      console.error('Environment check:');
      console.error(`DISPLAY: ${process.env.DISPLAY}`);
      console.error(`ELECTRON_DISABLE_SANDBOX: ${process.env.ELECTRON_DISABLE_SANDBOX}`);
    }

    throw error;
  }
}

/**
 * Opens the navigation drawer if it exists and is not already open
 */
export async function openDrawerIfExists(page: Page): Promise<boolean> {
  const menuButtonSelectors = [
    '[aria-label="open drawer"]',
    'button:has(svg):first-child',
    '.MuiIconButton-root:first-child',
    'button[edge="start"]',
  ];

  for (const selector of menuButtonSelectors) {
    const btn = page.locator(selector);
    const count = await btn.count();
    if (count > 0) {
      try {
        // Check if the button is visible before clicking
        const isVisible = await btn.first().isVisible({ timeout: 2000 });
        if (isVisible) {
          await btn.first().click();
          await page.waitForTimeout(1000);
          console.log(`Navigation drawer opened with selector: ${selector}`);
          return true;
        }
      } catch (error) {
        console.log(`Could not click menu button with selector ${selector}:`, error.message);
      }
    }
  }
  console.log('Navigation drawer button not found or not clickable - drawer might already be open');
  return false;
}

/**
 * Navigates to a specific page using the navigation drawer
 */
export async function navigateToPage(page: Page, pageName: string): Promise<void> {
  // Open navigation drawer if needed
  const drawerOpened = await openDrawerIfExists(page);
  if (drawerOpened) {
    await page.waitForTimeout(500);
  }

  // Navigate to the specified page
  const navItem = page.locator('.MuiListItemButton-root').filter({ hasText: pageName });
  await navItem.waitFor({ state: 'visible', timeout: 10000 });
  await navItem.click();

  // Wait for page change
  await page.waitForTimeout(2000);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
}

/**
 * Ensures connection to the firmware emulator via serial port
 */
export async function ensureConnected(page: Page, serialPortPath: string = '/tmp/tty.rpi_client'): Promise<void> {
  // Check if virtual serial port exists
  if (!fs.existsSync(serialPortPath)) {
    throw new Error(
      `❌ Virtual serial port not found at ${serialPortPath}. ` +
      'The firmware emulator must be running to execute connected tests. ' +
      'Check that the firmware build succeeded and the emulator started properly.'
    );
  }
  console.log('Virtual serial port found at:', serialPortPath);

  // Navigate to Connect page
  await navigateToPage(page, 'Connect');

  // Wait for Connect form
  await page.waitForSelector('text=Connect to Device', { timeout: 10000 });
  await page.waitForSelector('input[name="port"]', { timeout: 10000 });

  // Fill port and submit
  await page.fill('input[name="port"]', '');
  await page.fill('input[name="port"]', serialPortPath);

  const connectButton = page.locator('button[type="submit"]:has-text("Connect")');
  await connectButton.waitFor({ state: 'visible', timeout: 10000 });
  await connectButton.click();

  // Give time for connection; do not overfit to specific UI messages
  await page.waitForTimeout(3000);
}

/**
 * Takes screenshots of all navigation pages
 */
export async function screenshotAllPages(page: Page, prefix: string): Promise<void> {
  // Ensure screenshot directory exists
  const screenshotDir = 'test-results/screenshots';
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  // Take screenshot of initial state
  await page.screenshot({
    path: `${screenshotDir}/${prefix}-01-initial-state.png`,
    fullPage: true,
  });

  // Wait for Material UI components to load
  await page.waitForSelector('.MuiAppBar-root', { timeout: 15000 });
  console.log('Material UI AppBar found');

  // Open navigation drawer
  const drawerOpened = await openDrawerIfExists(page);
  if (drawerOpened) {
    await page.screenshot({
      path: `${screenshotDir}/${prefix}-02-drawer-opened.png`,
      fullPage: true,
    });
  }

  // Find navigation items
  const navItems = await page.locator('.MuiListItemButton-root').all();
  console.log(`Found ${navItems.length} navigation items for ${prefix}`);

  if (navItems.length === 0) {
    console.log(`No navigation items found for ${prefix}`);
    await page.screenshot({
      path: `${screenshotDir}/${prefix}-03-no-nav-items.png`,
      fullPage: true,
    });
    return;
  }

  // Screenshot each navigation page
  const maxPages = Math.min(navItems.length, 7);
  for (let i = 0; i < maxPages; i++) {
    try {
      const navItem = navItems[i];

      // Get navigation text for naming
      const navText = (await navItem.textContent()) || `page-${i}`;
      const pageName = navText.toLowerCase().replace(/[^a-z0-9]/g, '-');

      console.log(`[${prefix}] Clicking navigation item ${i + 1}: ${navText}`);

      // Click the navigation item
      await navItem.click();

      // Wait for page change
      await page.waitForTimeout(2000);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);

      // Take screenshot
      const screenshotName = `${prefix}-${String(i + 3).padStart(2, '0')}-${pageName}.png`;
      await page.screenshot({
        path: `${screenshotDir}/${screenshotName}`,
        fullPage: true,
      });

      console.log(`Screenshot saved: ${screenshotName}`);
    } catch (error) {
      console.log(`Error with navigation item ${i} for ${prefix}:`, error.message);

      await page.screenshot({
        path: `${screenshotDir}/${prefix}-${String(i + 3).padStart(2, '0')}-error.png`,
        fullPage: true,
      });
    }
  }
}

/**
 * Takes an error screenshot for debugging failed tests
 */
export async function takeErrorScreenshot(page: Page, testName: string = 'error'): Promise<void> {
  try {
    const screenshotDir = 'test-results/screenshots';
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    await page.screenshot({
      path: `${screenshotDir}/${testName}-error-state.png`,
      fullPage: true,
    });
  } catch (screenshotError) {
    console.log('Failed to take error screenshot:', screenshotError.message);
  }
}

/**
 * Waits for a specific element with better error messaging
 */
export async function waitForElement(page: Page, selector: string, timeout: number = 10000): Promise<void> {
  try {
    await page.waitForSelector(selector, { timeout });
  } catch (error) {
    throw new Error(`Element not found: ${selector} (waited ${timeout}ms)`);
  }
}

/**
 * Fills an input field with proper clearing and validation
 */
export async function fillInput(page: Page, selector: string, value: string): Promise<void> {
  await page.fill(selector, ''); // Clear first
  await page.fill(selector, value);

  // Verify the value was set correctly
  const inputValue = await page.inputValue(selector);
  if (inputValue !== value) {
    throw new Error(`Failed to set input value. Expected: ${value}, Got: ${inputValue}`);
  }
}
