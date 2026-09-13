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
const playwright = require('playwright');

/**
 * When MAD_COVERAGE=1 the app is built with istanbul instrumentation (see
 * vite.config.ts) and every page exposes `window.__coverage__`. Wrapping
 * `chromium` here means each scenario's coverage is harvested on browser
 * close, with no change to the scenarios themselves — they all launch through
 * this export.
 *
 * Without the wrapper, e2e runs in a separate browser process and is entirely
 * invisible to the coverage number, which is why the flashing screen read 0%
 * while nine scenarios were exercising it.
 */
const COVERAGE_DIR = process.env.MAD_COVERAGE_DIR || 'coverage/e2e';
let coverageSeq = 0;

async function harvest(page) {
  try {
    if (page.isClosed()) return;
    const data = await page.evaluate(() => window.__coverage__ ?? null);
    if (!data) return;
    await mkdir(COVERAGE_DIR, { recursive: true });
    await writeFile(join(COVERAGE_DIR, `e2e-${process.pid}-${coverageSeq++}.json`), JSON.stringify(data));
  } catch {
    /* page torn down mid-harvest; a lost sample must never fail a scenario */
  }
}

function withCoverage(browserType) {
  return {
    ...browserType,
    async launch(opts) {
      const browser = await browserType.launch(opts);
      const pages = new Set();
      const newPage = browser.newPage.bind(browser);
      browser.newPage = async (...args) => {
        const page = await newPage(...args);
        pages.add(page);
        return page;
      };
      const close = browser.close.bind(browser);
      browser.close = async (...args) => {
        for (const page of pages) await harvest(page);
        return close(...args);
      };
      return browser;
    },
  };
}

export const chromium =
  process.env.MAD_COVERAGE === '1' ? withCoverage(playwright.chromium) : playwright.chromium;

/**
 * Computer-node mode: `CDP_URL` names the DevTools endpoint of the Chrome
 * running INSIDE the emulator's QEMU guest (`mad-emulator --iss ... --computer
 * <image>` prints it). Pages are then opened over CDP in that browser instead
 * of a host Chrome, the app uses its real Web Serial (the guest's managed
 * policy grants the board's FTDI without a picker), and the fake serial is
 * not installed. The guest lives on the board's clock, so every wall-clock
 * wait in the harness is scaled by `E2E_TIMEOUT_SCALE` (default 10 here).
 * Serve the app to the guest with `npm run dev -- --host`; it reaches the
 * host at 10.0.2.2.
 */
export const CDP_URL = process.env.CDP_URL || '';
export const APP_URL =
  process.env.APP_URL || (CDP_URL ? 'http://10.0.2.2:5174/' : 'http://localhost:5174/');
/** Where the runner checks the dev server from the HOST (the guest's URL is not routable here). */
export const APP_URL_HOST = process.env.APP_URL_HOST || (CDP_URL ? 'http://localhost:5174/' : APP_URL);
export const BRIDGE_URL = process.env.BRIDGE_URL || 'ws://localhost:9999';
export const TIMEOUT_SCALE = Number(process.env.E2E_TIMEOUT_SCALE || (CDP_URL ? 10 : 1));
/** A wall-clock budget, scaled for a browser that lives on simulated time. */
export const T = (ms) => Math.round(ms * TIMEOUT_SCALE);
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
  let browser;
  let page;
  if (CDP_URL) {
    // The browser inside the computer node: attach, never launch. Closing
    // the Browser object later only disconnects; the guest's Chrome lives on.
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: T(30000) });
    // A fresh context per scenario. The guest's Chrome outlives every
    // scenario, and its default profile would carry the app's remembered
    // port and data folder from one to the next — the app then reconnects
    // by itself and the harness's clicks land on a screen that is already
    // moving on. A new context is isolated storage (and is torn down by
    // browser.close(), page and serial port with it).
    const context = await browser.newContext();
    page = await context.newPage();
    page.setDefaultTimeout(T(30000));
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: !headed });
    page = await browser.newPage();
  }
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
  // Init scripts ride CDP too, so the OPFS picker fake works in the guest;
  // only the serial fake is host-only — the guest has the real thing.
  if (!CDP_URL) await page.addInitScript(installFakeSerial, BRIDGE_URL);
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
    // Over CDP, closing the Browser object only disconnects; the page (and
    // the serial port it holds) must be closed explicitly.
    if (CDP_URL) await page.close().catch(() => {});
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
/**
 * The granted port that is the board. On the host the fake grants exactly
 * one; in the computer node the guest's managed policy grants every port —
 * its own consoles included — and the board is the emulated FTDI (USB
 * 0403:6001), whose label is a sibling of the button in its row.
 */
