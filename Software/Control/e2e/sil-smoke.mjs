/**
 * SIL end-to-end smoke test.
 *
 * The web app knows ONLY Web Serial. This harness abstracts the SIL emulator
 * into a serial port by injecting a fake `navigator.serial` whose `SerialPort`
 * is backed by the WS↔PTY bridge — so the app's ordinary `requestPort()` /
 * `port.open()` / stream-transfer path runs completely unchanged.
 *
 * Prereqs (each in its own terminal):
 *   cd SIL && make e2e-emulator            # emulator on /tmp/tty.rpi (unpaced virtual time)
 *   npm run sil:bridge                   # WS bridge on ws://localhost:9999
 *   npm run dev                          # app on http://localhost:5174
 * Then: node e2e/sil-smoke.mjs
 *
 * Playwright/Chromium are reused from the SIL workspace.
 */

import { chromium } from './fixtures.mjs';

const APP_URL = process.env.APP_URL || 'http://localhost:5174';
const BRIDGE_URL = process.env.BRIDGE_URL || 'ws://localhost:9999';
const HEADED = process.env.HEADED === '1';

// Injected into the page before any app code runs. Defines a fake serial port
// over a WebSocket to the bridge, indistinguishable from a real one to the app.
function installFakeSerial(bridgeUrl) {
  function makePort() {
    let ws;
    let readable;
    let writable;
    return {
      async open() {
        ws = new WebSocket(bridgeUrl);
        ws.binaryType = 'arraybuffer';
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = () => reject(new Error('bridge connection failed'));
        });
        let controller;
        readable = new ReadableStream({
          start(c) {
            controller = c;
          },
          cancel() {
            try {
              ws.close();
            } catch {
              /* ignore */
            }
          },
        });
        ws.onmessage = (e) => {
          try {
            controller.enqueue(new Uint8Array(e.data));
          } catch {
            /* stream closed */
          }
        };
        ws.onclose = () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        writable = new WritableStream({
          write(chunk) {
            if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
          },
          close() {
            try {
              ws.close();
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
  }

  const port = makePort();
  Object.defineProperty(navigator, 'serial', {
    configurable: true,
    value: {
      requestPort: async () => port,
      getPorts: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  });
  if (!('showDirectoryPicker' in window)) {
    window.showDirectoryPicker = async () => {
      throw new Error('not available in test');
    };
  }
}

async function main() {
  // Use the system Google Chrome (channel) to avoid a Playwright browser download.
  const browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });
  const page = await browser.newPage();
  page.on('console', (msg) => console.log('  [page]', msg.text()));
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message));

  await page.addInitScript(installFakeSerial, BRIDGE_URL);
  await page.goto(APP_URL);

  // Gate should pass (fake serial + showDirectoryPicker stub present).
  await page.getByRole('button', { name: /connect device/i }).click();

  // Live numeric readouts update from periodic samples. Wait for a real number.
  await page.getByRole('link', { name: /^Live$/ }).click();

  const machineForce = page
    .locator('.readout')
    .filter({ hasText: 'Machine Force' })
    .locator('.value');

  let lastText = '';
  const deadline = Date.now() + 15000;
  let ok = false;
  while (Date.now() < deadline) {
    lastText = (await machineForce.textContent())?.trim() ?? '';
    // A populated readout looks like "12.345 N"; the placeholder is "— N".
    if (/^-?\d/.test(lastText)) {
      ok = true;
      break;
    }
    await page.waitForTimeout(250);
  }

  console.log(`\nMachine Force readout: "${lastText}"`);
  console.log(ok ? '✅ SIL smoke test PASSED — live samples flowing' : '❌ FAILED — no live sample data');

  await browser.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test error:', err);
  process.exit(1);
});
