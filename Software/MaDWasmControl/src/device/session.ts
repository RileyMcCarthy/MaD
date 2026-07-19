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
        new Worker(new URL('./DeviceSession.worker.ts', import.meta.url), {
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
        if (lost && lost === this.port) void this.releasePort();
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
    this.fanout(workerCrashEvents(message));
    void this.releasePort();
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
      void this.releasePort();
    }
    for (const sink of this.listeners) sink(events);
  };

  private async releasePort(): Promise<void> {
    const port = this.port;
    this.port = null;
    if (!port) return;
    try {
      await port.close();
    } catch {
      /* already closed/lost; ignore */
    }
  }

  private async ensureSink(): Promise<void> {
    if (this.sinkInstalled) return;
    await this.remote.setEventSink(Comlink.proxy(this.fanout));
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

  async connect(
    port: SerialPort,
    baudRate = DEFAULT_BAUD_RATE,
    opts: ConnectOptions = {},
  ): Promise<void> {
    // Start every connection from a fresh worker so each session gets a clean
    // WASM instance (a prior crash can't carry over) and no stale stream locks.
    this.recreateWorker();
    await this.ensureSink();
    await port.open({ baudRate });
    this.port = port;

    const { readable, writable } = port;
    if (!readable || !writable) {
      throw new Error('Serial port has no readable/writable stream');
    }
    // Hand the byte streams to the worker; it owns all I/O from here.
    await this.remote.connect(
      Comlink.transfer({ readable, writable }, [readable, writable]),
      opts,
    );
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
