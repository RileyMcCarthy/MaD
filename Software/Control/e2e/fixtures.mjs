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
      // The SIL bridge is a pure byte pipe with no modem lines. Accept and
      // record control-line changes so code paths that pulse DTR (the firmware
      // loader) don't throw here; nothing downstream acts on them.
      async setSignals(signals) {
        window.__silSignals = { ...(window.__silSignals ?? {}), ...signals };
      },
      async getSignals() {
        return { dataCarrierDetect: false, clearToSend: false, ringIndicator: false, dataSetReady: false };
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

/**
 * Install a `navigator.serial` whose port emulates the Propeller 2 boot ROM's
 * serial loader, entirely in-page.
 *
 * The SIL emulator cannot serve this: it links host-native firmware rather than
 * emulating the P2 instruction set, so it has no boot ROM, and the WebSocket
 * bridge carries no modem lines so a DTR pulse would be invisible to it. This
 * fake is therefore the only way to drive the real flashing UI end to end.
 *
 * It deliberately refuses to answer until DTR has been pulsed, so a test fails
 * if the app ever stops resetting the chip before probing.
 *
 * Exposes `window.__bootRom` for assertions: { reset, image, finished, ok }.
 *
 * `portCount` > 1 presents several indistinguishable adapters, which is how the
 * app's refusal to guess a programming target gets tested.
 */
export function installFakeBootRom(portCount = 1) {
  const CHECKSUM_MAGIC = 0x706f7250;
  const state = { reset: 0, image: [], finished: false, ok: null, dtr: null, bytesIn: 0, replies: 0, checksum: null };
  window.__bootRom = state;

  let controller;
  let buffered = '';
  let hexMode = false;
  let sum = 0;
  let longBuf = [];

  const emit = (s) => {
    const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
    state.replies += 1;
    try {
      controller?.enqueue(bytes);
    } catch {
      /* closed */
    }
  };

  function consume(text) {
    state.bytesIn += text.length;
    buffered += text;
    if (!hexMode) {
      if (buffered.includes('> Prop_Chk 0 0 0 0  ')) {
        buffered = '';
        // Only a chip that has just been reset is listening.
        if (state.reset > 0) emit('\r\nProp_Ver G');
        return;
      }
      const at = buffered.indexOf('> Prop_Hex 0 0 0 0');
      if (at < 0) return;
      hexMode = true;
      buffered = buffered.slice(at + '> Prop_Hex 0 0 0 0'.length);
    }
    // The terminators arrive glued to the preceding hex byte (loadImage writes
    // the checksum longs and then '?' as separate writes, which coalesce into
    // "a0?"). Separate them before tokenising, or the terminator is retained as
    // an incomplete token forever and the download never completes.
    buffered = buffered.replace(/([~?])/g, ' $1 ');
    const tokens = buffered.split(/\s+/);
    // Keep a trailing partial token for the next write.
    buffered = /\s$/.test(buffered) ? '' : (tokens.pop() ?? '');
    for (const tok of tokens) {
      if (tok === '' || tok === '>') continue;
      if (tok === '~') {
        state.finished = true;
        state.ok = true;
        hexMode = false;
        continue;
      }
      if (tok === '?') {
        state.ok = (sum >>> 0) === CHECKSUM_MAGIC;
        state.finished = true;
        // The final long is the checksum, not part of the image — the real ROM
        // folds it into the running sum and discards it. Keep `image` meaning
        // "what would land in hub RAM".
        state.checksum = state.image.splice(-4, 4);
        emit(state.ok ? '.' : '!');
        hexMode = false;
        continue;
      }
      if (!/^[0-9a-f]{2}$/.test(tok)) continue;
      longBuf.push(parseInt(tok, 16));
      if (longBuf.length === 4) {
        const long =
          (longBuf[0] | (longBuf[1] << 8) | (longBuf[2] << 16) | (longBuf[3] << 24)) >>> 0;
        sum = (sum + long) >>> 0;
        state.image.push(...longBuf);
        longBuf = [];
      }
    }
  }

  const makePort = () => {
    let readable;
    let writable;
    return {
      async open() {
        readable = new ReadableStream({
          start(c) {
            controller = c;
          },
        });
        writable = new WritableStream({
          write(chunk) {
            consume(String.fromCharCode(...chunk));
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
        return { usbVendorId: 0x0403, usbProductId: 0x6015 };
      },
      async setSignals({ dataTerminalReady }) {
        // A falling edge on DTR is what actually resets the P2.
        if (state.dtr === true && dataTerminalReady === false) {
          state.reset += 1;
          state.image = [];
          state.finished = false;
          state.ok = null;
          sum = 0;
          longBuf = [];
          hexMode = false;
          buffered = '';
        }
        state.dtr = dataTerminalReady;
      },
      async close() {
        try {
          controller?.close();
        } catch {
          /* already closed */
        }
      },
    };
  };

  const port = makePort();
  // Extra ports are decoys: same ids, no ROM behind them. Only the first can
  // actually be programmed, so a test that flashes a decoy would hang.
  const ports = [port, ...Array.from({ length: Math.max(0, portCount - 1) }, makePort)];
  Object.defineProperty(navigator, 'serial', {
    configurable: true,
    value: {
      async requestPort() {
        return port;
      },
      async getPorts() {
        return ports;
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });
}
