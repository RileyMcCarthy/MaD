/**
 * Dev-only WebSocket ↔ real-serial bridge for driving the web app against
 * ACTUAL P2 hardware (sibling of tools/sil-ws-bridge.mjs, which targets the SIL
 * emulator PTY).
 *
 * The browser's Web Serial API can't be auto-selected under Playwright, so the
 * e2e fixtures install a fake `navigator.serial` whose port dials this relay
 * (ws://localhost:9999). Here we open the real USB-serial port with the native
 * `serialport` library (which sets non-standard bauds correctly on macOS via
 * IOSSIOSPEED — plain `stty` does not) and pipe raw bytes both ways.
 *
 *   MAD_SERIAL=/dev/cu.usbserial-XXXX npm run hw:bridge   # or: node tools/hw-ws-bridge.mjs
 *
 * Binary frames are serial data. Text frames are a small control channel, so
 * the app's firmware loader can reset the board through the fake port:
 *   - on connect the bridge sends `{"hello":"hw-ws-bridge"}`;
 *   - the client sends `{"signals":{dataTerminalReady,requestToSend,break}}`
 *     (Web Serial's `setSignals` shape) and gets `{"ack":true}` once applied.
 * Each binary frame is acked the same way once the port has drained it, which
 * gives the client a real port's write backpressure.
 * Writes and signal changes are applied strictly in arrival order. The port
 * opens at the `?baud=` the client asked for (`port.open({ baudRate })`),
 * else MAD_BAUD. A connection's open waits for the previous one's close, so a
 * reconnect never races a port that is still flushing.
 *
 * Opening a port asserts DTR, as Chrome's own Web Serial does. On a Prop Plug
 * (DTR AC-coupled to RESn) that edge resets the P2 once per connect; on a
 * separate protocol FTDI with no reset wiring it does nothing.
 */
import { WebSocketServer } from 'ws';
import { SerialPort } from 'serialport';

const DEV = process.env.MAD_SERIAL || '/dev/cu.usbserial-A5069RR4';
const BAUD = Number(process.env.MAD_BAUD || 2000000);
const PORT = Number(process.env.PORT || 9999);

/** Settles when the last connection's port is closed. */
let released = Promise.resolve();

const wss = new WebSocketServer({ port: PORT });
console.log(`[hw-ws-bridge] listening on ws://localhost:${PORT}, SERIAL=${DEV} @ ${BAUD}`);

wss.on('connection', (ws, req) => {
  const asked = Number(new URL(req.url ?? '/', 'ws://x').searchParams.get('baud'));
  const baudRate = asked > 0 ? asked : BAUD;
  console.log(`[hw-ws-bridge] client connected; opening serial @ ${baudRate}…`);
  const port = new SerialPort({ path: DEV, baudRate, autoOpen: false });
  // serialport's set() writes every line, so keep what the client last chose.
  const lines = { dtr: true, rts: true, brk: false };

  // One queue for opening, writes and signal changes: a DTR pulse must land
  // between exactly the bytes it was sent between.
  let opened = false;
  let queue = released
    .then(
      () =>
        new Promise((resolve, reject) => {
          port.open((err) => (err ? reject(err) : resolve()));
        }),
    )
    .then(
      () => {
        opened = true;
      },
      (err) => {
        console.error(`[hw-ws-bridge] failed to open ${DEV}:`, err.message);
        ws.close();
      },
    );
  const enqueue = (op) => {
    queue = queue.then(() => (opened ? op() : undefined)).catch((err) => {
      console.error('[hw-ws-bridge] op failed:', err?.message ?? err);
    });
  };
  const ack = () => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ack: true }));
  };

  ws.send(JSON.stringify({ hello: 'hw-ws-bridge' }));

  // serial → browser
  port.on('data', (d) => {
    if (ws.readyState === ws.OPEN) ws.send(d);
  });
  port.on('error', (e) => {
    console.error('[hw-ws-bridge] serial error:', e.message);
    try { ws.close(); } catch { /* ignore */ }
  });

  // browser → serial
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const { signals } = JSON.parse(data.toString());
      enqueue(
        () =>
          new Promise((resolve) => {
            if ('dataTerminalReady' in signals) lines.dtr = signals.dataTerminalReady;
            if ('requestToSend' in signals) lines.rts = signals.requestToSend;
            if ('break' in signals) lines.brk = signals.break;
            port.set(lines, (err) => {
              if (err) console.error('[hw-ws-bridge] set signals failed:', err.message);
              ack();
              resolve();
            });
          }),
      );
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    enqueue(
      () =>
        new Promise((resolve) => {
          if (!port.isOpen) return resolve();
          port.write(buf);
          port.drain(() => {
            ack();
            resolve();
          });
        }),
    );
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // Whatever is still queued is flushed first: a client that closes right
    // after its last write still gets every byte to the board.
    queue = queue.then(
      () =>
        new Promise((resolve) => {
          if (!port.isOpen) return resolve();
          port.close(() => {
            console.log('[hw-ws-bridge] client disconnected; serial closed');
            resolve();
          });
        }),
    );
    released = queue;
  };
  ws.on('close', stop);
  ws.on('error', stop);
});
