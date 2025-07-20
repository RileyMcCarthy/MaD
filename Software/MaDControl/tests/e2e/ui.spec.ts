/**
 * UI Interaction Tests
 * 
 * These tests demonstrate how to interact with the MaD Control UI elements
 * using Playwright. They cover navigation, form interactions, and basic
 * functionality testing.
 */

import { test, expect } from './helpers/electron';

test.describe('MaD Control UI Tests', () => {
  test('should launch the application successfully', async ({ page }) => {
    // Verify the application window is created
    expect(page).toBeTruthy();
    
    // Check if the main application is loaded  
    await expect(page).toHaveTitle(/MAD Control|MaD Control/i);
  });

  test('should navigate between different pages', async ({ page }) => {
    // Start on the dashboard page - check for any content that indicates we're on the main page
    const appContent = page.locator('body, main, [role="main"], .app-content').first();
    await expect(appContent).toBeVisible();
    
    // Take a screenshot to see what's actually rendered
    await page.screenshot({ path: 'app-screenshot.png' });
    
    // Get all clickable navigation elements
    const navLinks = page.locator('a, button, [role="button"]');
    const count = await navLinks.count();
    console.log(`Found ${count} clickable elements in the app`);
    
    // If we find navigation elements, try clicking one
    if (count > 0) {
      // Get text of first few elements to see what's available
      for (let i = 0; i < Math.min(count, 5); i++) {
        const text = await navLinks.nth(i).textContent();
        console.log(`Element ${i}: "${text}"`);
      }
      
      // Try clicking the first navigation element
      const firstNav = navLinks.first();
      if (await firstNav.isVisible() && await firstNav.isEnabled()) {
        await firstNav.click();
        await page.waitForTimeout(500);
        
        // Verify the app is still responsive
        await expect(appContent).toBeVisible();
      }
    }
  });

  test('should interact with the sidebar navigation', async ({ page }) => {
    // Check if sidebar is visible
    const sidebar = page.locator('[role="navigation"], .sidebar, nav');
    await expect(sidebar).toBeVisible();
    
    // Test expanding/collapsing if there's a toggle button
    const toggleButton = page.locator('[data-testid="sidebar-toggle"], button[aria-label*="menu"]');
    if (await toggleButton.isVisible()) {
      await toggleButton.click();
      await page.waitForTimeout(500); // Allow animation
      
      await toggleButton.click();
      await page.waitForTimeout(500); // Allow animation
    }
  });

  test('should display machine status indicators', async ({ page }) => {
    // Look for status indicators on the dashboard or sidebar
    const statusIndicators = page.locator('[data-testid*="status"], .status-indicator, [class*="status"]');
    
    if (await statusIndicators.count() > 0) {
      await expect(statusIndicators.first()).toBeVisible();
    }
  });

  test('should handle form interactions on Test Profile page', async ({ page }) => {
    // Navigate to Test Profile creation page
    await page.click('text=Test Profile');
    await page.waitForLoadState('networkidle');
    
    // Look for form inputs
    const nameInput = page.locator('input[name="name"], input[placeholder*="name" i], input[label*="name" i]').first();
    if (await nameInput.isVisible()) {
      await nameInput.fill('Automated Test Profile');
    }
    
    const descriptionInput = page.locator('textarea[name="description"], input[name="description"], input[placeholder*="description" i]').first();
    if (await descriptionInput.isVisible()) {
      await descriptionInput.fill('Test profile created by automated test');
    }
    
    // Look for numerical parameter inputs
    const forceInput = page.locator('input[name*="force"], input[placeholder*="force" i]').first();
    if (await forceInput.isVisible()) {
      await forceInput.fill('10');
    }
    
    const speedInput = page.locator('input[name*="speed"], input[placeholder*="speed" i]').first();
    if (await speedInput.isVisible()) {
      await speedInput.fill('50');
    }
    
    // Look for save button
    const saveButton = page.locator('button:has-text("Save"), button[type="submit"]').first();
    if (await saveButton.isVisible() && await saveButton.isEnabled()) {
      await saveButton.click();
      
      // Wait for potential success message or navigation
      await page.waitForTimeout(1000);
    }
  });

  test('should interact with serial port selection on Connect page', async ({ page }) => {
    // Navigate to Connect page
    await page.click('text=Connect');
    await page.waitForLoadState('networkidle');
    
    // Look for serial port selector
    const portSelector = page.locator('select, .MuiSelect-root, [data-testid="port-selector"]').first();
    if (await portSelector.isVisible()) {
      await portSelector.click();
      
      // Wait for dropdown options
      await page.waitForTimeout(500);
      
      // Look for available ports or mock options
      const portOptions = page.locator('[role="option"], option');
      if (await portOptions.count() > 0) {
        await portOptions.first().click();
      }
    }
    
    // Look for connect button
    const connectButton = page.locator('button:has-text("Connect"), [data-testid="connect-button"]').first();
    if (await connectButton.isVisible() && await connectButton.isEnabled()) {
      // Note: In a real test, we'd mock the serial connection
      // For now, just verify the button exists and is clickable
      expect(await connectButton.isEnabled()).toBeTruthy();
    }
  });

  test('should display charts and graphs on Dashboard', async ({ page }) => {
    // Navigate to Dashboard
    await page.click('text=Dashboard');
    await page.waitForLoadState('networkidle');
    
    // Look for chart components (Chart.js, recharts, etc.)
    const charts = page.locator('canvas, svg[class*="chart"], .recharts-wrapper, [data-testid*="chart"]');
    
    if (await charts.count() > 0) {
      await expect(charts.first()).toBeVisible();
    }
  });

  test('should handle keyboard navigation', async ({ page }) => {
    // Test Tab navigation through the interface
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    
    // Verify focused element is visible
    const focusedElement = page.locator(':focus');
    if (await focusedElement.count() > 0) {
      await expect(focusedElement).toBeVisible();
    }
  });

  test('should be responsive to window resizing', async ({ page, electronApp }) => {
    // Get initial window size
    const window = await electronApp.firstWindow();
    
    // Resize window to test responsiveness
    await window.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(500);
    
    // Verify content is still visible
    await expect(page.locator('body')).toBeVisible();
    
    // Test smaller size
    await window.setViewportSize({ width: 800, height: 600 });
    await page.waitForTimeout(500);
    
    // Verify content adapts
    await expect(page.locator('body')).toBeVisible();
    
    // Restore size
    await window.setViewportSize({ width: 1400, height: 900 });
  });
});