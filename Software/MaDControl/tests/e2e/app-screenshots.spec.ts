/**
 * Simple App Screenshot Test
 * 
 * This test opens the MaD Control Electron app and takes screenshots
 * of each page for debugging purposes by Copilot coding agents.
 */

import { test, expect } from '@playwright/test';
import { test as electronTest } from './helpers/electron';

electronTest.describe('MaD Control App Screenshots', () => {
  electronTest('should open app and take screenshots of each page', async ({ page }) => {
    console.log('Starting screenshot test...');
    
    // Wait for React to actually render content
    try {
      await page.waitForSelector('#root > *', { timeout: 15000 });
      console.log('React content loaded');
    } catch (e) {
      console.log('React content not found, continuing with basic screenshot');
    }
    
    // Additional wait to ensure everything is rendered
    await page.waitForTimeout(2000);
    
    // Log page info before screenshot
    const title = await page.title();
    const url = page.url();
    console.log('App title:', title);
    console.log('App URL:', url);
    
    // Get viewport size
    const viewportSize = page.viewportSize();
    console.log('Viewport size:', viewportSize);
    
    // Check if body has content
    const bodyContent = await page.locator('body').innerHTML();
    console.log('Body has content:', bodyContent.length > 100 ? 'Yes' : 'No');
    console.log('Body preview:', bodyContent.substring(0, 300) + '...');
    
    // Check React root content specifically
    const rootContent = await page.locator('#root').innerHTML();
    console.log('React root has content:', rootContent.length > 10 ? 'Yes' : 'No');
    
    // Take a screenshot of the main page
    await page.screenshot({ 
      path: 'proof-main-interface.png', 
      fullPage: true,
      timeout: 10000
    });
    console.log('Screenshot taken: proof-main-interface.png');
    
    // Try to find any visible elements
    const allElements = await page.locator('*').all();
    console.log(`Found ${allElements.length} DOM elements`);
    
    // Try to navigate to different pages and take screenshots
    const navigationButtons = [
      { selector: '[href*="dashboard"], button:has-text("Dashboard")', name: 'dashboard' },
      { selector: '[href*="tests"], button:has-text("Tests")', name: 'tests' },
      { selector: '[href*="create"], button:has-text("Create")', name: 'create' },
      { selector: '[href*="connect"], button:has-text("Connect")', name: 'connect' },
      { selector: '[href*="configuration"], button:has-text("Device Configuration")', name: 'configuration' },
      { selector: '[href*="settings"], button:has-text("Settings")', name: 'settings' },
      { selector: 'nav a, .MuiTabs-root a, [role="tab"]', name: 'nav-tabs' },
    ];
    
    for (const nav of navigationButtons) {
      try {
        const element = page.locator(nav.selector);
        const count = await element.count();
        
        if (count > 0 && nav.name !== 'nav-tabs') {
          console.log(`Found ${count} navigation element(s): ${nav.selector}`);
          
          // Click the first matching element
          await element.first().click();
          await page.waitForTimeout(1000); // Wait for navigation
          
          const filename = `screenshot-${nav.name}.png`;
          await page.screenshot({ path: filename, fullPage: true });
          console.log(`Screenshot taken: ${filename}`);
          
          // Wait a bit before next navigation
          await page.waitForTimeout(500);
        } else if (count > 0 && nav.name === 'nav-tabs') {
          console.log(`Found ${count} navigation tabs/links`);
        }
      } catch (error) {
        console.log(`Could not navigate with ${nav.selector}: ${error.message}`);
      }
    }
    
    // Take a final screenshot
    await page.screenshot({ 
      path: 'proof-final-state.png', 
      fullPage: true,
      timeout: 10000
    });
    console.log('Screenshot taken: proof-final-state.png');
    
    // Basic verification that the app loaded
    expect(await page.locator('body').isVisible()).toBeTruthy();
    
    console.log('Test completed successfully');
  });
});