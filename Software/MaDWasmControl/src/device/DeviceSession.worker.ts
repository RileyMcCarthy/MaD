/**
 * Device session worker.
 *
 * Runs in a dedicated Web Worker and owns ALL device I/O + protocol state:
 *   - the WebAssembly protocol client (framing, CRC, queue, ring buffers, timeouts)
 *   - the Web Serial read loop (transferred `ReadableStream` → `feed_bytes`)
 *   - the poll loop (`poll()` → decode → emit events; drain `take_outgoing()` → write)
 *
 * The main thread opens the port (user gesture) and transfers its readable/
 * writable streams here, then drives high-level operations over Comlink.
 */

import * as Comlink from 'comlink';
import init, { WasmClient } from '@/wasm/protoemb_runtime.js';
import wasmUrl from '@/wasm/protoemb_runtime_bg.wasm?url';
import {
  decodeSample,
  decodeMachineState,
  decodeMachineConfiguration,
  decodeSampleProfile,
  decodeFirmwareVersion,
  decodeNotification,
  encodeMachineConfiguration,
  encodeSampleProfile,
  encodeTestRun,
  GCode,
  Move as ProtoMove,
  MSG_READ_SAMPLE,
  MSG_READ_STATE,
  MSG_READ_MACHINE_CONFIGURATION,
  MSG_READ_FIRMWARE_VERSION,
  MSG_READ_SAMPLE_PROFILE,
  MSG_WRITE_MACHINE_CONFIGURATION_WRITE,
  MSG_WRITE_MOTION_ENABLE,
  MSG_WRITE_TEST_RUN,
  MSG_WRITE_MANUAL_MOVE,
  MSG_WRITE_TEST_MOVE,
  MSG_WRITE_TEST_WAVEFORM,
  MSG_WRITE_SAMPLE_PROFILE_WRITE,
  MSG_WRITE_GAUGE_LENGTH,
  MSG_WRITE_GAUGE_FORCE,
  MSG_WRITE_FILE_DOWNLOAD,
  MSG_SAMPLE_PERIOD_MS,
  MSG_STATE_PERIOD_MS,
  STOREDSAMPLE_WIRE_SIZE,
} from '@/protocol/generated/protoemb';
import {
  MachineConfiguration,
  SampleProfile,
  SampleData,
  configToShared,
  configFromShared,
  sampleToShared,
  stateToShared,
  sampleProfileToShared,
  sampleProfileFromShared,
  notificationToShared,
  resolveGaugeLengthMm,
  gcodeLinesToProgram,
  type ProgramOp,
  batchMoveBuffers,
  decodeBinarySampleDataToCSV,
  validateAndEncodeMove,
  BATCH_MOVE_COUNT,
} from '@/domain';
import {
  ConnectOptions,
  DeviceEvent,
  DeviceEventSink,
  DownloadResult,
  FileDownloadProgress,
  PortStreams,
  RunTestParams,
  RunTestResult,
} from './events';

/** Poll cadence (ms). Faster than the sample period so reads/writes drain promptly. */
const TICK_MS = 4;
/** ~1 minute of samples retained in the WASM ring buffer. */
const SAMPLE_STORAGE_COUNT = Math.max(1, Math.ceil(60_000 / MSG_SAMPLE_PERIOD_MS));
const STATE_STORAGE_COUNT = 10;

const wasmReady = init({ module_or_path: wasmUrl });

interface Waiter {
  match: (e: DeviceEvent) => boolean;
  resolve: (e: DeviceEvent) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Protocol command this waiter expects, so a Rust-side timeout for the same
   *  command can reject it immediately (JS and Rust timeouts then agree). */
  command: number;
}

/** Raw event shape from `WasmClient.poll()` (serde-tagged). */
interface RawEvent {
  event: 'ack' | 'nack' | 'data' | 'notification' | 'timeout' | 'error';
  command?: number;
  payload?: number[] | Uint8Array;
  message?: string;
  /** Present on `timeout`: the framed bytes that timed out (frame[2] = command). */
  frame?: number[] | Uint8Array;
}

