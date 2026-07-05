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
 * Defaults target the protocol UART: the FT232R wired to the P2's P53/P55 at
 * 230400. (The onboard P2-EVAL UART is the debug/printf port at P62/P63.)
 * Opening this port does NOT reset the board — reset is wired only to the
 * onboard UART's DTR — so the firmware keeps running across connect/disconnect.
 */
import { WebSocketServer } from 'ws';
import { SerialPort } from 'serialport';

const DEV = process.env.MAD_SERIAL || '/dev/cu.usbserial-A5069RR4';
const BAUD = Number(process.env.MAD_BAUD || 2000000);
const PORT = Number(process.env.PORT || 9999);

const wss = new WebSocketServer({ port: PORT });
console.log(`[hw-ws-bridge] listening on ws://localhost:${PORT}, SERIAL=${DEV} @ ${BAUD}`);

wss.on('connection', (ws) => {
  console.log('[hw-ws-bridge] client connected; opening serial…');
  const port = new SerialPort({ path: DEV, baudRate: BAUD, autoOpen: false });

  port.open((err) => {
    if (err) {
      console.error(`[hw-ws-bridge] failed to open ${DEV}:`, err.message);
      ws.close();
      return;
    }
  });

  // serial → browser
  port.on('data', (d) => {
    if (ws.readyState === ws.OPEN) ws.send(d);
  });
  port.on('error', (e) => {
    console.error('[hw-ws-bridge] serial error:', e.message);
    try { ws.close(); } catch { /* ignore */ }
  });

  // browser → serial
  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (port.isOpen) port.write(buf);
  });

  const stop = () => {
    if (port.isOpen) port.close(() => {});
    console.log('[hw-ws-bridge] client disconnected; serial closed');
  };
  ws.on('close', stop);
  ws.on('error', stop);
});
