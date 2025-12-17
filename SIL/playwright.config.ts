import { defineConfig, devices } from '@playwright/test';
import path from 'path';

/**
 * Playwright configuration for SIL (Software-in-the-Loop) testing
 * Tests run against the built MaDControl app with firmware emulator
 */
export default defineConfig({
  testDir: './tests',
  
  // Timeout for each test
  timeout: 120000, // 2 minutes for tests involving firmware communication
  
  // Maximum time to wait for fixtures
  expect: {
    timeout: 10000,
  },
  
  // Run tests in parallel
  fullyParallel: false, // Sequential for hardware emulation
  
  // Fail build on CI if you accidentally left test.only
  forbidOnly: !!process.env.CI,
  
  // Retry on CI only
  retries: process.env.CI ? 2 : 0,
  
  // Limit workers (firmware emulator can only handle one instance)
  workers: 1,
  
  // Reporter configuration
  reporter: [
    ['html', { outputFolder: 'test-results/html' }],
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  
  // Shared settings for all projects
  use: {
    // Base URL for the app (not used for Electron, but good to have)
    baseURL: 'file://',
    
    // Collect trace on failure for debugging
    trace: 'retain-on-failure',
    
    // Take screenshots on failure
    screenshot: 'only-on-failure',
    
    // Record video on failure
    video: 'retain-on-failure',
    
    // Action timeout
    actionTimeout: 10000,
  },
  
  // Configure projects
  projects: [
    {
      name: 'electron',
      use: {
        // Enable trace recording for all tests
        trace: 'on',
        screenshot: 'on',
        video: 'on',
      },
    },
  ],
  
  // Output directory for test artifacts
  outputDir: 'test-results/artifacts',
});

