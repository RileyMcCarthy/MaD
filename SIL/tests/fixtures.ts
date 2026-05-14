/**
 * Shared Playwright Fixtures for MaD SIL Testing
 *
 * Uses CDP (Chrome DevTools Protocol) to connect to the Electron app instead
 * of electron.launch(), which is broken on macOS with Electron 30+ because
 * Playwright passes --remote-debugging-port=0 as a CLI arg that macOS Electron
 * rejects. Instead, main.ts reads ELECTRON_CDP_PORT and calls
 * app.commandLine.appendSwitch() before the app is ready.
 *
 * Each test gets a completely fresh firmware state - the emulator is started
 * before the test and stopped after.
 */

import { test as base, chromium, Browser, Page } from '@playwright/test';
import { spawn, execSync, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

// Use MaDControl's Electron binary (matches the version the app was built for)
const SIL_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(SIL_ROOT, '..');
const MADCONTROL_DIR = path.join(PROJECT_ROOT, 'Software/MaDControl');
const MADCONTROL_MAIN = path.join(MADCONTROL_DIR, 'release/app/dist/main/main.js');
const EMULATOR_BIN = path.join(SIL_ROOT, 'target/debug/mad-emulator');
const SD_PATH = path.join(SIL_ROOT, 'sd');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const electronPath = require(path.join(MADCONTROL_DIR, 'node_modules/electron')) as string;

// Virtual serial port path (created by emulator)
const EMULATOR_PORT = '/tmp/tty.rpi';
const EMULATOR_BAUD_RATE = 115200;

// Fixed CDP port for SIL tests (workers: 1, so no conflicts)
const CDP_PORT = 9222;

// Custom app handle that replaces ElectronApplication
export type AppHandle = {
  close: () => Promise<void>;
  firstWindow: () => Promise<Page>;
};

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
    // Ignore
  }
}

/**
 * Kill any stale Electron processes from previous test runs
 */
function killElectronProcesses(): void {
  try {
    execSync('pkill -f "Electron" 2>/dev/null || true', { stdio: 'ignore' });
  } catch {
    // Ignore
  }
}

/**
 * Wait for CDP to become available on the given port
 */
async function connectWithRetry(port: number, timeoutMs = 90000): Promise<Browser> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await chromium.connectOverCDP(`http://localhost:${port}`);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`CDP not available on port ${port} after ${timeoutMs}ms`);
}