function asciiBytes(value: string, length: number): Uint8Array {
  const buf = new Uint8Array(length);
  for (let i = 0; i < Math.min(value.length, length); i++) {
    buf[i] = value.charCodeAt(i) & 0x7f;
  }
  return buf;
}

class DeviceSession {
  private client?: WasmClient;

  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  private running = false;

  private shuttingDown = false;

  /** Set by emergencyStop(); long-running upload/download loops check it and
   *  bail so a STOP isn't stuck behind a multi-batch transfer. Reset at the
   *  start of each such operation (and on connect). */
  private aborting = false;

  private sink: DeviceEventSink | null = null;

  private waiters: Waiter[] = [];

  private writeChain: Promise<void> = Promise.resolve();

  /** Serializes on-demand request/response operations so only ONE is in flight,
   *  matching the single-in-flight Rust client. Removes response cross-matching
   *  (responses are command-correlated and there is at most one waiter per
   *  command). Periodic sample/state reads are Rust-driven and don't use this. */
  private opChain: Promise<unknown> = Promise.resolve();

  private lastSample: SampleData | null = null;

  /** Lightweight throughput/error counters for the diagnostics bundle. */
  private stats = {
    connectedAt: 0,
    bytesIn: 0,
    bytesOut: 0,
    events: 0,
    errors: 0,
    timeouts: 0,
    nacks: 0,
    lastError: '',
    lastErrorAt: 0,
  };

  /** Register the main-thread event callback (Comlink proxy). */
  setEventSink(sink: DeviceEventSink): void {
    this.sink = sink;
  }

  async connect(streams: PortStreams, opts: ConnectOptions = {}): Promise<void> {
    await wasmReady;
    this.client = new WasmClient(opts.responseTimeoutMs ?? 2000);
    this.reader = streams.readable.getReader();
    this.writer = streams.writable.getWriter();
    this.running = true;
    this.aborting = false;
    this.lastSample = null;
    this.stats = {
      connectedAt: Date.now(),
      bytesIn: 0,
      bytesOut: 0,
      events: 0,
      errors: 0,
      timeouts: 0,
      nacks: 0,
      lastError: '',
      lastErrorAt: 0,
    };

    this.client.register_periodic(MSG_READ_SAMPLE, MSG_SAMPLE_PERIOD_MS, SAMPLE_STORAGE_COUNT);
    this.client.register_periodic(MSG_READ_STATE, MSG_STATE_PERIOD_MS, STATE_STORAGE_COUNT);

    void this.pumpRead();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.emit([{ kind: 'connected' }]);
  }

  async disconnect(): Promise<void> {
    await this.shutdown();
  }

