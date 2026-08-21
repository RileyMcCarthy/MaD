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
import { mkdir, writeFile } from 'node:fs/promises';

// Playwright is a devDependency of this package — resolve it from here.
const require = createRequire(import.meta.url);
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
  // Console output is captured too: a failure that happens before the app boots
  // (a bad import, a WASM load error) never reaches the in-page logger, so the
  // console is the only record of it.
  const consoleLines = [];
  page.on('console', (m) => {
    consoleLines.push(`${m.type()}: ${m.text()}`);
    if (consoleLines.length > 500) consoleLines.shift();
  });
  page.__madConsole = consoleLines;
  await page.addInitScript(installFakeSerial, BRIDGE_URL);
  await page.addInitScript(installOpfsDataDir, OPFS_DIR);

  // Scenarios close their browser in a `finally`, which runs BEFORE the runner's
  // catch — by the time a failure is handled the page is gone. So snapshot the
  // log on the way out and stash it, letting the runner dump it afterwards
  // without any change to the ~40 existing scenario bodies.
  const closeBrowser = browser.close.bind(browser);
  browser.close = async (...args) => {
    lastCapture = {
      url: safeUrl(page),
      console: consoleLines.slice(),
      log: await readAppLog(page),
    };
    return closeBrowser(...args);
  };

  return { browser, page, errors };
}

/** Log + console captured from the most recently closed SIL page. */
let lastCapture = null;

function safeUrl(page) {
  try {
    return page.url();
  } catch {
    return 'unknown';
  }
}

/**
 * Pull the app's merged main+worker session log out of the page.
 *
 * Returns null when the hook is absent — the app never booted, which is itself
 * the most useful thing the caller can report.
 */
export async function readAppLog(page) {
  try {
    return await page.evaluate(() => globalThis.__madLog?.snapshot() ?? null);
  } catch {
    return null;
  }
}

/**
 * Annotate the app's timeline with a scenario/step boundary.
 *
 * Turns an undifferentiated wall of entries into something readable: the dump
 * shows `[e2e] B3 start` immediately before the frames that scenario produced.
 */
export async function markAppLog(page, label) {
  try {
    await page.evaluate((text) => {
      globalThis.__madLog?.mark?.(text);
    }, label);
  } catch {
    // Marking is best-effort; never fail a test because the hook is missing.
  }
}

/**
 * Write everything known about a failed scenario to e2e/artifacts/<name>.json
 * and print a short tail to stderr.
 */
export async function dumpFailureArtifacts(scenario, err) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'artifacts');
  await mkdir(dir, { recursive: true });
  const safe = String(scenario).replace(/[^a-z0-9_-]/gi, '_');
  const captured = lastCapture ?? { url: 'unknown', console: [], log: null };
  const log = captured.log;
  const artifact = {
    scenario,
    failedAt: new Date().toISOString(),
    error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
    url: captured.url,
    console: captured.console,
    log,
  };
  const file = join(dir, `${safe}.json`);
  await writeFile(file, JSON.stringify(artifact, null, 2), 'utf8');

  const entries = log?.entries ?? [];
  const tail = entries.slice(-25);
  process.stderr.write(`\n── ${scenario}: last ${tail.length} log entries ──\n`);
  for (const e of tail) {
    const at = new Date(e.t).toISOString().slice(11, 23);
    const data = e.data ? ` ${JSON.stringify(e.data)}` : '';
    process.stderr.write(
      `  ${at} ${e.level.padEnd(5)} ${e.thread === 'worker' ? 'W' : 'M'} ${e.cat}/${e.tag} ${e.msg ?? ''}${data}\n`,
    );
  }
  if (entries.length === 0) {
    process.stderr.write('  (no app log — the page may not have booted)\n');
  }
  process.stderr.write(`  full artifact: ${file}\n`);
  return file;
}

/**
 * Name the scenario now running, so every app-side log entry it produces sits
 * under a visible boundary in the dump.
 */
let currentScenario = null;
export function setCurrentScenario(id) {
  currentScenario = id;
}

/** Connect the app to SIL via the UI (call after navigating to the app). */
export async function connectToSil(page) {
  await page.goto(`${APP_URL}#/connect`);
  // First point at which the app is loaded and can take a marker.
  if (currentScenario !== null) await markAppLog(page, `scenario ${currentScenario}`);
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
