/**
 * Diagnostics end-to-end check — does a bug report actually show what happened?
 *
 * The unit tests cover the logging *machinery* (ring, sanitizer, byte ring, URL
 * builder). They cannot cover the ~64 instrumentation call sites, and the entire
 * worker half — protocol frames, correlation ids, the byte ring, the
 * worker→main batch transport — only ever runs with a device attached. That is
 * precisely the half a bug report depends on, so it needs its own check.
 *
 * Deliberately does NOT need the SIL emulator or the WS bridge: it injects a
 * scripted fake serial port instead. That keeps it runnable anywhere (and in
 * CI), and lets it drive failure modes an emulator makes awkward — notably a
 * device that returns pure garbage, which is the decode-failure path where the
 * raw byte tail earns its place.
 *
 *   node e2e/diagnostics-smoke.mjs        # needs only `npm run dev`
 */

import { chromium, installOpfsDataDir, OPFS_DIR } from './fixtures.mjs';

const APP_URL = process.env.APP_URL || 'http://localhost:5174/';
const HEADED = process.env.HEADED === '1';

/**
 * Injected before app code. A `navigator.serial` whose port behaves per `mode`:
 *
 *   'silent'  — accepts writes, never replies. Drives the timeout path and lets
 *               outbound frame logging be observed in isolation.
 *   'garbage' — streams bytes that are not valid frames, which is what a wrong
 *               baud, a half-flashed board or a noisy cable actually looks like.
 */
