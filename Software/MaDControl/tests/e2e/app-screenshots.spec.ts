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
    
    // Wait for React to load - use a simpler approach that doesn't violate CSP
    await page.waitForSelector('#root', { timeout: 10000 });
    await page.waitForTimeout(5000); // Give extra time for React components to render
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test('should automatically screenshot all navbar pages', async () => {
    // Verify the page loaded correctly
    const title = await page.title();
    console.log(`Page title: ${title}`);
    
    // Check DOM structure
    const bodyContent = await page.evaluate(() => document.body.outerHTML);
    console.log(`Body content length: ${bodyContent.length} characters`);
    
    // Check if React root has content
    const reactRootContent = await page.evaluate(() => {
      const root = document.querySelector('#root');
      return root ? root.innerHTML.length : 0;
    });
    console.log(`React root content length: ${reactRootContent} characters`);

    // Take screenshot of initial state
    await page.screenshot({ 
      path: 'test-results/screenshots/01-initial-state.png',
      fullPage: true 
    });

    // Wait for Material UI components to load
    await page.waitForSelector('.MuiAppBar-root', { timeout: 15000 });
    console.log('Material UI AppBar found');

    // Look for the hamburger menu button
    const menuButtonSelectors = [
      '[aria-label="open drawer"]',
      'button:has(svg):first-child',  // First button with an SVG (likely menu)
      '.MuiIconButton-root:first-child',
      'button[edge="start"]'
    ];

    let menuButton = null;
    for (const selector of menuButtonSelectors) {
      const btn = page.locator(selector);
      const count = await btn.count();
      if (count > 0) {
        menuButton = btn.first();
        console.log(`Found menu button with selector: ${selector}`);
        break;
      }
    }

    if (menuButton) {
      await menuButton.click();
      await page.waitForTimeout(1000); // Wait for drawer animation
      console.log('Navigation drawer opened');
      
      // Take screenshot with drawer open
      await page.screenshot({ 
        path: 'test-results/screenshots/02-drawer-opened.png',
        fullPage: true 
      });
    } else {
      console.log('Menu button not found, proceeding without opening drawer');
    }

    // Look for navigation items
    const navItems = await page.locator('.MuiListItemButton-root').all();
    console.log(`Found ${navItems.length} navigation items`);
    
    if (navItems.length === 0) {
      // Try alternative selectors
      const altItems = await page.locator('a, button').all();
      console.log(`Found ${altItems.length} total clickable elements`);
      
      // Take debug screenshot
      await page.screenshot({ 
        path: 'test-results/screenshots/03-debug-no-nav.png',
        fullPage: true 
      });
      return;
    }

    // Screenshot each navigation page
    const maxPages = Math.min(navItems.length, 7); // Limit to expected number of pages
    for (let i = 0; i < maxPages; i++) {
      try {
        const navItem = navItems[i];
        
        // Get navigation text for naming
        const navText = await navItem.textContent() || `page-${i}`;
        const pageName = navText.toLowerCase().replace(/[^a-z0-9]/g, '-');
        
        console.log(`Clicking navigation item ${i + 1}: ${navText}`);
        
        // Click the navigation item
        await navItem.click();
        
        // Wait for page change
        await page.waitForTimeout(2000);
        
        // Wait for any loading to complete
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1000);
        
        // Take screenshot
        const screenshotName = `${String(i + 3).padStart(2, '0')}-${pageName}.png`;
        await page.screenshot({ 
          path: `test-results/screenshots/${screenshotName}`,
          fullPage: true 
        });
        
        console.log(`Screenshot saved: ${screenshotName}`);
        
      } catch (error) {
        console.log(`Error with navigation item ${i}:`, error.message);
        
        // Take error screenshot
        await page.screenshot({ 
          path: `test-results/screenshots/${String(i + 3).padStart(2, '0')}-error.png`,
          fullPage: true 
        });
      }
    }
  });
});