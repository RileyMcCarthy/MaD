/**
 * Drive a motion test on real hardware over the FT232R protocol UART using the
 * REAL generated packed codec (transpiled with esbuild). Enables motion, jogs
 * the gantry, and polls the live Sample stream so you can watch the commanded
 * setpoint advance (open-loop — works with the stepper/encoder disconnected).
 *
 *   MAD_SERIAL=/dev/cu.usbserial-A5069RR4 node tools/hw-motion.mjs
 *   MAD_JOG_MM=10 MAD_FEED_MMPS=2 node tools/hw-motion.mjs
 */
import { SerialPort } from 'serialport';
import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const DEV = process.env.MAD_SERIAL || '/dev/cu.usbserial-A5069RR4';
const BAUD = Number(process.env.MAD_BAUD || 2000000);
const JOG_MM = Number(process.env.MAD_JOG_MM || 10);
const FEED = Number(process.env.MAD_FEED_MMPS || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ts = readFileSync(new URL('../src/protocol/generated/protoemb.ts', import.meta.url), 'utf8');
const js = esbuild.transformSync(ts, { loader: 'ts', format: 'esm' }).code;
const C = await import('data:text/javascript,' + encodeURIComponent(js));

const FAULT = ['NONE', 'COG', 'WATCHDOG', 'ESD_POWER', 'ESD_SWITCH', 'ESD_UPPER', 'ESD_LOWER',
  'SERVO_COMMUNICATION', 'FORCE_GAUGE_COMMUNICATION'];

function crc8(d) { let c = 0; for (let b of d) { for (let i = 0; i < 8; i++) { const m = (c ^ b) & 1; c >>= 1; if (m) c ^= 0x8c; b >>= 1; } } return c & 0xff; }

const port = new SerialPort({ path: DEV, baudRate: BAUD, autoOpen: false });
let rx = Buffer.alloc(0);
port.on('data', (d) => { rx = Buffer.concat([rx, d]); });
await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
const raw = (b) => new Promise((res, rej) => port.write(b, (e) => (e ? rej(e) : res())));

const TYPE_READ = 0x00, TYPE_WRITE = 0x01, TYPE_DATA = 0x02;
const readReq = (cmd) => raw(Buffer.from([0x55, TYPE_READ, cmd]));
const writeMsg = (cmd, payload) => raw(Buffer.concat([
  Buffer.from([0x55, TYPE_WRITE, cmd, payload.length & 0xff, (payload.length >> 8) & 0xff]),
  Buffer.from(payload), Buffer.from([crc8(payload)])]));
// latest DATA frame for cmd with payload length len
const lastData = (cmd, len) => {
  const needle = Buffer.from([0x55, TYPE_DATA, cmd, len & 0xff, (len >> 8) & 0xff]);
  const i = rx.lastIndexOf(needle);
  if (i < 0 || rx.length < i + 5 + len) return null;
  return rx.subarray(i + 5, i + 5 + len);
};
const sawAck = (cmd) => rx.includes(Buffer.from([0x55, TYPE_WRITE, cmd]));

async function readState() {
  for (let i = 0; i < 8; i++) {
    await readReq(C.MSG_READ_STATE); await sleep(120);
    const p = lastData(C.MSG_READ_STATE, C.MACHINESTATE_WIRE_SIZE);
    if (p) return C.decodeMachineState(new Uint8Array(p));
  }
  return null;
}
async function readSample() {
  await readReq(C.MSG_READ_SAMPLE); await sleep(60);
  const p = lastData(C.MSG_READ_SAMPLE, C.SAMPLE_WIRE_SIZE);
  return p ? C.decodeSample(new Uint8Array(p)) : null;
}
const fmt = (s) => s == null ? '(no sample)'
  : `setpoint=${s.machineSetpoint} pos=${s.machinePosition} force=${s.machineForce}`;

async function jog(label, gMove) {
  console.log(`\n[motion] ${label}`);
  rx = Buffer.alloc(0);
  await writeMsg(C.MSG_WRITE_MANUAL_MOVE, C.encodeMove(gMove));
  await sleep(150);
  console.log(`         manual_move ${sawAck(C.MSG_WRITE_MANUAL_MOVE) ? 'ACK' : 'no-ACK'}`);
  for (let t = 0; t < 14; t++) { console.log(`         t=${(t * 0.3).toFixed(1)}s  ${fmt(await readSample())}`); await sleep(240); }
}

console.log(`[motion] open ${DEV} @ ${BAUD}`);
console.log('[motion] state BEFORE:', JSON.stringify(await readState()));

rx = Buffer.alloc(0);
await writeMsg(C.MSG_WRITE_MOTION_ENABLE, [0x01]);
await sleep(200);
console.log('[motion] motion_enable:', sawAck(C.MSG_WRITE_MOTION_ENABLE) ? 'ACK' : 'no-ACK');

const st = await readState();
console.log('[motion] state AFTER enable:', JSON.stringify(st), '-> fault', FAULT[st?.faultedReason]);

if (st && st.motionEnabled) {
  await writeMsg(C.MSG_WRITE_MANUAL_MOVE, C.encodeMove({ g: C.GCode.INCREMENTAL, x: 0, f: 0, p: 0 })); // relative mode
  await sleep(150);
  await jog(`jog +${JOG_MM}mm @ ${FEED}mm/s`, { g: C.GCode.LINEAR_MOVE, x: JOG_MM, f: FEED, p: 0 });
  await jog(`jog -${JOG_MM}mm @ ${FEED}mm/s`, { g: C.GCode.LINEAR_MOVE, x: -JOG_MM, f: FEED, p: 0 });
} else {
  console.log('[motion] motion NOT enabled — aborting jog');
}

rx = Buffer.alloc(0);
await writeMsg(C.MSG_WRITE_MOTION_ENABLE, [0x00]);
await sleep(150);
console.log('\n[motion] motion disabled:', sawAck(C.MSG_WRITE_MOTION_ENABLE) ? 'ACK' : 'no-ACK');
await new Promise((r) => port.close(() => r()));
