/** Hard-disable motion (stop the motor). MAD_SERIAL=... node tools/hw-disable.mjs */
import { SerialPort } from 'serialport';
import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = await import('data:text/javascript,' + encodeURIComponent(
  esbuild.transformSync(readFileSync(new URL('../src/protocol/generated/protoemb.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' }).code));
function crc8(d) { let c = 0; for (let b of d) { for (let i = 0; i < 8; i++) { const m = (c ^ b) & 1; c >>= 1; if (m) c ^= 0x8c; b >>= 1; } } return c & 0xff; }
const port = new SerialPort({ path: process.env.MAD_SERIAL || '/dev/cu.usbserial-A5069RR4', baudRate: 2000000, autoOpen: false });
let rx = Buffer.alloc(0);
port.on('data', (d) => { rx = Buffer.concat([rx, d]); });
await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
const raw = (b) => new Promise((res, rej) => port.write(b, (e) => (e ? rej(e) : res())));
const writeMsg = (cmd, p) => raw(Buffer.concat([Buffer.from([0x55, 0x01, cmd, p.length & 0xff, (p.length >> 8) & 0xff]), Buffer.from(p), Buffer.from([crc8(p)])]));
const readReq = (cmd) => raw(Buffer.from([0x55, 0x00, cmd]));
const lastData = (cmd, len) => { const n = Buffer.from([0x55, 0x02, cmd, len & 0xff, (len >> 8) & 0xff]); const i = rx.lastIndexOf(n); if (i < 0 || rx.length < i + 5 + len) return null; return rx.subarray(i + 5, i + 5 + len); };
for (let i = 0; i < 8; i++) { await writeMsg(C.MSG_WRITE_MOTION_ENABLE, [0x00]); await sleep(80); }
await sleep(200);
rx = Buffer.alloc(0); await readReq(C.MSG_READ_STATE); await sleep(150);
const p = lastData(C.MSG_READ_STATE, C.MACHINESTATE_WIRE_SIZE);
const st = p ? C.decodeMachineState(new Uint8Array(p)) : null;
console.log('>>> motionEnabled now:', st?.motionEnabled, ' fault:', st?.faultedReason);
await new Promise((r) => port.close(() => r()));
