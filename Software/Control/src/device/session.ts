/**
 * Main-thread device client.
 *
 * Owns the Web Serial `SerialPort` (opening requires a user gesture, so it must
 * live on the window) and a `DeviceSession` Web Worker. On connect it transfers
 * the port's readable/writable streams to the worker, which then performs all
 * byte I/O + protocol work off the main thread. The UI talks to this class;
 * everything below it is async over Comlink.
 */

import * as Comlink from 'comlink';
import type { DeviceSessionApi } from './DeviceSession.worker';
import {
  ConnectOptions,
  DeviceEvent,
  DeviceEventSink,
  DownloadResult,
  FileDownloadProgress,
  RunTestParams,
  RunTestResult,
} from './events';
import { MachineConfiguration, SampleData, SampleProfile } from '@/domain';
import { logger, ingestWorkerBatch } from '@/diagnostics/log';

// 2 Mbaud: the P2 protocol UART runs at this rate (perfect divisor match — P2
// 200MHz/100, FT232R 3MHz/1.5). The firmware's lock-free, continuous-poll
// receive keeps up at this rate; see HAL_serial.c / IO_fullDuplexSerial.c.
export const DEFAULT_BAUD_RATE = 2000000;

/** Events emitted when a device worker crashes (poisoned WASM / uncaught throw).
 *  Exported so unit tests lock the contract without spinning a real Worker. */
export function workerCrashEvents(message: string): DeviceEvent[] {
  return [
    { kind: 'error', message: `worker: ${message}` },
    { kind: 'disconnected', reason: `worker crashed: ${message}` },
  ];
}

/** How long a refused port close is retried before it is reported. */
const PORT_CLOSE_RETRY_MS = 1000;
const PORT_CLOSE_RETRY_INTERVAL_MS = 50;

/** The browser still holds the serial port after a disconnect. */
export class PortReleaseError extends Error {
  constructor(readonly detail: string) {
    super(
      'Disconnected, but the browser is still holding the serial port, so other programs ' +
        'cannot open it. Close this tab to release it.',
    );
    this.name = 'PortReleaseError';
  }
}

export type DeviceClientOptions = {
  /** Inject a Worker factory (tests). Default constructs the real session worker. */
  workerFactory?: () => Worker;
};

export class DeviceClient {
  private worker!: Worker;

  private remote!: Comlink.Remote<DeviceSessionApi>;

  private port: SerialPort | null = null;

  private listeners = new Set<DeviceEventSink>();

  private sinkInstalled = false;

  private readonly workerFactory: () => Worker;

  /** How many workers this client has constructed (fresh-on-connect / crash recovery). */
  workerCreateCount = 0;

  constructor(opts: DeviceClientOptions = {}) {
    this.workerFactory =
      opts.workerFactory ??
      (() =>
        new Worker(new URL('./deviceWorkerEntry.ts', import.meta.url), {
          type: 'module',
        }));
    this.createWorker();

    // The worker sees stream death (unplug, bridge loss) on its own; these
    // listeners keep the main-thread port handle honest and signal replug.
    const serial = typeof navigator !== 'undefined' ? navigator.serial : undefined;
    if (serial?.addEventListener) {
      serial.addEventListener('disconnect', (event: Event) => {
        const lost = (event.target ?? (event as Event & { port?: SerialPort }).port) as
          | SerialPort
          | undefined;
        // releasePort() logs a refused close itself; nothing here can act on
        // the rejection, so it must not escape as an unhandled rejection.
        if (lost && lost === this.port) this.releasePort().catch(() => undefined);
      });
      serial.addEventListener('connect', () => {
        this.fanout([{ kind: 'portAvailable' }]);
      });
    }
  }

  /** (Re)create the device worker and its Comlink proxy. A fresh worker gives a
   *  pristine WASM instance — so a Rust panic that poisoned a prior instance
   *  cannot carry into the next connection. */
  private createWorker(): void {
    this.worker = this.workerFactory();
    this.workerCreateCount += 1;
    this.remote = Comlink.wrap<DeviceSessionApi>(this.worker);
    this.sinkInstalled = false;
    // A top-level throw / unhandled rejection in the worker that escapes the
    // session's own handling (not just a Comlink call rejection) surfaces here.
    this.worker.onerror = (e: ErrorEvent) => this.onWorkerCrash(e.message || 'worker error');
    this.worker.onmessageerror = () => this.onWorkerCrash('worker message deserialization failed');
  }

