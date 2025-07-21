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

  test('should automatically screenshot all navbar pages', async () => {
    // Wait for the app to be fully loaded
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Verify the page loaded correctly
    await expect(page).toHaveTitle(/MAD Control|MaD Control|Electron/i);

    // Find all navigation links in the sidebar
    const navLinks = await page.locator('nav a, [role="button"] a, .MuiListItemButton-root').all();
    
    console.log(`Found ${navLinks.length} navigation elements`);

    // Take screenshot of initial state
    await page.screenshot({ 
      path: 'test-results/screenshots/initial-state.png',
      fullPage: true 
    });

    // If we can't find nav links via selectors, try to find them by traversing the navbar structure
    const sidebarNavItems = await page.locator('.MuiList-root .MuiListItem-root').all();
    
    console.log(`Found ${sidebarNavItems.length} sidebar navigation items`);

    for (let i = 0; i < sidebarNavItems.length; i++) {
      try {
        const navItem = sidebarNavItems[i];
        
        // Get the text content to name the screenshot
        const textContent = await navItem.textContent();
        const pageName = (textContent || `page-${i}`).toLowerCase().replace(/[^a-z0-9]/g, '-');
        
        console.log(`Navigating to: ${textContent || `Page ${i}`}`);
        
        // Click the navigation item
        await navItem.click();
        
        // Wait for navigation and page load
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(3000); // Extra time for React components
        
        // Take screenshot
        await page.screenshot({ 
          path: `test-results/screenshots/${pageName}.png`,
          fullPage: true 
        });
        
      } catch (error) {
        console.log(`Error navigating to item ${i}:`, error);
        // Still take a screenshot of the current state
        await page.screenshot({ 
          path: `test-results/screenshots/error-state-${i}.png`,
          fullPage: true 
        });
      }
    }

    // If no sidebar items found, take screenshots of known routes directly
    if (sidebarNavItems.length === 0) {
      const knownRoutes = [
        { path: '/dashboard', name: 'dashboard' },
        { path: '/connect', name: 'connect' },
        { path: '/config', name: 'config' },
        { path: '/create', name: 'create' },
        { path: '/firmware', name: 'firmware' }
      ];

      for (const route of knownRoutes) {
        try {
          console.log(`Navigating to route: ${route.path}`);
          
          // Navigate using page.goto or evaluate
          await page.evaluate((path) => {
            window.location.hash = path;
          }, route.path);
          
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(2000);
          
          await page.screenshot({ 
            path: `test-results/screenshots/${route.name}.png`,
            fullPage: true 
          });
        } catch (error) {
          console.log(`Error navigating to ${route.path}:`, error);
        }
      }
    }
  });
});