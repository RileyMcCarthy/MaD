/**
 * Read the live MachineState (fault / restriction / motionEnabled) from the
 * board over the FT232R protocol UART, using the REAL generated packed codec
 * (transpiled on the fly with esbuild). No firmware rebuild needed.
 *
 *   MAD_SERIAL=/dev/cu.usbserial-A5069RR4 node tools/hw-state.mjs
 */
import { SerialPort } from 'serialport';
import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const DEV = process.env.MAD_SERIAL || '/dev/cu.usbserial-A5069RR4';
const BAUD = Number(process.env.MAD_BAUD || 2000000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transpile the generated TS codec → ESM and import it from a data: URL.
const ts = readFileSync(new URL('../src/protocol/generated/protoemb.ts', import.meta.url), 'utf8');
const js = esbuild.transformSync(ts, { loader: 'ts', format: 'esm' }).code;
const codec = await import('data:text/javascript,' + encodeURIComponent(js));

const CMD_STATE = codec.MSG_READ_STATE; // 1
const FAULT = ['NONE', 'COG', 'WATCHDOG', 'ESD_POWER', 'ESD_SWITCH', 'ESD_UPPER', 'ESD_LOWER',
  'SERVO_COMMUNICATION', 'FORCE_GAUGE_COMMUNICATION'];
const RESTRICT = ['NONE', 'SAMPLE_LENGTH', 'SAMPLE_TENSION', 'MACHINE_TENSION', 'UPPER_ENDSTOP',
  'LOWER_ENDSTOP', 'DOOR'];

const port = new SerialPort({ path: DEV, baudRate: BAUD, autoOpen: false });
const chunks = [];
port.on('data', (d) => chunks.push(d));
await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
const write = (b) => new Promise((res, rej) => port.write(b, (e) => (e ? rej(e) : res())));

let st = null;
for (let i = 0; i < 10 && !st; i++) {
  await write(Buffer.from([0x55, 0x00, CMD_STATE]));
  await sleep(250);
  const all = Buffer.concat(chunks);
  const needle = Buffer.from([0x55, 0x02, CMD_STATE, codec.MACHINESTATE_WIRE_SIZE, 0x00]);
  const idx = all.indexOf(needle);
  if (idx >= 0 && all.length >= idx + 5 + codec.MACHINESTATE_WIRE_SIZE) {
    const payload = all.subarray(idx + 5, idx + 5 + codec.MACHINESTATE_WIRE_SIZE);
    st = codec.decodeMachineState(new Uint8Array(payload));
  }
}

if (st) {
  console.log('[state] fault       :', FAULT[st.faultedReason] ?? st.faultedReason);
  console.log('[state] restriction :', RESTRICT[st.restrictedReason] ?? st.restrictedReason);
  console.log('[state] testRunning :', st.testRunning);
  console.log('[state] motionEnabled:', st.motionEnabled);
} else {
  console.log('[state] no response (RX bytes:', Buffer.concat(chunks).length, ')');
}
await new Promise((r) => port.close(() => r()));
