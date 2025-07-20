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
    // Wait for the app to load
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000); // Give React time to render
    
    // Take a screenshot of the main page
    await page.screenshot({ path: 'proof-main-interface.png', fullPage: true });
    console.log('Screenshot taken: proof-main-interface.png');
    
    // Try to navigate to different pages and take screenshots
    const navigationButtons = [
      { selector: 'a[href="/testing"]', name: 'testing-page' },
      { selector: 'a[href="/profile"]', name: 'profile-page' },
      { selector: 'a[href="/settings"]', name: 'settings-page' },
      { selector: 'button:has-text("Testing")', name: 'testing-button' },
      { selector: 'button:has-text("Profile")', name: 'profile-button' },
      { selector: 'button:has-text("Settings")', name: 'settings-button' },
    ];
    
    for (const nav of navigationButtons) {
      try {
        const element = page.locator(nav.selector);
        const count = await element.count();
        
        if (count > 0) {
          console.log(`Found navigation element: ${nav.selector}`);
          await element.first().click();
          await page.waitForTimeout(1000); // Wait for navigation
          
          const filename = `screenshot-${nav.name}.png`;
          await page.screenshot({ path: filename, fullPage: true });
          console.log(`Screenshot taken: ${filename}`);
          
          // Wait a bit before next navigation
          await page.waitForTimeout(500);
        }
      } catch (error) {
        console.log(`Could not navigate with ${nav.selector}: ${error.message}`);
      }
    }
    
    // Take a final screenshot
    await page.screenshot({ path: 'proof-final-state.png', fullPage: true });
    console.log('Screenshot taken: proof-final-state.png');
    
    // Basic verification that the app loaded
    expect(await page.locator('body').isVisible()).toBeTruthy();
    
    // Log some basic app info
    const title = await page.title();
    const url = page.url();
    console.log('App title:', title);
    console.log('App URL:', url);
  });
});