  private onWorkerCrash(message: string): void {
    // The worker is gone, so its buffered entries died with it — this main-thread
    // entry is the only record that the crash happened at all.
    logger('device').error('worker-crash', message, {
      workerCreateCount: this.workerCreateCount,
    });
    this.fanout(workerCrashEvents(message));
    // Locked streams after a crash are exactly when the close keeps failing;
    // releasePort() logs that, and an escaping rejection would be reported as a
    // second crash on top of this one.
    this.releasePort().catch(() => undefined);
  }

  /** Test/diagnostic: fire the worker crash path as if the Worker emitted onerror. */
  simulateWorkerCrash(message: string): void {
    this.onWorkerCrash(message);
  }

  /** Test/diagnostic: force a fresh worker the same way connect() does. */
  forceRecreateWorker(): void {
    this.recreateWorker();
  }

  /** Subscribe to decoded device events. Returns an unsubscribe function. */
  subscribe(sink: DeviceEventSink): () => void {
    this.listeners.add(sink);
    return () => this.listeners.delete(sink);
  }

  private fanout = (events: DeviceEvent[]): void => {
    // On an unexpected loss reported by the worker, drop our port handle so
    // isConnected() is accurate and the OS handle is freed for reconnects.
    if (events.some((e) => e.kind === 'disconnected' && e.reason !== undefined)) {
      // A failure is already logged, and the handle kept so the next connect
      // or disconnect tries again; nobody is waiting on this to throw to.
      this.releasePort().catch(() => undefined);
    }
    for (const sink of this.listeners) sink(events);
  };

