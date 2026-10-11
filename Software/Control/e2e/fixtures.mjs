/**
 * Shared E2E harness helpers.
 *
 * The app knows ONLY Web Serial + the File System Access picker, so its
 * normal code paths run unchanged against:
 *
 *   - `navigator.serial`: on the board route, the shim of the `chrome-cdp`
 *     node `mad-emulator --chrome` runs (the board's protocol line, in a
 *     Chrome the board's clock meters; see "Board mode" below). Elsewhere a
 *     fake SerialPort over a WebSocket bridge (the hardware harness).
 *   - `showDirectoryPicker()` → an OPFS directory (real FileSystemDirectoryHandle,
 *     no dialog, no permission prompt), installed by `page.addInitScript`.
 *
 * Playwright comes from this package; a host Chrome is launched via channel
 * (no browser download).
 *
 * Usage (plain node script):
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
 * Board mode: `CDP_URL` names the DevTools endpoint of the host's Chrome that
 * `mad-emulator --chrome` launched (embsim's `chrome-cdp` node; the run
 * prints "DevTools at http://127.0.0.1:PORT" once Chrome is reached). That
 * Chrome lives the board's time: every page and dedicated worker is held to
 * the board's clock over DevTools, a 1 ms quantum at a time, and every
 * page's `navigator.serial` is the node's shim, whose one port is the
 * board's protocol line (USB 0403:6001, granted to every origin with
 * `--granted`). So in this mode:
 *
 *   - pages are made in a fresh browser context per scenario, at about:blank,
 *     then navigated (Chrome holds a page made that way from birth; one made
 *     with a URL runs before the shim, and the node stops the run);
 *   - no fake serial is installed: the shim is the port, by Chrome's rules;
 *   - the cable is the node's: `dropLink()` pulls it, `restoreLink()` puts it
 *     back (`__embsim.link`, acted on at the node's next slice);
 *   - every budget is board time. A locator's `waitFor({ timeout })` counts
 *     the page's clock (see `meterLocatorWaits`), `waitPageTime()` replaces
 *     `waitForTimeout`, and `pageClock()` replaces `Date.now()` deadlines.
 *     Playwright's own timeouts run on host time, so they only back stop a
 *     hang here (`HOST_BACKSTOP_MS`);
 *   - animation frames barely run on virtual time, so Playwright's
 *     actionability checks ("stable") stall: `press()` checks the element
 *     itself and forces the click.
 *
 * Without `CDP_URL` only the board-free scenarios mean anything: they launch
 * a host Chrome against in-page fakes. The fake serial below
 * (`installFakeSerial`, over a WebSocket bridge) remains for the hardware
 * harness, `hw-read-save-config.mjs` over `tools/hw-ws-bridge.mjs`, which
 * runs in real time against a real board.
 */
export const CDP_URL = process.env.CDP_URL || '';
/** The board-touching route is up: the app runs in the Chrome the board's clock meters. */
export const BOARD = CDP_URL !== '';
export const APP_URL = process.env.APP_URL || 'http://localhost:5174/';
/** Where the runner checks the dev server from: the same host, on either route. */
export const APP_URL_HOST = process.env.APP_URL_HOST || APP_URL;
export const BRIDGE_URL = process.env.BRIDGE_URL || 'ws://localhost:9999';
export const OPFS_DIR = process.env.OPFS_DIR || 'mad-e2e';

/**
 * Playwright's own timeouts (navigation, `fill`, `textContent`, a forced
 * click) are host time. In board mode they bound a hang only: what the suite
 * waits FOR is counted on the page's clock. A grant that sticks stops the
 * emulator first (its `chrome-cdp` fails the run after 30 s of host time).
 */
export const HOST_BACKSTOP_MS = Number(process.env.E2E_HOST_BACKSTOP_MS || 15 * 60_000);

/** Pages whose clock is the board's (board mode's). */
const metered = new WeakSet();

const hostSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The page's clock: its document (by time origin) and `performance.now()`.
 * Null while the page is between documents. Every read also books the time
 * the page has lived (`lifetimes`), which the runner reports per scenario.
 */
const lifetimes = new WeakMap();
async function pageNow(page) {
  let read;
  try {
    read = await page.evaluate(() => ({ doc: performance.timeOrigin, now: performance.now() }));
  } catch (err) {
    // A page between two documents answers nothing for a moment; a page
    // that is gone (closed, crashed, its browser stopped) never will, and a
    // wait on its clock would never end.
    if (page.isClosed() || /closed|crash|disconnected/i.test(String(err?.message ?? err))) throw err;
    return null;
  }
  const book = lifetimes.get(page);
  if (book) book.ms += advance(book, read);
  return read;
}

