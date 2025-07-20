/**
 * Basic Electron Launch Test
 * 
 * Simple test to verify Electron launches successfully
 */

import { test, expect } from './helpers/electron';

test.describe('Basic Electron Launch', () => {
  test('should launch Electron app', async ({ electronApp }) => {
    // Just verify the app launches
    expect(electronApp).toBeTruthy();
    
    // Get the first window
    const window = await electronApp.firstWindow();
    expect(window).toBeTruthy();
    
    // Basic window properties
    const title = await window.title();
    console.log('Window title:', title);
  });
});