  /**
   * Emergency stop: disable all machine motion as fast as the link allows.
   *
   * The firmware treats MOTION_ENABLE=false as an immediate stop (clears the
   * motion queue, stops the stepper, ends any running test). Because the
   * protocol is single-in-flight, we (1) set the abort flag so upload/download
   * loops stop feeding new batches, (2) drop everything already queued
   * (`clear_queue`) so the motion-disable isn't stuck behind a backlog, (3)
   * reject in-flight waiters so the UI unwinds promptly, then (4) command motion
   * off. This is a *software* control stop, not a safety-rated E-stop — the only
   * defence against a frozen host is a firmware host-link watchdog (not present).
   */
  async emergencyStop(): Promise<boolean> {
    this.aborting = true;
    try {
      this.client?.clear_queue();
    } catch {
      /* ignore */
    }
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error('aborted: emergency stop'));
    }
    if (!this.client) return false;
    return this.writeAndAck(MSG_WRITE_MOTION_ENABLE, new Uint8Array([0]), 3000);
  }

  /**
   * Tear the session down and emit `disconnected`. With a `reason` this is an
   * unexpected loss (unplug / stream death) — the streams are likely already
   * dead, so every close step is best-effort.
   */
  private async shutdown(reason?: string): Promise<void> {
    if (this.shuttingDown || (!this.running && !this.client)) return;
    this.shuttingDown = true;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Snapshot then immediately null the live handles so a late tick / queued
    // write observes a torn-down session and can't touch a half-closed stream.
    const reader = this.reader;
    const writer = this.writer;
    const writeChain = this.writeChain;
    this.reader = null;
    this.writer = null;
    this.client = undefined;
    this.writeChain = Promise.resolve();
    // Reject any in-flight waiters.
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error(reason ?? 'disconnected'));
    }
    // Best-effort close. A half-dead stream (USB unplug) can make cancel/close
    // hang, so cap the whole teardown so disconnect always completes.
    await withTimeout(
      (async () => {
        try {
          await reader?.cancel();
        } catch {
          /* ignore */
        }
        try {
          reader?.releaseLock();
        } catch {
          /* ignore */
        }
        try {
          await writeChain;
        } catch {
          /* ignore */
        }
        try {
          await writer?.close();
        } catch {
          /* ignore */
        }
        try {
          writer?.releaseLock();
        } catch {
          /* ignore */
        }
      })(),
      1500,
    );
    this.shuttingDown = false;
    this.emit([{ kind: 'disconnected', reason }]);
  }

  /**
   * Decoded samples currently held in the WASM ring buffer (oldest → newest).
   * Used to seed charts that mount after samples started flowing.
   */
  /** Throughput/error counters for the diagnostics bundle. */
  getDiagnostics(): Record<string, number | string | boolean> {
    return {
      ...this.stats,
      uptimeMs: this.stats.connectedAt ? Date.now() - this.stats.connectedAt : 0,
      running: this.running,
    };
  }

  getStoredSamples(): SampleData[] {
    if (!this.client) return [];
    try {
      const batch = this.client.get_stored(MSG_READ_SAMPLE) as {
        entries: Array<number[] | Uint8Array>;
      };
      return batch.entries.map((e) =>
        sampleToShared(decodeSample(e instanceof Uint8Array ? e : Uint8Array.from(e))),
      );
    } catch {
      return [];
    }
  }

  // ── High-level reads (request → decoded response) ──

  async readMachineConfiguration(): Promise<MachineConfiguration> {
    return this.runOp(async () => {
      const p = this.waitFor((e) => e.kind === 'configuration', 3000, 'configuration', MSG_READ_MACHINE_CONFIGURATION);
      this.client?.read(MSG_READ_MACHINE_CONFIGURATION, true, undefined);
      const e = await p;
      return (e as Extract<DeviceEvent, { kind: 'configuration' }>).data;
    });
  }

  async readSampleProfile(): Promise<SampleProfile> {
    return this.runOp(async () => {
      const p = this.waitFor((e) => e.kind === 'sampleProfile', 3000, 'sampleProfile', MSG_READ_SAMPLE_PROFILE);
      this.client?.read(MSG_READ_SAMPLE_PROFILE, true, undefined);
      const e = await p;
      return (e as Extract<DeviceEvent, { kind: 'sampleProfile' }>).data;
    });
  }

  async readFirmwareVersion(): Promise<string> {
    return this.runOp(async () => {
      const p = this.waitFor((e) => e.kind === 'firmwareVersion', 3000, 'firmwareVersion', MSG_READ_FIRMWARE_VERSION);
      this.client?.read(MSG_READ_FIRMWARE_VERSION, true, undefined);
      const e = await p;
      return (e as Extract<DeviceEvent, { kind: 'firmwareVersion' }>).data.version;
    });
  }

  // ── High-level writes (command → ACK) ──

  async writeMachineConfiguration(config: MachineConfiguration): Promise<boolean> {
    const bytes = encodeMachineConfiguration(configFromShared(config));
    return this.runOp(() => this.writeAndAck(MSG_WRITE_MACHINE_CONFIGURATION_WRITE, bytes, 3000));
  }

  async writeSampleProfile(profile: SampleProfile): Promise<boolean> {
    const firmwareProfile: SampleProfile = {
      maxForce: Math.max(0, profile.maxForce ?? 0),
      maxVelocity: Math.max(0, Math.round(profile.maxVelocity ?? 0)),
      maxDisplacement: Math.max(0, Math.round(profile.maxDisplacement ?? 0)),
      sampleWidth: Math.max(0, Math.round(profile.sampleWidth ?? 0)),
      sampleThickness: Math.max(0, Math.round(profile.sampleThickness ?? 0)),
      serial: profile.serial ?? '',
    };
    const bytes = encodeSampleProfile(sampleProfileFromShared(firmwareProfile));
    return this.runOp(() => this.writeAndAck(MSG_WRITE_SAMPLE_PROFILE_WRITE, bytes, 2000));
  }

  async setMotionEnabled(enabled: boolean): Promise<boolean> {
    return this.runOp(() =>
      this.writeAndAck(MSG_WRITE_MOTION_ENABLE, new Uint8Array([enabled ? 1 : 0]), 2000),
    );
  }

  async manualMove(mm: number, speed: number): Promise<boolean> {
    // G91 (relative) then a relative G0 — wait for each ACK so the pair cannot reorder.
    const moves: ProtoMove[] = [
      { g: 91 as GCode, x: 0, f: 0, p: 0 },
      { g: 0 as GCode, x: mm, f: speed, p: 0 },
    ];
    return this.runOp(async () => {
      for (const move of moves) {
        let buf: Uint8Array;
        try {
          buf = validateAndEncodeMove(move);
        } catch (err) {
          // Reject an out-of-range/NaN jog rather than wrap it into real motion.
          this.emit([{ kind: 'error', message: err instanceof Error ? err.message : String(err) }]);
          return false;
        }
        const ok = await this.writeAndAck(MSG_WRITE_MANUAL_MOVE, buf, 5000);
        if (!ok) return false;
      }
      return true;
    });
  }

  homeAxis(): void {
    this.client?.write(MSG_WRITE_MANUAL_MOVE, validateAndEncodeMove({ g: 28 as GCode, x: 0, f: 0, p: 0 }));
  }

  zeroForce(): void {
    this.client?.write(MSG_WRITE_GAUGE_FORCE, new Uint8Array(0));
  }

  zeroLength(): void {
    this.client?.write(MSG_WRITE_GAUGE_LENGTH, new Uint8Array(0));
  }

  // ── Test run: upload binary moves, then start ──

  /**
   * Upload an ordered program: consecutive moves are batched into `test_move`
   * frames; each waveform is sent as a `test_waveform` frame. Order is preserved
   * so the firmware appends records to the SD program in sequence.
   */
  private async uploadProgram(ops: ProgramOp[]): Promise<void> {
    let pending: Uint8Array[] = [];
    const flushMoves = async () => {
      for (const batch of batchMoveBuffers(pending, BATCH_MOVE_COUNT)) {
        if (this.aborting) throw new Error('aborted by emergency stop');
        await this.uploadWithRetry(MSG_WRITE_TEST_MOVE, batch, 3);
      }
      pending = [];
    };
    for (const op of ops) {
      if (op.kind === 'move') {
        pending.push(op.buf);
      } else {
        await flushMoves(); // preserve program order before the waveform
        if (this.aborting) throw new Error('aborted by emergency stop');
        await this.uploadWithRetry(MSG_WRITE_TEST_WAVEFORM, op.buf, 3);
      }
    }
    await flushMoves();
  }

  async runTest(params: RunTestParams): Promise<RunTestResult> {
    const { gcode, gcodeId, testDataId, gaugeLengthMm } = params;
    const openId = asciiBytes(gcodeId.slice(0, 6), 6);
    return this.runOp(async () => {
      this.aborting = false;
      try {
        // 1. Open the gcode file on the SD card (6-byte ASCII id via TEST_MOVE;
        //    a non-7-multiple payload is an OPEN, which truncates/creates fresh).
        await this.writeAndAckOrThrow(MSG_WRITE_TEST_MOVE, openId, 5000);

        // 2. Convert + upload moves in batches with retry.
        const lines = gcode.filter((l) => {
          const t = l.trim();
          return t !== '' && !t.startsWith(';');
        });
        const gaugeMm = resolveGaugeLengthMm(gaugeLengthMm, this.lastSample);
        await this.uploadProgram(gcodeLinesToProgram(lines, gaugeMm));
        if (this.aborting) throw new Error('aborted by emergency stop');

        // 3. Start the test only after the COMPLETE program (incl. trailing G122)
        //    is uploaded. Build the payload via the generated codec, not by hand.
        const runBuf = encodeTestRun({ gcodeId: gcodeId.slice(0, 6), testDataId: testDataId.slice(0, 6) });
        await this.writeAndAckOrThrow(MSG_WRITE_TEST_RUN, runBuf, 5000);

        return { success: true, gcodeId, testDataId };
      } catch (err) {
        // Invalidate any partially-written SD file: re-opening for WRITE truncates
        // it (firmware "wb"), so a half-uploaded program can never later run to EOF
        // and report a false "complete". Best-effort.
        try {
          this.client?.write(MSG_WRITE_TEST_MOVE, openId);
        } catch {
          /* ignore */
        }
        return {
          success: false,
          gcodeId: '',
          testDataId: '',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
  }

  async streamGcode(gcode: string): Promise<{ success: boolean; error?: string }> {
    const lines = gcode.split('\n').filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith(';');
    });
    return this.runOp(async () => {
      this.aborting = false;
      try {
        const gaugeMm = resolveGaugeLengthMm(undefined, this.lastSample);
        await this.uploadProgram(gcodeLinesToProgram(lines, gaugeMm));
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  // ── Download test data from the SD card → CSV ──

  async downloadTestFile(
    testName: string,
    onProgress?: (p: FileDownloadProgress) => void,
  ): Promise<DownloadResult> {
    const SAMPLES_PER_REQUEST = 100;
    const MAX_NOT_READY_RETRIES = 80;
    const MAX_MID_RETRIES = 20;
    const NOT_READY_RETRY_DELAY_MS = 100;

    return this.runOp(async () => {
    this.aborting = false;
    try {
      const chunks: Uint8Array[] = [];
      let sampleIndex = 0;
      let downloadedBytes = 0;
      let done = false;

      while (!done) {
        if (this.aborting) throw new Error('aborted by emergency stop');
        const request = new Uint8Array(24);
        request.set(asciiBytes(testName, 16), 0);
        const view = new DataView(request.buffer);
        view.setUint32(16, sampleIndex, true);
        view.setUint32(20, SAMPLES_PER_REQUEST, true);

        let chunk: Uint8Array | null = null;
        let notReadyRetries = 0;

        while (chunk === null) {
           
          const next = await this.requestDownloadChunk(request, 10000);
          if (next.kind === 'nack') {
            // Retry a transient "not ready" / SD-BUSY NACK at ANY point, not only
            // on the first chunk, so a mid-stream BUSY (e.g. the SD card still
            // flushing right after a test) doesn't discard everything already
            // downloaded. The first chunk waits longer (file may not exist yet).
            const cap = sampleIndex === 0 ? MAX_NOT_READY_RETRIES : MAX_MID_RETRIES;
            if (notReadyRetries < cap) {
              notReadyRetries += 1;
               
              await delay(NOT_READY_RETRY_DELAY_MS);
              continue;
            }
            throw new Error('Test data not ready');
          }
          chunk = next.chunk;
        }

        if (chunk.length === 0) {
          done = true;
        } else {
          chunks.push(chunk);
          downloadedBytes += chunk.length;
          const received = Math.floor(chunk.length / STOREDSAMPLE_WIRE_SIZE);
          sampleIndex += received;
          onProgress?.({
            fileName: testName,
            bytesDownloaded: downloadedBytes,
            totalBytes: 0,
            status: 'downloading',
          });
          if (received < SAMPLES_PER_REQUEST) done = true;
        }
      }

      const binary = concatBytes(chunks);
      const csv = decodeBinarySampleDataToCSV(binary);
      onProgress?.({
        fileName: testName,
        bytesDownloaded: binary.length,
        totalBytes: binary.length,
        status: 'complete',
      });
      return { success: true, csv, sampleBytes: binary.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress?.({ fileName: testName, bytesDownloaded: 0, totalBytes: 0, status: 'error', error: message });
      return { success: false, error: message };
    }
    });
  }

  // ── Internals ──

  private tick(): void {
    if (!this.client) return;
    let raw: RawEvent[];
    try {
      raw = this.client.poll() as RawEvent[];
    } catch (err) {
      // A throw out of poll() means the WASM instance trapped (Rust panic) and is
      // now poisoned — every later call would throw too. Treat it as fatal: tear
      // down so the UI shows a disconnect + Reconnect (which spins up a fresh
      // worker/instance) instead of spinning a 4 ms error storm forever.
      this.emit([{ kind: 'error', message: `poll: ${String(err)}` }]);
      void this.shutdown(`protocol error: ${String(err)}`);
      return;
    }

    const events: DeviceEvent[] = [];
    for (const ev of raw) {
      // A Rust-side timeout carries the framed bytes that timed out (frame[2] =
      // command). Reject the matching JS waiter now so both timeouts agree and a
      // late response can't resolve a fresh same-command waiter.
      if (ev.event === 'timeout' && ev.frame && ev.frame.length > 2) {
        this.rejectWaitersForCommand(ev.frame[2], 'response timeout');
      }
      for (const mapped of this.mapEvent(ev)) {
        if (mapped.kind === 'sample') this.lastSample = mapped.data;
        events.push(mapped);
      }
    }

    for (const e of events) this.resolveWaiters(e);

    // Diagnostics counters (significant events only; samples aren't tallied here).
    this.stats.events += events.length;
    for (const e of events) {
      if (e.kind === 'error') {
        this.stats.errors += 1;
        this.stats.lastError = e.message;
        this.stats.lastErrorAt = Date.now();
      } else if (e.kind === 'timeout') {
        this.stats.timeouts += 1;
      } else if (e.kind === 'ack' && !e.success) {
        this.stats.nacks += 1;
      }
    }

    const out = this.client.take_outgoing();
    if (out.length > 0) {
      this.stats.bytesOut += out.length;
      this.enqueueWrite(out);
    }

    if (events.length > 0) this.emit(events);
  }

  private mapEvent(ev: RawEvent): DeviceEvent[] {
    switch (ev.event) {
      case 'ack':
        return [{ kind: 'ack', command: ev.command ?? -1, success: true }];
      case 'nack':
        return [{ kind: 'ack', command: ev.command ?? -1, success: false }];
      case 'notification':
        return [{ kind: 'notification', data: notificationToShared(decodeNotification(u8(ev.payload))) }];
      case 'timeout':
        return [{ kind: 'timeout' }];
      case 'error':
        return [{ kind: 'error', message: ev.message ?? 'unknown error' }];
      case 'data':
        return this.mapData(ev.command ?? -1, u8(ev.payload));
      default:
        return [];
    }
  }

  private mapData(command: number, payload: Uint8Array): DeviceEvent[] {
    switch (command) {
      case MSG_READ_SAMPLE:
        return [{ kind: 'sample', data: sampleToShared(decodeSample(payload)) }];
      case MSG_READ_STATE:
        return [{ kind: 'state', data: stateToShared(decodeMachineState(payload)) }];
      case MSG_READ_MACHINE_CONFIGURATION:
        return [{ kind: 'configuration', data: configToShared(decodeMachineConfiguration(payload)) }];
      case MSG_READ_FIRMWARE_VERSION:
        return [{ kind: 'firmwareVersion', data: decodeFirmwareVersion(payload) }];
      case MSG_READ_SAMPLE_PROFILE:
        return [{ kind: 'sampleProfile', data: sampleProfileToShared(decodeSampleProfile(payload)) }];
      default:
        return [{ kind: 'data', command, payload }];
    }
  }

  private emit(events: DeviceEvent[]): void {
    this.sink?.(events);
  }

  /** Serialize an on-demand operation so only one request/response is in flight. */
  private runOp<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private waitFor(
    match: (e: DeviceEvent) => boolean,
    timeoutMs: number,
    label: string,
    command: number,
  ): Promise<DeviceEvent> {
    return new Promise<DeviceEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push({ match, resolve, reject, timer, command });
    });
  }

  private resolveWaiters(e: DeviceEvent): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].match(e)) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(e);
      }
    }
  }

  /** Reject waiters whose command just timed out on the Rust side, so the JS and
   *  Rust timeouts agree and a late response can't resolve a fresh same-command
   *  waiter. Periodic (sample/state) timeouts carry their own command and so
   *  never match an on-demand waiter. */
  private rejectWaitersForCommand(command: number, reason: string): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].command === command) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.reject(new Error(reason));
      }
    }
  }

  private async writeAndAck(command: number, data: Uint8Array, timeoutMs: number): Promise<boolean> {
    const p = this.waitFor((e) => e.kind === 'ack' && e.command === command, timeoutMs, `ack(${command})`, command);
    this.client?.write(command, data);
    try {
      const e = (await p) as Extract<DeviceEvent, { kind: 'ack' }>;
      return e.success;
    } catch {
      return false;
    }
  }

  private async writeAndAckOrThrow(command: number, data: Uint8Array, timeoutMs: number): Promise<void> {
    const p = this.waitFor((e) => e.kind === 'ack' && e.command === command, timeoutMs, `ack(${command})`, command);
    this.client?.write(command, data);
    const e = (await p) as Extract<DeviceEvent, { kind: 'ack' }>;
    if (!e.success) throw new Error(`device NACKed command ${command}`);
  }

  private async uploadWithRetry(command: number, data: Uint8Array, maxRetries: number): Promise<void> {
    let attempt = 0;
    for (;;) {
      if (this.aborting) throw new Error('aborted by emergency stop');
      try {
         
        await this.writeAndAckOrThrow(command, data, 5000);
        return;
      } catch (err) {
        attempt += 1;
        if (attempt >= maxRetries) throw err;
         
        await delay(1000);
      }
    }
  }

  private requestDownloadChunk(
    request: Uint8Array,
    timeoutMs: number,
  ): Promise<{ kind: 'data'; chunk: Uint8Array } | { kind: 'nack' }> {
    const p = this.waitFor(
      (e) =>
        (e.kind === 'data' && e.command === MSG_WRITE_FILE_DOWNLOAD) ||
        (e.kind === 'ack' && e.command === MSG_WRITE_FILE_DOWNLOAD && !e.success),
      timeoutMs,
      'file-download',
      MSG_WRITE_FILE_DOWNLOAD,
    );
    this.client?.write(MSG_WRITE_FILE_DOWNLOAD, request);
    return p.then((e) =>
      e.kind === 'data'
        ? { kind: 'data' as const, chunk: e.payload }
        : { kind: 'nack' as const },
    );
  }

  private async pumpRead(): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    try {
      while (this.running) {
         
        const { value, done } = await reader.read();
        if (done) {
          // Stream closed under us (USB unplug, bridge gone) — treat as loss.
          if (this.running) void this.shutdown('serial stream closed');
          return;
        }
        if (value && this.client) {
          this.stats.bytesIn += value.length;
          this.client.feed_bytes(value);
        }
      }
    } catch (err) {
      if (this.running) {
        this.emit([{ kind: 'error', message: `read: ${String(err)}` }]);
        void this.shutdown(`read failed: ${String(err)}`);
      }
    }
  }

  private enqueueWrite(data: Uint8Array): void {
    const writer = this.writer;
    if (!writer || !this.running) return;
    this.writeChain = this.writeChain
      .then(() => writer.write(data))
      .catch((err) => {
        // A failed write means the link is gone — mirror the read path and tear
        // down (the old code kept ticking against a dead writer, expecting a
        // response that could never arrive).
        if (this.running) {
          this.emit([{ kind: 'error', message: `write: ${String(err)}` }]);
          void this.shutdown(`write failed: ${String(err)}`);
        }
      });
  }
}

/** Resolve when `p` settles or after `ms`, whichever comes first (never rejects). */
function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([
    p.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  ]);
}

function u8(payload?: number[] | Uint8Array): Uint8Array {
  if (!payload) return new Uint8Array(0);
  // serde_bytes makes the wasm hand back a Uint8Array directly (no per-element
  // copy); tolerate a plain number[] too (older build / non-serde_bytes path).
  return payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type DeviceSessionApi = DeviceSession;

Comlink.expose(new DeviceSession());
