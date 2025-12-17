/**
 * Helper utilities for SIL testing with Playwright
 */

import { ElectronApplication, Page, _electron as electron } from '@playwright/test';
import path from 'path';

export interface TestContext {
  app: ElectronApplication;
  window: Page;
}

/**
 * Launch the MaDControl Electron app
 */
export async function launchMaDControl(): Promise<TestContext> {
  const projectRoot = path.join(__dirname, '../..');
  const appPath = path.join(projectRoot, 'SIL/build/MaDControl');
  const mainPath = path.join(appPath, 'dist/main/main.js');
  
  console.log(`Launching MaDControl from: ${mainPath}`);
  
  const app = await electron.launch({
    args: [mainPath],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ELECTRON_DISABLE_SANDBOX: '1',
    },
    timeout: 30000,
  });
  
  // Wait for first window
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  
  return { app, window };
}

/**
 * Wait for firmware emulator to be ready
 */
export async function waitForFirmwareReady(page: Page, timeout: number = 30000): Promise<boolean> {
  const startTime = Date.now();
  
  console.log('Waiting for firmware emulator virtual port...');
  
  while (Date.now() - startTime < timeout) {
    try {
      const ports = await page.evaluate(async () => {
        return window.electron.ipcRenderer.invoke('device-list-ports');
      });
      
      if (ports && ports.includes('/tmp/tty.rpi')) {
        console.log('✅ Firmware emulator virtual port detected');
        return true;
      }
    } catch (error) {
      console.log('Still waiting for IPC to be ready...');
    }
    
    await page.waitForTimeout(1000);
  }
  
  throw new Error('Firmware emulator not ready - virtual port not found');
}

/**
 * Connect to the firmware emulator
 */
export async function connectToEmulator(page: Page): Promise<void> {
  await waitForFirmwareReady(page);
  
  console.log('Connecting to firmware emulator...');
  
  // Wait for the app to be ready
  await page.waitForTimeout(2000);
  
  // Try to find and click connect navigation (if it exists)
  const connectNav = page.locator('text=Connect').first();
  if (await connectNav.isVisible({ timeout: 2000 }).catch(() => false)) {
    await connectNav.click();
    await page.waitForTimeout(1000);
  }
  
  // Connect via IPC directly and await device-status-updates (connected)
  const status = await page.evaluate(async () => {
    return new Promise<{ connected: boolean; responding?: boolean }>(async (resolve, reject) => {
      try {
        const { ipcRenderer } = (window as any).electron;
        const onStatus = (_e: any, s: any) => {
          if (s && s.connected) {
            ipcRenderer.removeListener('device-status-updates', onStatus);
            resolve(s);
          }
        };
        ipcRenderer.on('device-status-updates', onStatus);
        await ipcRenderer.invoke('device-connect', '/tmp/tty.rpi', 115200);
      } catch (err) {
        reject(err);
      }
    });
  });
  console.log('Status after connect:', status);
  console.log('✅ Connected to firmware emulator');
}

/**
 * Disconnect from the device
 */
export async function disconnect(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.electron.ipcRenderer.invoke('device-disconnect');
  });
  
  await page.waitForTimeout(500);
}

/**
 * Get current machine state
 */
export async function getMachineState(page: Page): Promise<any> {
  return await page.evaluate(async () => {
    const { ipcRenderer } = (window as any).electron;
    const current = await ipcRenderer.invoke('device-state');
    if (current) return current;
    return new Promise<any>((resolve) => {
      const onState = (_e: any, s: any) => {
        ipcRenderer.removeListener('machine-state-updates', onState);
        resolve(s);
      };
      ipcRenderer.on('machine-state-updates', onState);
    });
  });
}

/**
 * Get current sample data
 */
export async function getSampleData(page: Page): Promise<any> {
  return await page.evaluate(async () => {
    const { ipcRenderer } = (window as any).electron;
    const latest = await ipcRenderer.invoke('sample-data-latest');
    if (latest) return latest;
    return new Promise<any>((resolve) => {
      const onSample = (_e: any, d: any) => {
        ipcRenderer.removeListener('sample-data-updates', onSample);
        resolve(d);
      };
      ipcRenderer.on('sample-data-updates', onSample);
    });
  });
}

/**
 * Wait for machine state to match expected value
 */
export async function waitForMachineState(
  page: Page,
  expectedState: string,
  timeout: number = 30000
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    const state = await getMachineState(page);
    if (state && state.state === expectedState) {
      return;
    }
    await page.waitForTimeout(500);
  }
  
  throw new Error(`Timeout waiting for machine state: ${expectedState}`);
}

/**
 * Take a screenshot with a descriptive name
 */
export async function takeScreenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(__dirname, '../test-results/screenshots', `${name}.png`),
    fullPage: true,
  });
}