/**
 * How far the clock moved from `mark`'s reading to `read`, moving `mark`
 * on. A new document starts its own `performance.now()` at 0, so its whole
 * age counts (what the old one lived after its last reading is not seen).
 */
function advance(mark, read) {
  let moved = 0;
  if (mark.doc === undefined) moved = 0;
  else if (read.doc === mark.doc && read.now >= mark.now) moved = read.now - mark.now;
  else moved = read.now;
  mark.doc = read.doc;
  mark.now = read.now;
  return moved;
}

/**
 * A stopwatch on the page's own clock: the board's in board mode (the node
 * keeps the page within a quantum of it), the host's for a host Chrome.
 * Only forward time counts, so a navigation to a new document neither ends
 * nor stretches a wait.
 */
export async function pageClock(page) {
  const mark = {};
  let elapsed = 0;
  const first = await pageNow(page);
  if (first) advance(mark, first);
  return {
    async elapsed() {
      const read = await pageNow(page);
      if (read) elapsed += advance(mark, read);
      return elapsed;
    },
  };
}

/** Board time (page time) the closed pages lived since the last call: the runner's per-scenario figure. */
let livedSinceTake = 0;
export function takePageTime() {
  const ms = livedSinceTake;
  livedSinceTake = 0;
  return ms;
}

/** Wait `ms` of the page's time (`waitForTimeout`, counted on the page's clock). */
export async function waitPageTime(page, ms) {
  const clock = await pageClock(page);
  while ((await clock.elapsed()) < ms) await hostSleep(BOARD ? 25 : 10);
}

/**
 * In board mode, make a locator's `waitFor({ timeout })` count its timeout on
 * the page's clock. Playwright polls on host time; the board runs at a few
 * percent of real time, and at a fraction of that while the firmware works
 * its SD card, so a host-time budget measures the host. Every `waitFor` in
 * the suite keeps its budget, read as board time. Patched once, on the
 * Locator class; a page outside board mode (A1's and the FW scenarios' host
 * Chrome) keeps Playwright's own.
 */
let locatorWaitsMetered = false;
function meterLocatorWaits(page) {
  if (locatorWaitsMetered) return;
  locatorWaitsMetered = true;
  const proto = Object.getPrototypeOf(page.locator('html'));
  const hostWaitFor = proto.waitFor;
  proto.waitFor = async function waitFor(options = {}) {
    const owner = this.page();
    if (!metered.has(owner)) return hostWaitFor.call(this, options);
    const budget = options.timeout === 0 ? Infinity : (options.timeout ?? 30_000);
    const clock = await pageClock(owner);
    for (;;) {
      try {
        return await hostWaitFor.call(this, { ...options, timeout: 1000 });
      } catch (err) {
        if (!(err instanceof playwright.errors.TimeoutError)) throw err;
      }
      if ((await clock.elapsed()) >= budget) {
        throw new playwright.errors.TimeoutError(
          `${this} was not ${options.state ?? 'visible'} within ${budget} ms of board time`,
        );
      }
    }
  };
}

/**
 * Click the way the board route allows. Animation frames barely run on
 * virtual time, so a plain `click()` waits forever for the element to be
 * "stable"; this checks what that check protects instead: the element is
 * visible, it is enabled, and it is what the page would hit at its centre
 * (`elementFromPoint`, so a click cannot land through an overlay). Then it
 * forces the click. The budget is the page's time, as every wait here.
 */
export async function press(locator, { timeout = 15_000 } = {}) {
  const page = locator.page();
  await locator.waitFor({ state: 'visible', timeout });
  const clock = await pageClock(page);
  let why = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const enabled = await locator.isEnabled();
    // eslint-disable-next-line no-await-in-loop
    const hit = await locator.evaluate((el) => {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at && (at === el || el.contains(at)) ? '' : (at ? at.outerHTML.slice(0, 120) : 'nothing');
    });
    if (enabled && hit === '') break;
    why = enabled ? `covered by ${hit}` : 'disabled';
    // eslint-disable-next-line no-await-in-loop
    if ((await clock.elapsed()) >= timeout) {
      throw new Error(`press ${locator}: still ${why} after ${timeout} ms of page time`);
    }
    // eslint-disable-next-line no-await-in-loop
    await hostSleep(BOARD ? 25 : 10);
  }
  await locator.click({ force: true, timeout: HOST_BACKSTOP_MS });
}

/**
 * Drop the link the app is using. The cable stays out until
 * `restoreLink()` (`clickReconnect` in run-all puts it back first).
 *
 * Board mode: the node's own cable. `__embsim.link('unplug')` is acted on at
 * the node's next slice: the port's streams error with NetworkError ("The
 * device has been lost."), `disconnect` fires, and `getPorts()` stops
 * listing it, as an unplugged FTDI does.
 *
 * The bridge's fake serial (the hardware harness) closes its socket and
 * fires `disconnect` while `getPorts()` keeps the port, so the app can
 * reconnect to the same port with nothing put back.
 */