function installScriptedSerial(mode) {
  let controller = null;
  let timer = null;
  const port = {
    async open() {
      port.__written = [];
      const readable = new ReadableStream({
        start(c) {
          controller = c;
        },
        cancel() {
          if (timer) clearInterval(timer);
        },
      });
      const writable = new WritableStream({
        write(chunk) {
          port.__written.push(Array.from(chunk));
        },
      });
      port.__readable = readable;
      port.__writable = writable;
      if (mode === 'garbage') {
        // Deterministic non-frame bytes: reproducible failures beat random ones.
        let n = 0;
        timer = setInterval(() => {
          const buf = new Uint8Array(32);
          for (let i = 0; i < buf.length; i++) buf[i] = (n * 31 + i * 7) & 0xff;
          n += 1;
          try {
            controller.enqueue(buf);
          } catch {
            /* closed */
          }
        }, 50);
      }
    },
    get readable() {
      return port.__readable;
    },
    get writable() {
      return port.__writable;
    },
    getInfo() {
      return { usbVendorId: 0x0403, usbProductId: 0x6001 };
    },
    async close() {
      if (timer) clearInterval(timer);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(navigator, 'serial', {
    configurable: true,
    value: {
      requestPort: async () => port,
      getPorts: async () => [port],
      addEventListener() {},
      removeEventListener() {},
    },
  });
}

const snapshot = (page) => page.evaluate(() => globalThis.__madLog?.snapshot() ?? null);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Entries matching a `cat/tag`. */
const byTag = (log, cat, tag) => log.entries.filter((e) => e.cat === cat && e.tag === tag);

async function openApp(mode) {
  const browser = await chromium.launch({ channel: 'chrome', headless: !HEADED });
  const page = await browser.newPage();
  await page.addInitScript(installScriptedSerial, mode);
  await page.addInitScript(installOpfsDataDir, OPFS_DIR);
  await page.goto(`${APP_URL}#/connect`);
  await page.getByTestId('connect-device').click();
  return { browser, page };
}

const results = [];
async function scenario(name, fn) {
  process.stdout.write(`• ${name} … `);
  try {
    await fn();
    console.log('✅');
    results.push(true);
  } catch (err) {
    console.log(`❌ ${err.message}`);
    results.push(false);
  }
}

async function main() {
  try {
    const res = await fetch(APP_URL);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    console.error(`✗ App not reachable at ${APP_URL}. Start it with: npm run dev`);
    process.exit(2);
  }

  // ── The worker half exists at all ───────────────────────────────────────────
  await scenario('worker entries reach the merged timeline', async () => {
    const { browser, page } = await openApp('silent');
    try {
      await page.waitForTimeout(3000);
      const log = await snapshot(page);
      assert(log !== null, 'no __madLog hook on the page');
      const worker = log.entries.filter((e) => e.thread === 'worker');
      assert(worker.length > 0, 'no worker-thread entries — the batch transport is not delivering');
      const main = log.entries.filter((e) => e.thread === 'main');
      assert(main.length > 0, 'no main-thread entries');
      // Both threads anchor to wall clock; if that were wrong the merge would
      // interleave nonsensically and every report would be unreadable.
      const sorted = log.entries.every((e, i, a) => i === 0 || a[i - 1].t <= e.t);
      assert(sorted, 'merged timeline is not time-ordered across threads');
    } finally {
      await browser.close();
    }
  });

  // ── Outbound protocol traffic is legible ───────────────────────────────────
  await scenario('protocol writes are logged by command name', async () => {
    const { browser, page } = await openApp('silent');
    try {
      await page.waitForTimeout(3000);
      const log = await snapshot(page);
      const tx = byTag(log, 'proto', 'tx');
      assert(tx.length > 0, 'no proto/tx entries — outbound frames are invisible');
      const named = tx.filter((e) => /^[A-Z_]+\(\d+\)$/.test(e.msg ?? ''));
      assert(named.length > 0, `tx entries are not named: ${JSON.stringify(tx[0])}`);
      assert(
        tx.every((e) => typeof e.data?.bytes === 'number' || e.data?.kind === 'read'),
        'a tx entry is neither sized nor marked as a read',
      );
      // Reads and writes share the protocol id space, so a name resolved
      // without direction is not merely vague — it is wrong. A read must never
      // be reported under a WRITE_ name.
      const misnamed = tx.filter((e) => e.data?.kind === 'read' && /^WRITE_/.test(e.msg ?? ''));
      assert(misnamed.length === 0, `read frames labelled as writes: ${misnamed.map((e) => e.msg).join(', ')}`);
      // And the op's own name must agree with the frame it sent.
      const starts = byTag(log, 'proto', 'op-start');
      for (const s of starts.filter((e) => /^read[A-Z]/.test(e.msg ?? ''))) {
        const frame = tx.find((e) => e.data?.op === s.data?.op);
        assert(
          frame === undefined || /^READ_/.test(frame.msg ?? ''),
          `op ${s.msg} sent a frame named ${frame?.msg}`,
        );
      }
    } finally {
      await browser.close();
    }
  });

  // ── Correlation: an action's frames can be traced back to it ───────────────
  await scenario('ops are bracketed and their frames carry the op id', async () => {
    const { browser, page } = await openApp('silent');
    try {
      await page.waitForTimeout(3000);
      const log = await snapshot(page);
      const starts = byTag(log, 'proto', 'op-start');
      assert(starts.length > 0, 'no op-start entries — nothing is correlated');
      assert(starts.every((e) => typeof e.data?.op === 'number'), 'op-start lacks an op id');
      const tagged = byTag(log, 'proto', 'tx').filter((e) => typeof e.data?.op === 'number');
      assert(tagged.length > 0, 'no tx frame carries an op id');
      // The op id must actually match one that was opened, or correlation is noise.
      const ids = new Set(starts.map((e) => e.data.op));
      assert(tagged.every((e) => ids.has(e.data.op)), 'a tx frame references an unknown op id');
    } finally {
      await browser.close();
    }
  });

  // ── A device that never answers is diagnosable ─────────────────────────────
  await scenario('an unresponsive device produces timeouts, not silence', async () => {
    const { browser, page } = await openApp('silent');
    try {
      await page.waitForTimeout(7000);
      const log = await snapshot(page);
      const timeouts = byTag(log, 'proto', 'timeout');
      const failed = log.entries.filter((e) => e.level === 'error' || e.level === 'warn');
      assert(
        timeouts.length > 0 || failed.length > 0,
        'a device that never replies produced no warning at all',
      );
    } finally {
      await browser.close();
    }
  });

  // ── The decode-failure path, where the byte tail earns its place ───────────
  await scenario('garbage on the wire is captured with its bytes', async () => {
    const { browser, page } = await openApp('garbage');
    try {
      await page.waitForTimeout(6000);
      const log = await snapshot(page);
      const withTail = log.entries.filter((e) => typeof e.data?.tail === 'string' && e.data.tail !== '');
      assert(
        withTail.length > 0,
        'garbage produced no entry carrying a byte tail — a framing bug would be undiagnosable',
      );
      const tail = withTail[0].data.tail;
      assert(/^([0-9a-f]{2} )*[0-9a-f]{2}$/.test(tail), `tail is not a hex dump: ${tail}`);
    } finally {
      await browser.close();
    }
  });

  // ── Detection must survive a reconnect, not just the first session ─────────
  await scenario('a reconnected session still detects garbage', async () => {
    const { browser, page } = await openApp('garbage');
    try {
      await page.waitForTimeout(8000);
      const first = (await snapshot(page)).entries.filter((e) => e.tag === 'undecodable').length;
      assert(first > 0, 'no undecodable warning in the first session');

      // Session-scoped watchdog state that is not reset on connect would make
      // every later session silently undiagnosable.
      await page.evaluate(() => globalThis.__madLog.clear());
      await page.goto(`${APP_URL}#/connect`);
      await page.getByRole('button', { name: /^Disconnect$/ }).click();
      await page.getByTestId('connect-device').waitFor({ timeout: 8000 });
      await page.getByTestId('connect-device').click();
      await page.waitForTimeout(8000);

      const second = (await snapshot(page)).entries.filter((e) => e.tag === 'undecodable').length;
      assert(second > 0, 'reconnected session produced no undecodable warning');
    } finally {
      await browser.close();
    }
  });

  // ── The artifact a maintainer actually receives ────────────────────────────
  await scenario('the exported bundle contains the wire bytes', async () => {
    const { browser, page } = await openApp('garbage');
    try {
      await page.waitForTimeout(4000);
      const bundle = await page.evaluate(async () => {
        const mod = await import('/src/diagnostics/exportBundle.ts');
        return mod.buildDiagnosticsBundle({ includeSerialTail: true });
      });
      assert(bundle.version !== 'unknown', 'bundle has no build version');
      assert(bundle.gitSha !== 'unknown', 'bundle has no git sha');
      assert(bundle.log.entries.length > 0, 'bundle carries an empty log');
      assert(bundle.serialTail, 'bundle has no serial tail despite being asked for one');
      assert(bundle.serialTail.chunks.length > 0, 'serial tail has no chunks');
      assert(bundle.serialTail.totalRxBytes > 0, 'serial tail recorded no received bytes');
      const rx = bundle.serialTail.chunks.filter((c) => c.dir === 'rx');
      assert(rx.length > 0, 'no RX chunks captured');
      assert(typeof rx[0].b64 === 'string' && rx[0].b64.length > 0, 'RX chunk carries no payload');
      // Worker counters must survive into the bundle too.
      assert(bundle.worker && typeof bundle.worker.bytesIn === 'number', 'bundle lacks worker counters');
      assert(bundle.worker.bytesIn > 0, 'worker reports no bytes in despite a talking device');
    } finally {
      await browser.close();
    }
  });

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} diagnostics checks passed`);
  if (passed !== results.length) process.exit(1);
  console.log('✅ a bug report from this build would show what happened');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
