import { test } from '@playwright/test';
import {
  launchElectronApp,
  ensureConnected,
  screenshotAllPages,
  takeErrorScreenshot,
} from './helpers';

test.describe('MaD Control App Screenshots', () => {
  let electronApp: any;
  let page: any;

  test.beforeAll(async () => {
    test.setTimeout(120000); // 2 minute timeout
    const launched = await launchElectronApp();
    electronApp = launched.electronApp;
    page = launched.page;
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test('connect to emulator and screenshot all pages', async () => {
    try {
      await ensureConnected(page, '/tmp/tty.rpi_client');
      await screenshotAllPages(page, 'connected');
    } catch (error) {
      // Capture error screenshot and fail
      await takeErrorScreenshot(page, 'connection-test');
      throw error;
    }
  });
});
