/**
 * Shared E2E harness helpers.
 *
 * The app knows ONLY Web Serial + the File System Access picker. For tests we
 * inject two browser-API replacements via `page.addInitScript` so the app's
 * normal code paths run unchanged:
 *
 *   - `navigator.serial`        → a fake SerialPort backed by the WS↔PTY bridge
 *                                 (tools/sil-ws-bridge.mjs → SIL emulator).
 *   - `showDirectoryPicker()`   → an OPFS directory (real FileSystemDirectoryHandle,
 *                                 no dialog, no permission prompt).
 *
 * Playwright/Chromium are reused from the SIL workspace and the system Chrome
 * is launched via channel (no browser download).
 *
 * Usage (plain node script or @playwright/test):
 *   import { newSilPage, APP_URL } from './fixtures.mjs';
 *   const { browser, page } = await newSilPage();
 *   await page.goto(APP_URL + '#/connect');
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolve Playwright from the SIL workspace (shared install) — portable for CI.
const silPackageJson = join(dirname(fileURLToPath(import.meta.url)), '../../../SIL/package.json');
const require = createRequire(silPackageJson);
export const { chromium } = require('playwright');

export const APP_URL = process.env.APP_URL || 'http://localhost:5174/';
export const BRIDGE_URL = process.env.BRIDGE_URL || 'ws://localhost:9999';
export const OPFS_DIR = process.env.OPFS_DIR || 'mad-e2e';

/**
 * Init script: fake `navigator.serial` over a WebSocket to the SIL bridge.
 *
 * Also installs `window.__silDropLink()` — severs the WS (and fires the
 * serial `disconnect` event) to simulate USB unplug / emulator death for
 * disconnect/reconnect scenarios. A later `open()` dials a fresh WS, so the
 * app's reconnect path works against the same fake port.
 */
export function installFakeSerial(bridgeUrl) {
  const serialListeners = { connect: new Set(), disconnect: new Set() };
  function dispatchSerial(type, port) {
    for (const fn of serialListeners[type] || []) {
      try {
        fn({ type, target: port, port });
      } catch {
        /* listener error; ignore */
      }
    }
  }
  function makePort() {
    let ws;
    let readable;
    let writable;
    const port = {
      async open() {
        ws = new WebSocket(bridgeUrl);
        ws.binaryType = 'arraybuffer';
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = () => reject(new Error('bridge connection failed'));
        });
        const socket = ws;
        window.__silCurrentWs = socket;
        let controller;
        readable = new ReadableStream({
          start(c) {
            controller = c;
          },
          cancel() {
            try {
              socket.close();
            } catch {
              /* ignore */
            }
          },
        });
        socket.onmessage = (e) => {
          try {
            controller.enqueue(new Uint8Array(e.data));
          } catch {
            /* closed */
          }
        };
        socket.onclose = () => {
          try {
            controller.close();
          } catch {
            /* closed */
          }
        };
        writable = new WritableStream({
          write(chunk) {
            if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
          },
          close() {
            try {
              socket.close();
            } catch {
              /* ignore */
            }
          },
        });
      },
      get readable() {
        return readable;
      },
      get writable() {
        return writable;
      },
      getInfo() {
        return {};
      },
      async close() {
        try {
          ws && ws.close();
        } catch {
          /* ignore */
        }
      },
      addEventListener() {},
      removeEventListener() {},
    };
    return port;
  }
  const port = makePort();
  window.__silDropLink = () => {
    try {
      window.__silCurrentWs && window.__silCurrentWs.close();
    } catch {
      /* ignore */
    }
    dispatchSerial('disconnect', port);
  };
  Object.defineProperty(navigator, 'serial', {
    configurable: true,
    value: {
      requestPort: async () => port,
      getPorts: async () => [port],
      addEventListener(type, fn) {
        (serialListeners[type] ||= new Set()).add(fn);
      },
      removeEventListener(type, fn) {
        serialListeners[type]?.delete(fn);
      },
    },
  });
}

/** Init script: `showDirectoryPicker` → a fresh OPFS directory. */
export function installOpfsDataDir(dirName) {
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(dirName, { recursive: true });
    } catch {
      /* not present */
    }
    return root.getDirectoryHandle(dirName, { create: true });
  };
}

/**
 * Launch system Chrome and return a page with both fakes installed.
 * Pass { headed: true } to watch it.
 */
export async function newSilPage({ headed = false } = {}) {
  const browser = await chromium.launch({ channel: 'chrome', headless: !headed });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installFakeSerial, BRIDGE_URL);
  await page.addInitScript(installOpfsDataDir, OPFS_DIR);
  return { browser, page, errors };
}

/** Connect the app to SIL via the UI (call after navigating to the app). */
export async function connectToSil(page) {
  await page.goto(`${APP_URL}#/connect`);
  // The primary button (testid connect-device) prompts requestPort() → our fake.
  await page.getByTestId('connect-device').click();
  // Wait until the store reports connected — the status dot gets `.connected`.
  // (Matching on text would falsely hit "Disconnected".)
  await page.locator('.dot.connected').waitFor({ timeout: 10000 });
}

/** Choose the OPFS data folder via Settings. */
export async function chooseDataFolder(page) {
  await page.goto(`${APP_URL}#/settings`);
  await page.getByRole('button', { name: /Choose folder/i }).click();
  await page.getByText(/Current:/).waitFor({ timeout: 8000 });
}