export function boardGrantedPort(page) {
  if (CDP_URL) {
    return page.locator('.row', { hasText: /403:6001/i }).getByTestId('connect-granted').first();
  }
  return page.getByTestId('connect-granted').first();
}

export async function connectToSil(page) {
  await page.goto(`${APP_URL}#/connect`);
  // First point at which the app is loaded and can take a marker.
  if (currentScenario !== null) await markAppLog(page, `scenario ${currentScenario}`);
  if (CDP_URL) {
    // Real Web Serial: the guest's managed policy has already granted every
    // port, so the Connect screen lists them; pick the board's FTDI (the
    // emulated FT232, USB 0403:6001) rather than the guest's own consoles.
    await boardGrantedPort(page).click({ timeout: T(10000) });
  } else {
    // The primary button (testid connect-device) prompts requestPort() → our fake.
    await page.getByTestId('connect-device').click();
  }
  // Wait until the store reports connected — the status dot gets `.connected`.
  // (Matching on text would falsely hit "Disconnected".)
  await page.locator('.dot.connected').waitFor({ timeout: T(10000) });
}

/**
 * Put the machine back to idle after a scenario failed.
 *
 * The emulator is long-lived, and `newSilPage` isolates only the BROWSER — the
 * firmware's machine state survives every scenario boundary. So a scenario that
 * leaves a test running poisons each one after it: the app gates the jog and
 * speed controls while `testRunning` is true, and the next scenario then fails
 * filling a disabled field instead of on its own merits. One hung run turned
 * into five red scenarios, four of them meaningless, which hides how much is
 * actually broken.
 *
 * Disabling motion is the machine's own abort path (app_testManagement ends a
 * running test the instant motion goes false), and it leaves the machine in the
 * state scenarios already expect to find it in: every motion scenario enables
 * motion itself via zeroLength().
 *
 * Best effort by construction — a recovery that fails must never mask the real
 * failure it is recovering from.
 */
export async function recoverMachine() {
  let browser;
  try {
    const session = await newSilPage();
    browser = session.browser;
    const { page } = session;
    await connectToSil(page);
    await page.goto(`${APP_URL}#/live`);
    // The control is a single toggle whose label follows motionEnabled, so this
    // locator matches nothing at all when motion is already off.
    const disable = page.getByRole('button', { name: 'Disable motion' });
    await disable.waitFor({ state: 'visible', timeout: T(5000) }).catch(() => {});
    if ((await disable.count()) > 0) {
      await disable.click().catch(() => {});
    }
  } catch {
    // Swallowed on purpose: see the note above.
  } finally {
    await browser?.close().catch(() => {});
  }
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
 * Options (a bare number is still accepted as `ports`, for brevity):
 *   ports        how many indistinguishable adapters getPorts() reports. 0
 *                exercises "nothing granted"; >1 the refusal to guess.
 *                requestPort() always returns the one real ROM.
 *   getPortsFails make getPorts() reject, as a permissions policy would.
 *   writeDelayMs  slow the sink so mid-upload UI states are observable.
 */
export function installFakeBootRom(options = 1) {
  const { ports: portCount = 1, getPortsFails = false, writeDelayMs = 0 } =
    typeof options === 'number' ? { ports: options } : options;
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
          async write(chunk) {
            if (writeDelayMs) await new Promise((r) => setTimeout(r, writeDelayMs));
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
  // ports: 0 means nothing has been granted yet — requestPort() still hands
  // back the real ROM, which is what the chooser would do.
  const ports =
    portCount === 0 ? [] : [port, ...Array.from({ length: portCount - 1 }, makePort)];
  Object.defineProperty(navigator, 'serial', {
    configurable: true,
    value: {
      async requestPort() {
        return port;
      },
      async getPorts() {
        if (getPortsFails) throw new DOMException('denied', 'SecurityError');
        return ports;
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });
}