// Type definitions for our custom fixtures
export type MaDTestFixtures = {
  /** Optional baud pacing for emulator (MAD_SIM_BAUD). 0 disables pacing. */
  madSimBaud: number;
  /** The running Electron application handle */
  app: AppHandle;
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
  // Option fixture: baud pacing for emulator, default off.
  madSimBaud: [0, { option: true }],

  // Emulator port is a constant
  emulatorPort: EMULATOR_PORT,

  // Per-test emulator: start before test, stop after
  emulator: async ({ madSimBaud }, use) => {
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
      env: {
        ...process.env,
        ...(madSimBaud > 0 ? { MAD_SIM_BAUD: String(madSimBaud) } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

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

    await waitForPort(EMULATOR_PORT, 15000);
    await new Promise((r) => setTimeout(r, 1000));
    console.log('✅ Emulator ready');

    await use(emulatorProcess);

    console.log('🛑 Stopping emulator...');
    if (emulatorProcess.pid) {
      try { process.kill(emulatorProcess.pid, 'SIGTERM'); } catch { /* ignore */ }
    }
    killEmulatorProcesses();
    await new Promise((r) => setTimeout(r, 500));
  },

  // Launch Electron app via CDP before each test, close after
  app: async ({}, use) => {
    if (!fs.existsSync(MADCONTROL_MAIN)) {
      throw new Error(
        `MaDControl not built. Run 'npm run build' in ${MADCONTROL_DIR}\n` +
        `Expected: ${MADCONTROL_MAIN}`
      );
    }

    // Kill any stale Electron from previous tests
    killElectronProcesses();
    await new Promise((r) => setTimeout(r, 2000));

    // Launch Electron with CDP port set via env var (avoids broken --remote-debugging-port CLI flag)
    const appProcess = spawn(electronPath, [MADCONTROL_MAIN], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SIL_TEST: '1',
        ELECTRON_CDP_PORT: String(CDP_PORT),
        ELECTRON_DISABLE_SANDBOX: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    appProcess.stdout?.on('data', (data) => {
      if (process.env.DEBUG_APP) console.log(`[app] ${data.toString().trim()}`);
    });
    appProcess.stderr?.on('data', (data) => {
      if (process.env.DEBUG_APP) console.error(`[app:err] ${data.toString().trim()}`);
    });

    let browser: Browser | null = null;

    const appHandle: AppHandle = {
      firstWindow: async () => {
        const start = Date.now();
        while (Date.now() - start < 90000) {
          for (const ctx of browser!.contexts()) {
            const pages = ctx.pages();
            if (pages.length > 0) return pages[0];
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error('No Electron window appeared within 90s');
      },
      close: async () => {
        try { await browser?.close(); } catch { /* ignore */ }
        if (appProcess.pid) {
          try { process.kill(appProcess.pid, 'SIGTERM'); } catch { /* ignore */ }
        }
        await new Promise((r) => setTimeout(r, 500));
      },
    };

    try {
      // Connect to Electron via CDP (retries until Chromium is ready)
      browser = await connectWithRetry(CDP_PORT, 90000);
      await use(appHandle);
    } finally {
      await appHandle.close();
    }
  },

  // Get the main window from the app
  window: async ({ app }, use) => {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(200);
    await use(window);
  },

  // Helper: wait for window.electron.ipcRenderer to be available
  waitForIPC: async ({ window }, use) => {
    const helper = async () => {
      const maxAttempts = 20;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const ready = await window.evaluate(() => {
            return typeof (window as any).electron?.ipcRenderer?.invoke === 'function';
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

      const maxAttempts = 20;
      let latestPorts: string[] = [];

      for (let index = 0; index < maxAttempts; index++) {
        latestPorts = await window.evaluate(async () => {
          return (window as any).electron.ipcRenderer.invoke('device-list-ports');
        });

        if (latestPorts.length > 0) {
          return latestPorts;
        }

        await window.waitForTimeout(500);
      }

      return latestPorts;
    };
    await use(helper);
  },

  // Helper: connect to the emulator and verify device is responding
  connectToEmulator: async ({ window, waitForIPC, emulatorPort, emulator }, use) => {
    void emulator; // ensures emulator fixture runs first

    const helper = async () => {
      await waitForIPC();

      // Try to connect directly with retries. Port listing can be temporarily empty
      // even when the emulator PTY is available.
      const maxConnectAttempts = 20;
      let lastSeenPorts: string[] = [];

      for (let attempt = 0; attempt < maxConnectAttempts; attempt++) {
        lastSeenPorts = await window.evaluate(async () => {
          return (window as any).electron.ipcRenderer.invoke('device-list-ports');
        });

        try {
          await window.evaluate(async ({ port, baudRate }) => {
            return (window as any).electron.ipcRenderer.invoke('device-connect', port, baudRate);
          }, { port: emulatorPort, baudRate: EMULATOR_BAUD_RATE });
        } catch {
          // ignore and retry below
        }

        const isConnected = await window.evaluate(async () => {
          return (window as any).electron.ipcRenderer.invoke('device-connected');
        });
        if (isConnected) {
          break;
        }

        if (attempt === maxConnectAttempts - 1) {
          throw new Error(
            `Failed to connect to emulator port ${emulatorPort}. Last available ports: ${lastSeenPorts.join(', ')}`,
          );
        }

        await window.waitForTimeout(500);
      }

      // Wait for device to start responding (firmware communication)
      const maxRespondAttempts = 30;
      for (let i = 0; i < maxRespondAttempts; i++) {
        const isResponding = await window.evaluate(async () => {
          return (window as any).electron.ipcRenderer.invoke('device-responding');
        });
        if (isResponding) {
          console.log(`Device responding after ${(i + 1) * 0.5}s`);
          return;
        }
        await window.waitForTimeout(500);
      }

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
