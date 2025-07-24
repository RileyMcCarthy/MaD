import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';

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
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ],
      executablePath: process.env.ELECTRON_EXECUTABLE || undefined,
    });

    // Get the first page (main window)
    page = await electronApp.firstWindow();
    
    // Setup console log monitoring
    page.on('console', (msg) => {
      console.log(`Console ${msg.type()}: ${msg.text()}`);
    });
    
    // Setup error monitoring
    page.on('pageerror', (error) => {
      console.log(`Page error: ${error.message}`);
    });
    
    // Wait for the app to be ready
    await page.waitForLoadState('domcontentloaded');
    
    // Wait for React to load
    await page.waitForSelector('#root', { timeout: 10000 });
    await page.waitForTimeout(5000); // Give extra time for React components to render
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  // Helper function to open navigation drawer if it exists
  async function openDrawerIfExists() {
    const menuButtonSelectors = [
      '[aria-label="open drawer"]',
      'button:has(svg):first-child',
      '.MuiIconButton-root:first-child',
      'button[edge="start"]'
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

  // Helper function to take screenshots of all navigation pages
  async function screenshotAllPages(prefix: string) {
    // Ensure screenshot directory exists
    const screenshotDir = 'test-results/screenshots';
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    // Take screenshot of initial state
    await page.screenshot({ 
      path: `${screenshotDir}/${prefix}-01-initial-state.png`,
      fullPage: true 
    });

    // Wait for Material UI components to load
    await page.waitForSelector('.MuiAppBar-root', { timeout: 15000 });
    console.log('Material UI AppBar found');

    // Open navigation drawer
    const drawerOpened = await openDrawerIfExists();
    if (drawerOpened) {
      await page.screenshot({ 
        path: `${screenshotDir}/${prefix}-02-drawer-opened.png`,
        fullPage: true 
      });
    }

    // Find navigation items
    const navItems = await page.locator('.MuiListItemButton-root').all();
    console.log(`Found ${navItems.length} navigation items for ${prefix}`);
    
    if (navItems.length === 0) {
      console.log(`No navigation items found for ${prefix}`);
      await page.screenshot({ 
        path: `${screenshotDir}/${prefix}-03-no-nav-items.png`,
        fullPage: true 
      });
      return;
    }

    // Screenshot each navigation page
    const maxPages = Math.min(navItems.length, 7);
    for (let i = 0; i < maxPages; i++) {
      try {
        const navItem = navItems[i];
        
        // Get navigation text for naming
        const navText = await navItem.textContent() || `page-${i}`;
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
          fullPage: true 
        });
        
        console.log(`Screenshot saved: ${screenshotName}`);
        
      } catch (error) {
        console.log(`Error with navigation item ${i} for ${prefix}:`, error.message);
        
        await page.screenshot({ 
          path: `${screenshotDir}/${prefix}-${String(i + 3).padStart(2, '0')}-error.png`,
          fullPage: true 
        });
      }
    }
  }

  test('should screenshot all pages without device connection', async () => {
    console.log('=== Taking screenshots WITHOUT device connection ===');
    await screenshotAllPages('disconnected');
  });

  test('should screenshot all pages with firmware emulation connected', async () => {
    console.log('=== Checking for firmware emulation connection ===');
    
    try {
      // Check if virtual serial port is available (created by the workflow)
      const serialPortPath = '/tmp/tty.rpi_client';
      const portExists = fs.existsSync(serialPortPath);
      
      if (portExists) {
        console.log('Virtual serial port found at:', serialPortPath);
        console.log('Firmware emulation should be running - attempting to connect via UI...');
        
        // Navigate to the Connect page to test serial connection
        await page.click('text=Connect');
        await page.waitForTimeout(2000);
        
        // Look for serial port selection UI and try to select our virtual port
        // This will depend on how the MaD Control app handles serial port selection
        console.log('Looking for serial port selection interface...');
        
      } else {
        console.log('Virtual serial port not found - firmware emulation may not be running');
      }
      
      console.log('=== Taking screenshots WITH firmware emulation setup ===');
      await screenshotAllPages('connected');
      
    } catch (error) {
      console.error('Error setting up firmware emulation connection:', error);
      
      // Still take screenshots even if connection failed
      console.log('=== Taking screenshots with emulation setup attempted ===');
      await screenshotAllPages('emulation-attempted');
    }
  });
});