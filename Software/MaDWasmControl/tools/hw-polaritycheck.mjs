/**
 * Closed-loop encoder-polarity check on real hardware (dev_servo).
 * Enables motion, commands a small +2mm relative move at the capped speed, and
 * watches the encoder. AUTO-DISABLES if the encoder moves the WRONG way (which
 * means positive feedback → runaway). Run with maxVelocity capped low.
 *   MAD_SERIAL=/dev/cu.usbserial-A5069RR4 node tools/hw-polaritycheck.mjs
 */
import { SerialPort } from 'serialport';
import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const DEV = process.env.MAD_SERIAL || '/dev/cu.usbserial-A5069RR4';
const BAUD = Number(process.env.MAD_BAUD || 2000000);
const MOVE_MM = Number(process.env.MAD_MOVE_MM || 2);
const FEED = Number(process.env.MAD_FEED_MMPS || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = await import('data:text/javascript,' + encodeURIComponent(
  esbuild.transformSync(readFileSync(new URL('../src/protocol/generated/protoemb.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' }).code));

function crc8(d) { let c = 0; for (let b of d) { for (let i = 0; i < 8; i++) { const m = (c ^ b) & 1; c >>= 1; if (m) c ^= 0x8c; b >>= 1; } } return c & 0xff; }
const port = new SerialPort({ path: DEV, baudRate: BAUD, autoOpen: false });
let rx = Buffer.alloc(0);
port.on('data', (d) => { rx = Buffer.concat([rx, d]); });
await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
const raw = (b) => new Promise((res, rej) => port.write(b, (e) => (e ? rej(e) : res())));
const writeMsg = (cmd, p) => raw(Buffer.concat([Buffer.from([0x55, 0x01, cmd, p.length & 0xff, (p.length >> 8) & 0xff]), Buffer.from(p), Buffer.from([crc8(p)])]));
const readReq = (cmd) => raw(Buffer.from([0x55, 0x00, cmd]));
const lastData = (cmd, len) => { const n = Buffer.from([0x55, 0x02, cmd, len & 0xff, (len >> 8) & 0xff]); const i = rx.lastIndexOf(n); if (i < 0 || rx.length < i + 5 + len) return null; return rx.subarray(i + 5, i + 5 + len); };
async function readSample() { await readReq(C.MSG_READ_SAMPLE); await sleep(40); const p = lastData(C.MSG_READ_SAMPLE, C.SAMPLE_WIRE_SIZE); return p ? C.decodeSample(new Uint8Array(p)) : null; }
async function readState() { for (let i = 0; i < 8; i++) { rx = Buffer.alloc(0); await readReq(C.MSG_READ_STATE); await sleep(100); const p = lastData(C.MSG_READ_STATE, C.MACHINESTATE_WIRE_SIZE); if (p) return C.decodeMachineState(new Uint8Array(p)); } return null; }
async function disable(reason) { await writeMsg(C.MSG_WRITE_MOTION_ENABLE, [0x00]); await sleep(150); console.log(`\n>>> MOTION DISABLED (${reason})`); }

console.log(`[polarity] commanding +${MOVE_MM}mm @ ${FEED}mm/s; expect encoder to move + and settle. Wrong way => AUTO-DISABLE.`);
await writeMsg(C.MSG_WRITE_MOTION_ENABLE, [0x01]); await sleep(200);
let st = await readState();
console.log(`[polarity] enabled=${st?.motionEnabled} fault=${st?.faultedReason}`);
if (!st?.motionEnabled) { console.log('[polarity] motion did not enable; aborting'); await new Promise((r) => port.close(() => r())); process.exit(1); }

const base = (await readSample())?.machinePosition ?? 0;
console.log(`[polarity] baseline pos = ${base.toFixed(3)} mm`);
await writeMsg(C.MSG_WRITE_MANUAL_MOVE, Buffer.from(C.encodeMove({ g: C.GCode.INCREMENTAL, x: 0, f: 0, p: 0 }))); await sleep(120);
await writeMsg(C.MSG_WRITE_MANUAL_MOVE, Buffer.from(C.encodeMove({ g: C.GCode.LINEAR_MOVE, x: MOVE_MM, f: FEED, p: 0 }))); await sleep(120);

let verdict = 'inconclusive';
for (let t = 0; t < 30; t++) {
  const s = await readSample();
  const d = (s?.machinePosition ?? base) - base;
  console.log(`  t=${(t * 0.15).toFixed(2)}s  pos=${s?.machinePosition?.toFixed(3)}  delta=${d.toFixed(3)}mm`);
  if (d < -0.5) { verdict = 'WRONG'; await disable('encoder moved OPPOSITE to command — polarity inverted'); break; }
  if (d > MOVE_MM + 2) { verdict = 'RUNAWAY+'; await disable('overshot far past target — runaway'); break; }
  if (t > 6 && Math.abs(d - MOVE_MM) < 0.25) { verdict = 'CORRECT'; console.log(`\n>>> CORRECT polarity — encoder tracked to +${MOVE_MM}mm and settled`); break; }
  await sleep(110);
}
if (verdict === 'inconclusive') console.log('\n>>> inconclusive — check the trajectory above');
await disable('test complete');
await new Promise((r) => port.close(() => r()));
