/**
 * Shared Playwright Fixtures for MaD SIL Testing
 * 
 * This module extends Playwright's base test with fixtures that:
 * 1. Launch the Electron app with proper configuration
 * 2. Start a fresh firmware emulator per-test for true isolation
 * 3. Provide helpers for connecting to the emulator
 * 4. Handle cleanup automatically
 * 
 * Each test gets a completely fresh firmware state - the emulator is
 * started before the test and stopped after.
 * 
 * Usage in tests:
 *   import { test, expect } from './fixtures';
 *   
 *   test('my test', async ({ window, connectToEmulator }) => {
 *     await connectToEmulator(); // Emulator auto-starts, connects, waits for responding
 *     await expect(window).toHaveTitle(/MaD/);
 *   });
 */

import { test as base, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import { spawn, execSync, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

// Use Electron from SIL's node_modules
// eslint-disable-next-line @typescript-eslint/no-var-requires
const electronPath = require('electron') as string;

// Paths (centralized)
const SIL_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(SIL_ROOT, '..');
const MADCONTROL_DIR = path.join(PROJECT_ROOT, 'Software/MaDControl');
const MADCONTROL_MAIN = path.join(MADCONTROL_DIR, 'release/app/dist/main/main.js');
const EMULATOR_BIN = path.join(SIL_ROOT, 'target/debug/mad-emulator');
const SD_PATH = path.join(SIL_ROOT, 'sd');

// Virtual serial port path (created by emulator)
const EMULATOR_PORT = '/tmp/tty.rpi';
const EMULATOR_BAUD_RATE = 115200;

/**
 * Wait for a file to exist on disk
 */
function waitForPort(portPath: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fs.existsSync(portPath)) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for ${portPath}`));
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}

/**
 * Kill any existing emulator processes
 */
function killEmulatorProcesses(): void {
  try {
    execSync('pkill -f "mad-emulator" 2>/dev/null || true', { stdio: 'ignore' });
  } catch {
    // Ignore - processes may not exist
  }
}

// Type definitions for our custom fixtures
export type MaDTestFixtures = {
  /** The running Electron application instance */
  app: ElectronApplication;
  /** The main browser window (Page) */
  window: Page;
  /** Helper to wait for IPC to be ready */
  waitForIPC: () => Promise<void>;
  /** Helper to list available serial ports */
  listPorts: () => Promise<string[]>;
  /** Helper to connect to the emulator (auto-starts emulator if needed) */
  connectToEmulator: () => Promise<void>;
  /** The emulator port path */
  emulatorPort: string;
  /** The running emulator process (managed per-test) */
  emulator: ChildProcess;
};

/**
 * Extended test with MaD-specific fixtures
 */
export const test = base.extend<MaDTestFixtures>({
  // Emulator port is a constant
  emulatorPort: EMULATOR_PORT,

  // Per-test emulator: start before test, stop after
  emulator: async ({}, use) => {
    // Kill any stale processes from previous tests
    killEmulatorProcesses();
    await new Promise((r) => setTimeout(r, 500));

    // Remove stale PTY symlink
    try { fs.unlinkSync(EMULATOR_PORT); } catch { /* ignore */ }

    // Start the Rust emulator
    console.log('🚀 Starting Rust emulator for test...');
    const emulatorProcess = spawn(EMULATOR_BIN, [
      '--sd-path', SD_PATH,
      '--pty-path', EMULATOR_PORT,
      '--log-level', 'info',
    ], {
      cwd: SIL_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false, // Keep attached so we can kill it properly
    });

    // Log emulator output if DEBUG_EMULATOR is set
    emulatorProcess.stdout?.on('data', (data) => {
      const line = data.toString().trim();
      if (line && process.env.DEBUG_EMULATOR) {
        console.log(`[emulator] ${line}`);
      }
    });
    emulatorProcess.stderr?.on('data', (data) => {
      const line = data.toString().trim();
      if (line && process.env.DEBUG_EMULATOR) {
        console.error(`[emulator:err] ${line}`);
      }
    });

    // Wait for virtual serial port to be ready
    await waitForPort(EMULATOR_PORT, 15000);
    
    // Give firmware cogs time to initialize
    await new Promise((r) => setTimeout(r, 2000));
    console.log('✅ Emulator ready');

    // Provide emulator to test
    await use(emulatorProcess);

    // Cleanup: stop emulator after test
    console.log('🛑 Stopping emulator...');
    
    // Kill the process tree
    if (emulatorProcess.pid) {
      try {
        process.kill(emulatorProcess.pid, 'SIGTERM');
      } catch {
        // Process may have already exited
      }
    }
    
    // Safety net: kill any remaining processes
    killEmulatorProcesses();
    await new Promise((r) => setTimeout(r, 500));
  },

  // Launch Electron app before each test, close after
  app: async ({}, use) => {
    // Verify the app is built
    if (!fs.existsSync(MADCONTROL_MAIN)) {
      throw new Error(
        `MaDControl not built. Run 'npm run build' in ${MADCONTROL_DIR}\n` +
        `Expected: ${MADCONTROL_MAIN}`
      );
    }

    // Launch Electron
    const app = await electron.launch({
      executablePath: electronPath,
      args: [MADCONTROL_MAIN],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SIL_TEST: '1', // Tells main.ts to use production preload path
        ELECTRON_DISABLE_SANDBOX: '1',
      },
      timeout: 30000,
    });

    // Use the app in the test
    await use(app);

    // Cleanup: close app after test
    await app.close();
  },

  // Get the main window from the app
  window: async ({ app }, use) => {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    
    // Give React a moment to hydrate
    await window.waitForTimeout(500);
    
    await use(window);
  },

  // Helper: wait for window.electron.ipcRenderer to be available
  waitForIPC: async ({ window }, use) => {
    const helper = async () => {
      const maxAttempts = 20;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const ready = await window.evaluate(() => {
            return typeof window.electron?.ipcRenderer?.invoke === 'function';
          });
          if (ready) return;
        } catch {
          // IPC not ready yet
        }
        await window.waitForTimeout(500);
      }
      throw new Error('IPC not ready after 10 seconds');
    };
    await use(helper);
  },

  // Helper: list available serial ports
  listPorts: async ({ window, waitForIPC }, use) => {
    const helper = async (): Promise<string[]> => {
      await waitForIPC();
      return window.evaluate(async () => {
        return window.electron.ipcRenderer.invoke('device-list-ports');
      });
    };
    await use(helper);
  },

  // Helper: connect to the emulator and verify device is responding
  // Depends on `emulator` fixture to ensure emulator is running
  connectToEmulator: async ({ window, waitForIPC, emulatorPort, emulator }, use) => {
    // Just referencing `emulator` ensures it's started before this runs
    void emulator;
    
    const helper = async () => {
      await waitForIPC();
      
      // Wait for port to appear in list
      const maxPortAttempts = 20;
      for (let i = 0; i < maxPortAttempts; i++) {
        const ports: string[] = await window.evaluate(async () => {
          return window.electron.ipcRenderer.invoke('device-list-ports');
        });
        if (ports.includes(emulatorPort)) {
          break;
        }
        if (i === maxPortAttempts - 1) {
          throw new Error(`Emulator port ${emulatorPort} not found. Available: ${ports.join(', ')}`);
        }
        await window.waitForTimeout(500);
      }

      // Connect to the port
      await window.evaluate(async ({ port, baudRate }) => {
        return window.electron.ipcRenderer.invoke('device-connect', port, baudRate);
      }, { port: emulatorPort, baudRate: EMULATOR_BAUD_RATE });

      // Verify connection succeeded
      const isConnected = await window.evaluate(async () => {
        return window.electron.ipcRenderer.invoke('device-connected');
      });
      if (!isConnected) {
        throw new Error('Failed to connect to emulator port');
      }

      // Wait for device to start responding (firmware communication)
      const maxRespondAttempts = 30; // 15 seconds max
      for (let i = 0; i < maxRespondAttempts; i++) {
        const isResponding = await window.evaluate(async () => {
          return window.electron.ipcRenderer.invoke('device-responding');
        });
        if (isResponding) {
          console.log(`Device responding after ${(i + 1) * 0.5}s`);
          return; // Success!
        }
        await window.waitForTimeout(500);
      }
      
      // If we get here, device never responded
      throw new Error('Connected to port but firmware is not responding. Is the emulator running?');
    };
    await use(helper);
  },
});

// Re-export expect for convenience
export { expect } from '@playwright/test';

// Type augmentation for window.electron
declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
        on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
        once: (channel: string, listener: (...args: unknown[]) => void) => void;
        sendMessage: (channel: string, ...args: unknown[]) => void;
        sendSync: (channel: string, ...args: unknown[]) => unknown;
        removeAllListeners: (channel: string) => void;
      };
    };
  }
}
