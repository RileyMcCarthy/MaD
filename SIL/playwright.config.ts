import { defineConfig } from '@playwright/test';

/**
 * Playwright Configuration for MaD SIL Testing
 * 
 * This config uses:
 * - Global setup: Starts firmware emulator before all tests
 * - Global teardown: Stops emulator after all tests
 * - Custom fixtures: Provides app/window to all tests (see fixtures.ts)
 * 
 * Run tests:
 *   npm test              # Run all tests
 *   npm run test:headed   # Run with visible browser
 *   npm run test:debug    # Run with Playwright Inspector
 */
export default defineConfig({
  testDir: './tests',
  
  // Global setup/teardown for firmware emulator
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  
  // Timeouts — repeatability waits up to 3×60s; include emulator + Electron CDP startup.
  timeout: 240_000,
  expect: { timeout: 10_000 }, // 10s for assertions
  
  // Sequential execution (firmware emulator is single-instance)
  fullyParallel: false,
  workers: 1,
  
  // Fail fast - stop on first failure
  maxFailures: 1,
  
  // CI settings
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  
  // Reporters
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-results/html', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  
  // Shared settings
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure', // Only record on failure to reduce overhead
    actionTimeout: 10_000,
  },
  
  // Single project for Electron tests
  projects: [
    {
      name: 'electron',
      testMatch: '**/*.spec.ts',
    },
  ],
  
  // Output directory
  outputDir: 'test-results/artifacts',
});