export async function dropLink(page) {
  if (!BOARD) {
    await page.evaluate(() => window.__silDropLink());
    return;
  }
  await page.evaluate(() => globalThis.__embsim.link('unplug'));
}

/**
 * Put the cable back. Board mode: at the node's next slice the port comes
 * back as a new `SerialPort` and `connect` fires, which the app answers by
 * reconnecting to the port whose USB ids it remembers.
 */
export async function restoreLink(page) {
  if (!BOARD) return;
  await page.evaluate(() => globalThis.__embsim.link('plug'));
}

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
 * A page for one scenario, the OPFS data folder installed.
 *
 * Board mode: a fresh context in the Chrome the board's clock meters, and a
 * page made at about:blank (scenarios navigate it). No serial fake: the
 * node's shim is the page's port. Otherwise a host Chrome with the bridge's
 * fake serial (the hardware harness). Pass { headed: true } to watch a host
 * Chrome.
 */
export async function newSilPage({ headed = false } = {}) {
  let browser;
  let context;
  let page;
  if (BOARD) {
    // Attach, never launch: the emulator launched this Chrome, and closing
    // the Browser object later only disconnects.
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: HOST_BACKSTOP_MS });
    // A fresh context per scenario: Chrome outlives every scenario, and a
    // shared profile would carry the app's remembered port and data folder
    // from one to the next (the app then reconnects by itself and the
    // harness's clicks land on a screen that is already moving on). Each
    // context gets a window of its own, so no scenario's page is a hidden
    // background tab, which the node meters at a higher host cost.
    context = await browser.newContext();
    await context.addInitScript(installOpfsDataDir, OPFS_DIR);
    page = await context.newPage();
    metered.add(page);
    lifetimes.set(page, { ms: 0 });
    meterLocatorWaits(page);
    page.setDefaultTimeout(HOST_BACKSTOP_MS);
    page.setDefaultNavigationTimeout(HOST_BACKSTOP_MS);
    // Let the board run a few slices before the scenario starts: the node
    // releases a port the previous scenario's page held at the slice after
    // that page went, so this page finds the port free.
    await waitPageTime(page, 20);
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: !headed });
    page = await browser.newPage();
    await page.addInitScript(installFakeSerial, BRIDGE_URL);
    await page.addInitScript(installOpfsDataDir, OPFS_DIR);
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
    // Over CDP, closing the Browser object only disconnects; the context (and
    // the page and port it holds) must be closed explicitly.
    if (context) {
      await pageNow(page);
      livedSinceTake += lifetimes.get(page)?.ms ?? 0;
      await context.close().catch(() => {});
    }
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

/**
 * The granted port that is the board. The bridge's fake grants exactly one;
 * on the board route the node's port is the board's FTDI (USB 0403:6001),
 * whose label is a sibling of the button in its row.
 */
export function boardGrantedPort(page) {
  if (BOARD) {
    return page.locator('.row', { hasText: /403:6001/i }).getByTestId('connect-granted').first();
  }
  return page.getByTestId('connect-granted').first();
}

/** Connect the app to the board through the Connect screen. */
export async function connectToSil(page) {
  await page.goto(`${APP_URL}#/connect`);
  // First point at which the app is loaded and can take a marker.
  if (currentScenario !== null) await markAppLog(page, `scenario ${currentScenario}`);
  if (BOARD) {
    // The emulator grants the port to every origin (`--granted`, as Chrome's
    // SerialAllowUsbDevicesForUrls policy would), so the Connect screen
    // lists it as granted.
    await press(boardGrantedPort(page), { timeout: 10_000 });
  } else {
    // The primary button (testid connect-device) prompts requestPort() → our fake.
    await press(page.getByTestId('connect-device'));
  }
  // Wait until the store reports connected — the status dot gets `.connected`.
  // (Matching on text would falsely hit "Disconnected".)
  await page.locator('.dot.connected').waitFor({ timeout: 10_000 });
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
    await disable.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    if ((await disable.count()) > 0) {
      await press(disable).catch(() => {});
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
  await press(page.getByRole('button', { name: /Choose folder/i }));
  await page.getByText(/Current:/).waitFor({ timeout: 8000 });
}

/**
 * Install a `navigator.serial` whose port emulates the Propeller 2 boot ROM's
 * serial loader, entirely in-page.
 *
 * The SIL emulator does not serve this yet: its ROM boot (`--boot-rom`) puts
 * the host on a PTY and nothing models DTR, so a DTR pulse from the app could
 * not reset the chip. This fake is therefore the only way to drive the real
 * flashing UI end to end.
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
