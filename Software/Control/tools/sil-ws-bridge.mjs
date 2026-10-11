/**
 * Dev-only WebSocket ↔ PTY bridge for testing the web app against the SIL emulator.
 *
 * The browser's Web Serial API cannot see the emulator's pseudo-terminal
 * (`/tmp/tty.rpi`), so this tiny relay opens the PTY and pipes its raw bytes
 * over a WebSocket. The web app's dev "Connect to SIL" path wraps that socket
 * as readable/writable streams and hands them to the device worker exactly like
 * a real serial port.
 *
 *   Terminal 1:  an emulator on /tmp/tty.rpi (MAD_PTY overrides the path)
 *   Terminal 2:  npm run sil:bridge                  # this relay on ws://localhost:9999
 *   Terminal 3:  npm run dev                         # then click "Connect to SIL"
 *
 * Nothing serves /tmp/tty.rpi any more. It was the native firmware library's
 * path, and that library is gone. The ISS playground is on /tmp/tty.iss on
 * purpose (`make playground-pty`): the ISS behind this bridge is not a valid
 * SIL configuration, because the browser runs at host speed and every wait it
 * makes measures the host, not the machine (SIL/makefile). The valid one, the
 * ISS with the app in Chrome on the board's clock (`make playground`, embsim's
 * chrome-cdp), does not use this bridge.
 *
 * The PTY slave is already in raw mode (cfmakeraw, no echo/canonical) — see
 * SIL/embsim/core/src/serial_pty.rs — so plain fd read/write passes bytes through.
 */

import { WebSocketServer } from 'ws';
import { open } from 'node:fs/promises';

const PTY_PATH = process.env.MAD_PTY || '/tmp/tty.rpi';
const PORT = Number(process.env.PORT || 9999);
const READ_BUF = 4096;

const wss = new WebSocketServer({ port: PORT });
console.log(`[sil-ws-bridge] listening on ws://localhost:${PORT}, PTY=${PTY_PATH}`);

wss.on('connection', async (ws) => {
  console.log('[sil-ws-bridge] client connected; opening PTY…');
  let fh;
  try {
    fh = await open(PTY_PATH, 'r+');
  } catch (err) {
    console.error(`[sil-ws-bridge] failed to open ${PTY_PATH}:`, err.message);
    ws.close();
    return;
  }

  let alive = true;
  const stop = () => {
    if (!alive) return;
    alive = false;
    fh.close().catch(() => {});
    console.log('[sil-ws-bridge] client disconnected; PTY closed');
  };

  // browser → PTY
  ws.on('message', (data) => {
    if (!alive) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    fh.write(buf).catch((err) => {
      console.error('[sil-ws-bridge] PTY write error:', err.message);
    });
  });
  ws.on('close', stop);
  ws.on('error', stop);

  // PTY → browser
  const buf = Buffer.alloc(READ_BUF);
  (async () => {
    while (alive) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const { bytesRead } = await fh.read(buf, 0, READ_BUF, null);
        if (bytesRead > 0 && ws.readyState === ws.OPEN) {
          ws.send(buf.subarray(0, bytesRead));
        } else if (bytesRead === 0) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 5));
        }
      } catch {
        break;
      }
    }
    stop();
  })();
});
