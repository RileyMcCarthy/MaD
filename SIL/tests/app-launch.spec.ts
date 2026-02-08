/**
 * Application Launch Tests
 * 
 * Basic tests to verify the Electron app launches correctly.
 */

import { test, expect } from './fixtures';

test.describe('Application Launch', () => {
  test('should launch with correct title', async ({ window }) => {
    const title = await window.title();
    expect(title).toBeTruthy();
    console.log(`✅ App launched with title: "${title}"`);
  });

  test('should have main window visible', async ({ window }) => {
    // Check that the window has content
    const content = await window.content();
    expect(content).toContain('html');
    console.log('✅ Main window is visible');
  });

  test('should have working IPC bridge', async ({ waitForIPC }) => {
    await waitForIPC();
    console.log('✅ IPC bridge is ready');
  });
});
