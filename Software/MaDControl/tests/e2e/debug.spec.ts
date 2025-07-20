/**
 * Debug Test - Inspect App Structure
 * 
 * This test helps understand the actual structure of the rendered app
 */

import { test, expect } from './helpers/electron';

test.describe('App Structure Debug', () => {
  test('should inspect app DOM structure', async ({ page }) => {
    // Verify the app launches
    await expect(page).toHaveTitle(/MAD Control|MaD Control/i);
    
    // Wait for React to load
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000); // Give React time to render
    
    // Take a screenshot
    await page.screenshot({ path: 'debug-app-structure.png' });
    
    // Get the HTML structure
    const bodyContent = await page.locator('body').innerHTML();
    console.log('Body HTML length:', bodyContent.length);
    
    // Look for React root
    const reactRoot = page.locator('#root, [data-reactroot]');
    if (await reactRoot.count() > 0) {
      console.log('React root found');
      const rootContent = await reactRoot.innerHTML();
      console.log('Root content length:', rootContent.length);
    }
    
    // Check for any text content
    const textContent = await page.textContent('body');
    console.log('Page text content:', textContent?.substring(0, 200) + '...');
    
    // Look for common React/Electron app patterns
    const commonSelectors = [
      '#root',
      '[data-reactroot]',
      '.app',
      '.App',
      'main',
      '[role="main"]',
      'nav',
      '[role="navigation"]',
      'button',
      'a',
      'div',
    ];
    
    for (const selector of commonSelectors) {
      const elements = page.locator(selector);
      const count = await elements.count();
      if (count > 0) {
        console.log(`Found ${count} elements matching: ${selector}`);
        
        // If it's a div, button, or link, get some text
        if (['button', 'a', 'div'].includes(selector)) {
          for (let i = 0; i < Math.min(count, 3); i++) {
            const text = await elements.nth(i).textContent();
            if (text && text.trim()) {
              console.log(`  ${selector}[${i}]: "${text.trim()}"`);
            }
          }
        }
      }
    }
    
    // Check if the page loaded properly
    const bodyClass = await page.locator('body').getAttribute('class');
    console.log('Body class:', bodyClass);
    
    // Verify basic functionality
    expect(await page.locator('body').isVisible()).toBeTruthy();
  });
});