  /**
   * Close the port, so the browser hands the OS handle back.
   *
   * The browser refuses to close a port while its streams are locked, and the
   * worker's locks on the transferred streams clear asynchronously after its
   * teardown, so a refusal is retried for a short while. A port that still
   * cannot be closed is kept (it IS still held: a later connect or disconnect
   * retries) and reported, since the only remedy left is closing the tab.
   */
  private async releasePort(): Promise<void> {
    const port = this.port;
    if (!port) return;
    const deadline = Date.now() + PORT_CLOSE_RETRY_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        await port.close();
        if (this.port === port) this.port = null;
        if (attempt > 1) logger('device').info('port-closed', 'serial port closed', { attempt });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Lost with the device (unplugged): there is nothing left to release.
        if (!port.readable && !port.writable) {
          if (this.port === port) this.port = null;
          return;
        }
        if (Date.now() >= deadline) {
          logger('device').error('port-close-failed', message, { attempt });
          throw new PortReleaseError(message);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, PORT_CLOSE_RETRY_INTERVAL_MS));
    }
  }

  private async ensureSink(): Promise<void> {
    if (this.sinkInstalled) return;
    await this.remote.setEventSink(Comlink.proxy(this.fanout));
    // Fold the worker's log into this thread's ring so a snapshot is one merged
    // main+worker timeline rather than two halves nobody can interleave.
    await this.remote.setLogSink(Comlink.proxy(ingestWorkerBatch));
    this.sinkInstalled = true;
  }

  /** Prompt the user to pick a serial port (must be called from a user gesture). */
  async requestPort(): Promise<SerialPort> {
    return navigator.serial.requestPort();
  }

  /** Ports the user has already granted access to. */
  async getPorts(): Promise<SerialPort[]> {
    return navigator.serial.getPorts();
  }

  isConnected(): boolean {
    return this.port !== null;
  }

  /** The port this session has open, if any. */
  heldPort(): SerialPort | null {
    return this.port;
  }

  async connect(
    port: SerialPort,
    baudRate = DEFAULT_BAUD_RATE,
    opts: ConnectOptions = {},
  ): Promise<void> {
    // A port this session still holds (a lost link, a handshake that failed
    // after the port opened) is closed first: the browser refuses to open a
    // port twice, and the user would be stuck until a reload.
    if (this.port !== null) await this.disconnect();
    // Start every connection from a fresh worker so each session gets a clean
    // WASM instance (a prior crash can't carry over) and no stale stream locks.
    this.recreateWorker();
    await this.ensureSink();
    // USB identity before we open: 2 Mbaud only works because the FT232R's
    // divisor happens to land exactly on the P2's rate. A user on a different
    // bridge chip (CH340, CP2102) is a materially different machine, and that is
    // invisible in a bug report unless it is captured here.
    const info = port.getInfo?.() ?? {};
    logger('device').info('port-open', 'opening serial port', {
      baudRate,
      usbVendorId: info.usbVendorId ?? null,
      usbProductId: info.usbProductId ?? null,
    });
    try {
      await port.open({ baudRate });
    } catch (err) {
      logger('device').error('port-open-failed', err instanceof Error ? err.message : String(err), {
        baudRate,
      });
      throw err;
    }
    this.port = port;

    try {
      const { readable, writable } = port;
      if (!readable || !writable) {
        throw new Error('Serial port has no readable/writable stream');
      }
      // Hand the byte streams to the worker; it owns all I/O from here.
      await this.remote.connect(
        Comlink.transfer({ readable, writable }, [readable, writable]),
        opts,
      );
    } catch (err) {
      // The port is open but no session uses it; close it so a retry can open it.
      // A refused close is logged by releasePort() and must not replace the
      // handshake error, which is what the user needs to see.
      await this.releasePort().catch(() => undefined);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.remote.disconnect();
    } finally {
      await this.releasePort();
    }
  }

  private recreateWorker(): void {
    try {
      this.worker.terminate();
    } catch {
      /* already gone */
    }
    this.createWorker();
  }

  // ── Operations (delegated to the worker) ──

  getStoredSamples(): Promise<SampleData[]> {
    return this.remote.getStoredSamples();
  }

  /** Raw serial tail from the worker's byte ring, for the bug-report bundle. */
  getByteTail(): Promise<Awaited<ReturnType<DeviceSessionApi['getByteTail']>>> {
    return this.remote.getByteTail();
  }

  getDiagnostics(): Promise<Record<string, number | string | boolean>> {
    return this.remote.getDiagnostics();
  }

  readMachineConfiguration(): Promise<MachineConfiguration> {
    return this.remote.readMachineConfiguration();
  }

  writeMachineConfiguration(config: MachineConfiguration): Promise<boolean> {
    return this.remote.writeMachineConfiguration(config);
  }

  readSampleProfile(): Promise<SampleProfile> {
    return this.remote.readSampleProfile();
  }

  writeSampleProfile(profile: SampleProfile): Promise<boolean> {
    return this.remote.writeSampleProfile(profile);
  }

  readFirmwareVersion(): Promise<string> {
    return this.remote.readFirmwareVersion();
  }

  setMotionEnabled(enabled: boolean): Promise<boolean> {
    return this.remote.setMotionEnabled(enabled);
  }

  /** Disable motion immediately, preempting any queued upload/download. */
  emergencyStop(): Promise<boolean> {
    return this.remote.emergencyStop();
  }

  manualMove(mm: number, speed: number): Promise<boolean> {
    return this.remote.manualMove(mm, speed);
  }

  homeAxis(): Promise<void> {
    return this.remote.homeAxis();
  }

  zeroForce(): Promise<void> {
    return this.remote.zeroForce();
  }

  zeroLength(): Promise<void> {
    return this.remote.zeroLength();
  }

  runTest(params: RunTestParams): Promise<RunTestResult> {
    return this.remote.runTest(params);
  }

  streamGcode(gcode: string): Promise<{ success: boolean; error?: string }> {
    return this.remote.streamGcode(gcode);
  }

  downloadTestFile(
    testName: string,
    onProgress?: (p: FileDownloadProgress) => void,
  ): Promise<DownloadResult> {
    return this.remote.downloadTestFile(
      testName,
      onProgress ? Comlink.proxy(onProgress) : undefined,
    );
  }
}

/** Singleton device client for the app. */
export const deviceClient = new DeviceClient();
