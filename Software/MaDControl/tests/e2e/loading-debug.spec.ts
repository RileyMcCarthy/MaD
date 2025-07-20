/**
 * App Loading Debug Test
 * 
 * This test helps diagnose why the React app isn't loading content
 */

import { test, expect } from './helpers/electron';

test.describe('App Loading Debug', () => {
  test('should diagnose app loading issues', async ({ page }) => {
    // Listen to console messages
    page.on('console', msg => {
      console.log(`CONSOLE ${msg.type()}: ${msg.text()}`);
    });
    
    // Listen to page errors
    page.on('pageerror', error => {
      console.log(`PAGE ERROR: ${error.message}`);
    });
    
    // Listen to request failures
    page.on('requestfailed', request => {
      console.log(`REQUEST FAILED: ${request.url()} - ${request.failure()?.errorText}`);
    });
    
    // Wait for the app to launch
    await page.waitForLoadState('domcontentloaded');
    console.log('DOM content loaded');
    
    // Wait longer for React to mount
    await page.waitForTimeout(5000);
    console.log('Waited 5 seconds for React to mount');
    
    // Check the current URL
    const url = page.url();
    console.log('Current URL:', url);
    
    // Take a screenshot to see what's rendered
    await page.screenshot({ path: 'loading-debug.png', fullPage: true });
    
    // Check body content again
    const bodyHTML = await page.locator('body').innerHTML();
    console.log('Body HTML:', bodyHTML);
    
    // Look for script tags
    const scripts = page.locator('script');
    const scriptCount = await scripts.count();
    console.log(`Found ${scriptCount} script tags`);
    
    for (let i = 0; i < scriptCount; i++) {
      const src = await scripts.nth(i).getAttribute('src');
      if (src) {
        console.log(`Script ${i}: ${src}`);
      }
    }
    
    // Check if webpack dev server or similar is running
    const webpackMarkers = [
      'webpack',
      'hot-reload',
      'react-refresh',
      '__webpack_require__'
    ];
    
    for (const marker of webpackMarkers) {
      const hasMarker = await page.evaluate((m) => {
        return window[m] !== undefined || document.documentElement.innerHTML.includes(m);
      }, marker);
      console.log(`${marker} present:`, hasMarker);
    }
    
    // Try to trigger React manually if needed
    const reactPresent = await page.evaluate(() => {
      return typeof window.React !== 'undefined';
    });
    console.log('React present:', reactPresent);
    
    // Check for any global error messages
    const errorElements = page.locator('.error, .error-message, [class*="error"]');
    const errorCount = await errorElements.count();
    if (errorCount > 0) {
      console.log(`Found ${errorCount} error elements`);
      for (let i = 0; i < errorCount; i++) {
        const errorText = await errorElements.nth(i).textContent();
        console.log(`Error ${i}: ${errorText}`);
      }
    }
    
    // The test passes if the app at least launched (we're debugging, not asserting functionality)
    expect(await page.locator('body').isVisible()).toBeTruthy();
  });
});