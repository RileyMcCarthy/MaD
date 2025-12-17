/**
 * Connects to /tmp/tty.rpi and verifies connection status via IPC completes.
 * Run via: make run  (Server.py starts emulator and then runs tests)
 */

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// Use Electron binary from devDependencies for deterministic startup
// eslint-disable-next-line @typescript-eslint/no-var-requires
const electronPath = require('electron') as string;

async function launchBuiltApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const silRoot = path.resolve(__dirname, '..');
  const appDir = path.join(silRoot, 'build', 'MaDControl');
  const mainPath = path.join(appDir, 'dist', 'main', 'main.js');

  if (!fs.existsSync(mainPath)) {
    throw new Error(`App main not found: ${mainPath}`);
  }

  const app = await electron.launch({
    executablePath: electronPath,
    args: [mainPath],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      NODE_ENV: 'test',
    },
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}

async function waitForEmulatorPort(window: Page, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ports: string[] = await window.evaluate(async () => {
        // @ts-ignore
        return window.electron.ipcRenderer.invoke('device-list-ports');
      });
      if (ports && ports.includes('/tmp/tty.rpi')) return;
    } catch {}
    await window.waitForTimeout(500);
  }
  throw new Error('Timed out waiting for /tmp/tty.rpi to appear');
}

test('connects to /tmp/tty.rpi and reports connected', async () => {
  const { app, window } = await launchBuiltApp();
  try {
    await waitForEmulatorPort(window);

    const result = await window.evaluate(async () => {
      // @ts-ignore
      return window.electron.ipcRenderer.invoke('device-connect', '/tmp/tty.rpi', 115200);
    });

    // If a string message is returned, assert it contains Connected
    if (typeof result === 'string') {
      expect(result.toLowerCase()).toContain('connected');
    } else {
      // Otherwise, at least ensure the call did not throw
      expect(result === undefined || result === null || result === true).toBeTruthy();
    }

    // Optional: give the app a moment to process status updates
    await window.waitForTimeout(500);
  } finally {
    await app.close();
  }
});


