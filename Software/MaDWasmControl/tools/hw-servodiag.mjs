/**
 * dev_servo hardware diagnosis: capture the P2 DEBUG serial (230400, programming
 * port) while commanding a small move over the protocol UART (2M), so we can see
 * what the firmware thinks happened — app_motion's move log + the [servo]
 * pos/vel/ferr/stall telemetry. Opening the debug port resets the P2 (DTR) — we
 * wait for boot, then command the move.
 *   MAD_DEBUG=/dev/cu.usbserial-PLX6ZJLYQ MAD_SERIAL=/dev/cu.usbserial-A5069RR4 node tools/hw-servodiag.mjs
 */
import { SerialPort } from 'serialport';
import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = await import('data:text/javascript,' + encodeURIComponent(
  esbuild.transformSync(readFileSync(new URL('../src/protocol/generated/protoemb.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' }).code));
function crc8(d) { let c = 0; for (let b of d) { for (let i = 0; i < 8; i++) { const m = (c ^ b) & 1; c >>= 1; if (m) c ^= 0x8c; b >>= 1; } } return c & 0xff; }

const dbg = new SerialPort({ path: process.env.MAD_DEBUG || '/dev/cu.usbserial-PLX6ZJLYQ', baudRate: 230400, autoOpen: false });
let dbgbuf = '';
dbg.on('data', (d) => { dbgbuf += d.toString('latin1'); });
await new Promise((res, rej) => dbg.open((e) => (e ? rej(e) : res())));
// DTR on the debug port holds the P2 in reset. Pulse it: assert (reset), then
// DEASSERT so the board actually runs, otherwise it sits stuck in reset.
await new Promise((r) => dbg.set({ dtr: true, rts: false }, () => r())); await sleep(150);
dbgbuf = '';
await new Promise((r) => dbg.set({ dtr: false, rts: false }, () => r()));
console.log('[diag] reset released; waiting for boot...');
await sleep(2500);

const proto = new SerialPort({ path: process.env.MAD_SERIAL || '/dev/cu.usbserial-A5069RR4', baudRate: 2000000, autoOpen: false });
await new Promise((res, rej) => proto.open((e) => (e ? rej(e) : res())));
const raw = (b) => new Promise((res, rej) => proto.write(b, (e) => (e ? rej(e) : res())));
const writeMsg = (cmd, p) => raw(Buffer.concat([Buffer.from([0x55, 0x01, cmd, p.length & 0xff, (p.length >> 8) & 0xff]), Buffer.from(p), Buffer.from([crc8(p)])]));

console.log('[diag] === boot debug ===');
console.log(dbgbuf.trim() || '(no boot output — check debug port/baud)');
dbgbuf = '';

console.log('\n[diag] enable motion + command +2mm @ 3mm/s (capped firmware); capturing ~1.5s...');
await writeMsg(C.MSG_WRITE_MOTION_ENABLE, [0x01]); await sleep(250);
await writeMsg(C.MSG_WRITE_MANUAL_MOVE, Buffer.from(C.encodeMove({ g: C.GCode.INCREMENTAL, x: 0, f: 0, p: 0 }))); await sleep(150);
await writeMsg(C.MSG_WRITE_MANUAL_MOVE, Buffer.from(C.encodeMove({ g: C.GCode.LINEAR_MOVE, x: 2, f: 3, p: 0 })));
await sleep(1500);
await writeMsg(C.MSG_WRITE_MOTION_ENABLE, [0x00]); await sleep(200);

console.log('\n[diag] ===== DEBUG SERIAL during the move =====');
console.log(dbgbuf.trim() || '(no debug output captured during move)');
await new Promise((r) => dbg.close(() => r()));
await new Promise((r) => proto.close(() => r()));
