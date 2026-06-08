/**
 * BridgeHandler — Electron ↔ Rust bridge communication layer.
 *
 * Spawns the `protoemb-bridge` binary as a child process and communicates
 * via newline-delimited JSON (NDJSON) on stdin/stdout.
 *
 * Responsibilities:
 * - Spawn/kill the Rust bridge process
 * - Send typed NDJSON requests to bridge stdin
 * - Parse NDJSON events from bridge stdout
 * - Emit typed events for DeviceInterface to consume
 * - Map generated protocol types → SharedInterface display types
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { app } from 'electron';
import { deviceLogger } from '@utils/logger';
import {
  SampleData,
  MachineState as SharedMachineState,
  MachineConfiguration as SharedMachineConfiguration,
  SampleProfile as SharedSampleProfile,
  FirmwareVersion as SharedFirmwareVersion,
  Notification as SharedNotification,
  NotificationType as SharedNotificationType,
  FaultedReason as SharedFaultedReason,
  RestrictedReason as SharedRestrictedReason,
} from '@shared/SharedInterface';
import {
  decodeSample,
  decodeMachineState,
  decodeMachineConfiguration,
  decodeSampleProfile,
  decodeFirmwareVersion,
  decodeNotification,
  encodeSampleProfile,
  encodeMachineConfiguration,
  encodeMove,
  Sample,
  MachineState as ProtoMachineState,
  MachineConfiguration as ProtoMachineConfiguration,
  SampleProfile as ProtoSampleProfile,
  NotificationType as ProtoNotificationType,
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
  MSG_WRITE_SAMPLE_PROFILE_WRITE,
  MSG_WRITE_GAUGE_LENGTH,
  MSG_WRITE_GAUGE_FORCE,
  MSG_WRITE_FILE_DOWNLOAD,
  MSG_SAMPLE_PERIOD_MS,
  MSG_STATE_PERIOD_MS,
  STOREDSAMPLE_WIRE_SIZE,
} from '../generated/protoemb';

// ── Bridge NDJSON Event Types (from stdout) ──

interface BridgeEventConnected {
  event: 'connected';
  port: string;
}
interface BridgeEventDisconnected {
  event: 'disconnected';
}
interface BridgeEventAck {
  event: 'ack';
  command: number;
}
interface BridgeEventNack {
  event: 'nack';
  command: number;
}
interface BridgeEventData {
  event: 'data';
  command: number;
  payload: number[];
}
interface BridgeEventNotification {
  event: 'notification';
  payload: number[];
}
interface BridgeEventTimeout {
  event: 'timeout';
}
interface BridgeEventError {
  event: 'error';
  message: string;
}
interface BridgeEventPorts {
  event: 'ports';
  ports: string[];
}
interface BridgeEventStored {
  event: 'stored';
  command: number;
  entries: number[][];
  seq: number;
}

type BridgeEvent =
  | BridgeEventConnected
  | BridgeEventDisconnected
  | BridgeEventAck
  | BridgeEventNack
  | BridgeEventData
  | BridgeEventNotification
  | BridgeEventTimeout
  | BridgeEventError
  | BridgeEventPorts
  | BridgeEventStored;

// ── Number of stored samples for the ring buffer ──
const ONE_MINUTE_MS = 60_000;
const SAMPLE_STORAGE_COUNT = Math.max(
  1,
  Math.ceil(ONE_MINUTE_MS / MSG_SAMPLE_PERIOD_MS),
);
const STATE_STORAGE_COUNT = 10;

/**
 * Resolve the path to the bridge binary.
 *
 * In development: Protocol/ProtoEmb/runtime/target/debug/protoemb-bridge
 * In production: bundled alongside the Electron app
 */
function resolveBridgePath(): string {
  if (app.isPackaged) {
    // Production: binary is in the resources directory
    return path.join(process.resourcesPath, 'bin', 'protoemb-bridge');
  }

  // Development / SIL test: find the monorepo root by walking up from
  // __dirname until we find the Protocol/ directory.  This works whether
  // __dirname is .erb/dll (dev) or release/app/dist/main (prod build run
  // outside a packaged app, e.g. SIL tests).
  let dir = __dirname;
  const fs = require('fs');
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'Protocol', 'ProtoEmb', 'runtime', 'target', 'debug', 'protoemb-bridge');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // Fallback to the original relative path
  return path.join(
    __dirname,
    '../../../../Protocol/ProtoEmb/runtime/target/debug/protoemb-bridge',
  );
}

/**
 * BridgeHandler wraps the Rust protoemb-bridge child process.
 *
 * Events emitted:
 * - 'sample'           (SampleData)      — decoded sample in SharedInterface format
 * - 'state'            (SharedMachineState) — decoded machine state
 * - 'configuration'    (SharedMachineConfiguration) — decoded machine config
 * - 'sample-profile'   (SharedSampleProfile) — decoded sample profile
 * - 'firmware-version' (SharedFirmwareVersion) — decoded firmware version
 * - 'notification'     (SharedNotification) — decoded notification
 * - 'ack'              (command: number, success: boolean) — ACK/NACK
 * - 'data'             (command: number, payload: Buffer) — raw data for unknown commands
 * - 'connected'        (port: string) — serial port connected
 * - 'disconnected'     () — serial port disconnected
 * - 'ports'            (ports: string[]) — available serial ports
 * - 'error'            (message: string) — bridge error
 * - 'bridge-exit'      (code: number | null) — bridge process exited
 */
class BridgeHandler extends EventEmitter {
  private process: ChildProcess | null = null;

  private stdoutBuffer: string = '';

  private running: boolean = false;

  /**
   * Start the bridge process.
   */
  start(): void {
    if (this.process) {
      deviceLogger.warn('Bridge already running, killing old process');
      this.stop();
    }

    const bridgePath = resolveBridgePath();
    deviceLogger.info(`Starting bridge: ${bridgePath}`);

    // Check that the binary exists before spawning to avoid tight retry loops
    const fs = require('fs');
    if (!fs.existsSync(bridgePath)) {
      const errMsg = `protoemb-bridge binary not found at: ${bridgePath}. ` +
        `Build it with: cd Protocol/ProtoEmb/runtime && cargo build --bin protoemb-bridge`;
      deviceLogger.error(errMsg);
      this.emit('error', errMsg);
      this.emit('bridge-exit', -1);
      return;
    }

    this.process = spawn(bridgePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.running = true;

    // Handle stdout (NDJSON events)
    this.process.stdout?.on('data', (data: Buffer) => {
      this.stdoutBuffer += data.toString();
      this.processStdoutBuffer();
    });

    // Handle stderr (log messages)
    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        deviceLogger.debug(`[bridge] ${msg}`);
      }
    });

    this.process.on('close', (code) => {
      deviceLogger.info(`Bridge process exited with code ${code}`);
      this.running = false;
      this.process = null;
      this.emit('bridge-exit', code);
    });

    this.process.on('error', (err) => {
      deviceLogger.error(`Bridge process error: ${err.message}`);
      this.running = false;
      this.emit('error', `Bridge process error: ${err.message}`);
    });
  }

  /**
   * Stop the bridge process gracefully.
   */
  stop(): void {
    if (this.process) {
      this.sendRequest({ cmd: 'quit' });
      // Give it a moment to exit gracefully, then force-kill
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
          this.process = null;
        }
      }, 1000);
    }
    this.running = false;
  }

  /**
   * Whether the bridge process is running.
   */
  isRunning(): boolean {
    return this.running && this.process !== null;
  }

  // ── Serial port management ──

  connect(port: string, baud: number): void {
    this.sendRequest({ cmd: 'connect', port, baud });
  }

  disconnect(): void {
    this.sendRequest({ cmd: 'disconnect' });
  }

  listPorts(): void {
    this.sendRequest({ cmd: 'list_ports' });
  }

  /**
   * Register periodic polling for sample and state data.
   * Called after connecting to the serial port.
   */
  registerPeriodicPolling(): void {
    this.sendRequest({
      cmd: 'register_periodic',
      command: MSG_READ_SAMPLE,
      interval_ms: MSG_SAMPLE_PERIOD_MS,
      storage_count: SAMPLE_STORAGE_COUNT,
    });
    this.sendRequest({
      cmd: 'register_periodic',
      command: MSG_READ_STATE,
      interval_ms: MSG_STATE_PERIOD_MS,
      storage_count: STATE_STORAGE_COUNT,
    });
  }

  /**
   * Unregister periodic polling.
   */
  unregisterPeriodicPolling(): void {
    this.sendRequest({
      cmd: 'unregister_periodic',
      command: MSG_READ_SAMPLE,
    });
    this.sendRequest({
      cmd: 'unregister_periodic',
      command: MSG_READ_STATE,
    });
  }

  // ── Protocol reads (request → DATA response) ──

  readMachineConfiguration(): void {
    this.sendRequest({
      cmd: 'read',
      command: MSG_READ_MACHINE_CONFIGURATION,
      priority: 'high',
    });
  }

  readFirmwareVersion(): void {
    this.sendRequest({
      cmd: 'read',
      command: MSG_READ_FIRMWARE_VERSION,
      priority: 'high',
    });
  }

  readSampleProfile(): void {
    this.sendRequest({
      cmd: 'read',
      command: MSG_READ_SAMPLE_PROFILE,
      priority: 'high',
    });
  }

  /** One-shot state read (periodic polling may be too slow for tight SIL waits). */
  readMachineStateNow(): void {
    this.sendRequest({
      cmd: 'read',
      command: MSG_READ_STATE,
      priority: 'high',
    });
  }

  // ── Protocol writes (command → ACK/NACK) ──

  writeMachineConfiguration(config: SharedMachineConfiguration): void {
    const proto: ProtoMachineConfiguration = {
      name: config.Name,
      encoderStepsPerMM: config['Encoder (step/mm)'],
      servoStepsPerMM: config['Servo (step/mm)'],
      forceGaugeNPerStep: config['Force Gauge (N/step)'],
      forceGaugeZeroOffset: config['Force Gauge Zero Offset (steps)'],
      maxPosition: config['Position Max (mm)'],
      maxVelocity: config['Velocity Max (mm/s)'],
      maxAcceleration: config['Acceleration Max (mm/s^2)'],
      maxForceTensile: config['Tensile Force Max (N)'],
      homingVelocity: config['Homing Velocity (mm/s)'],
      homingOffset: config['Homing Offset (mm)'],
      jawOffset: config['Jaw Offset (mm)'],
    };
    const buf = encodeMachineConfiguration(proto);
    this.sendRequest({
      cmd: 'write',
      command: MSG_WRITE_MACHINE_CONFIGURATION_WRITE,
      data: Array.from(buf),
    });
  }

  writeMotionEnable(enabled: boolean): void {
    this.sendRequest({
      cmd: 'write',
      command: MSG_WRITE_MOTION_ENABLE,
      data: [enabled ? 1 : 0],
    });
  }

  writeTestRun(gcodeId: string, testDataId: string): void {
    // Encode as 14-byte buffer: gcodeId[7] + testDataId[7]
    const buf = Buffer.alloc(14, 0);
    buf.write(gcodeId.slice(0, 6), 0, 'ascii');
    buf.write(testDataId.slice(0, 6), 7, 'ascii');
    this.sendRequest({
      cmd: 'write',
      command: MSG_WRITE_TEST_RUN,
      data: Array.from(buf),
    });
  }

  writeManualMove(move: ProtoMove): void {
    const buf = encodeMove(move);
    this.sendRequest({
      cmd: 'write',
      command: MSG_WRITE_MANUAL_MOVE,
      data: Array.from(buf),
    });
  }

  writeTestMove(data: number[]): void {
    this.sendRequest({
      cmd: 'write',
      command: MSG_WRITE_TEST_MOVE,
      data,
    });
  }

  writeSampleProfile(profile: SharedSampleProfile): void {
    const proto: ProtoSampleProfile = {
      maxForce: profile.maxForce,
      maxVelocity: profile.maxVelocity,
      maxDisplacement: profile.maxDisplacement,
      sampleWidth: profile.sampleWidth,
      sampleThickness: profile.sampleThickness,
    };
    const buf = encodeSampleProfile(proto);
    this.sendRequest({
      cmd: 'write',
      command: MSG_WRITE_SAMPLE_PROFILE_WRITE,
      data: Array.from(buf),
    });
  }

  writeGaugeLength(): void {
    this.sendRequest({
      cmd: 'write',
      command: MSG_WRITE_GAUGE_LENGTH,
      data: [],
    });
  }

  writeGaugeForce(): void {
    this.sendRequest({
      cmd: 'write',
      command: MSG_WRITE_GAUGE_FORCE,
      data: [],
    });
  }

  writeFileDownload(requestData: number[]): void {
    this.sendRequest({
      cmd: 'write',
      command: MSG_WRITE_FILE_DOWNLOAD,
      data: requestData,
    });
  }

  // ── Storage access ──

  getStoredSamples(): void {
    this.sendRequest({
      cmd: 'get_stored',
      command: MSG_READ_SAMPLE,
    });
  }

  getStoredSamplesSince(sinceSeq: number): void {
    this.sendRequest({
      cmd: 'get_stored_since',
      command: MSG_READ_SAMPLE,
      since_seq: sinceSeq,
    });
  }

  // ── Internal methods ──

  private sendRequest(req: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) {
      deviceLogger.warn('Bridge not running, cannot send request');
      return;
    }
    const line = JSON.stringify(req) + '\n';
    this.process.stdin.write(line);
  }

  private processStdoutBuffer(): void {
    const lines = this.stdoutBuffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed) as BridgeEvent;
        this.handleEvent(event);
      } catch (err) {
        deviceLogger.warn(`Failed to parse bridge event: ${trimmed} error: ${err}`);
      }
    }
  }

  private handleEvent(event: BridgeEvent): void {
    switch (event.event) {
      case 'connected':
        deviceLogger.info(`Bridge connected to ${event.port}`);
        this.emit('connected', event.port);
        break;

      case 'disconnected':
        deviceLogger.info('Bridge disconnected');
        this.emit('disconnected');
        break;

      case 'ack':
        this.emit('ack', event.command, true);
        break;

      case 'nack':
        this.emit('ack', event.command, false);
        break;

      case 'data':
        this.handleDataEvent(event.command, event.payload);
        break;

      case 'notification':
        this.handleNotificationEvent(event.payload);
        break;

      case 'timeout':
        deviceLogger.warn('Bridge: response timeout');
        this.emit('timeout');
        break;

      case 'error':
        deviceLogger.error(`Bridge error: ${event.message}`);
        this.emit('error', event.message);
        break;

      case 'ports':
        this.emit('ports', event.ports);
        break;

      case 'stored':
        this.handleStoredEvent(event.command, event.entries, event.seq);
        break;

      default:
        deviceLogger.warn(`Unknown bridge event: ${JSON.stringify(event)}`);
    }
  }

  /**
   * Handle a DATA event — decode the payload based on command ID and emit
   * the appropriate typed event.
   */
  private handleDataEvent(command: number, payload: number[]): void {
    const buf = Buffer.from(payload);

    switch (command) {
      case MSG_READ_SAMPLE: {
        const sample = decodeSample(buf);
        this.emit('sample', this.sampleToShared(sample));
        break;
      }
      case MSG_READ_STATE: {
        const state = decodeMachineState(buf);
        this.emit('state', this.stateToShared(state));
        break;
      }
      case MSG_READ_MACHINE_CONFIGURATION: {
        const config = decodeMachineConfiguration(buf);
        this.emit('configuration', this.configToShared(config));
        break;
      }
      case MSG_READ_FIRMWARE_VERSION: {
        const version = decodeFirmwareVersion(buf);
        this.emit('firmware-version', version as SharedFirmwareVersion);
        break;
      }
      case MSG_READ_SAMPLE_PROFILE: {
        const profile = decodeSampleProfile(buf);
        this.emit('sample-profile', this.sampleProfileToShared(profile));
        break;
      }
      default:
        // Pass through raw data for commands we don't know about
        // (e.g. test_run response, file_download response)
        this.emit('data', command, buf);
        break;
    }
  }

  /**
   * Handle a NOTIFICATION event from the bridge.
   */
  private handleNotificationEvent(payload: number[]): void {
    const buf = Buffer.from(payload);
    const notification = decodeNotification(buf);

    // Map ProtoEmb NotificationType to SharedInterface NotificationType
    const typeMap: Record<ProtoNotificationType, SharedNotificationType> = {
      [ProtoNotificationType.MESSAGE]: SharedNotificationType.INFO,
      [ProtoNotificationType.INFO]: SharedNotificationType.INFO,
      [ProtoNotificationType.WARNING]: SharedNotificationType.WARN,
      [ProtoNotificationType.ERROR]: SharedNotificationType.ERROR,
      [ProtoNotificationType.SUCCESS]: SharedNotificationType.SUCCESS,
    };

    const sharedNotification: SharedNotification = {
      Type: typeMap[notification.type] ?? SharedNotificationType.INFO,
      Message: notification.message,
    };

    this.emit('notification', sharedNotification);
  }

  /**
   * Handle stored data (ring buffer readback from bridge).
   */
  private handleStoredEvent(
    command: number,
    entries: number[][],
    seq: number,
  ): void {
    if (command === MSG_READ_SAMPLE) {
      const samples: SampleData[] = entries.map((entry) => {
        const buf = Buffer.from(entry);
        const sample = decodeSample(buf);
        return this.sampleToShared(sample);
      });
      this.emit('stored-samples', samples, seq);
    } else {
      this.emit('stored', command, entries, seq);
    }
  }

  // ── Type mapping: generated protocol types → SharedInterface types ──

  private sampleToShared(sample: Sample): SampleData {
    return {
      'Machine Force (N)': sample.machineForce,
      'Machine Position (mm)': sample.machinePosition,
      'Machine Setpoint (mm)': sample.machineSetpoint,
      'Sample Force (N)': sample.sampleForce,
      'Sample Position (mm)': sample.samplePosition,
    };
  }

  private stateToShared(state: ProtoMachineState): SharedMachineState {
    return {
      faultedReason: state.faultedReason as unknown as SharedFaultedReason,
      restrictedReason:
        state.restrictedReason as unknown as SharedRestrictedReason,
      testRunning: state.testRunning,
      motionEnabled: state.motionEnabled,
    };
  }

  private configToShared(
    config: ProtoMachineConfiguration,
  ): SharedMachineConfiguration {
    return {
      Name: config.name,
      'Encoder (step/mm)': config.encoderStepsPerMM,
      'Servo (step/mm)': config.servoStepsPerMM,
      'Force Gauge (N/step)': config.forceGaugeNPerStep,
      'Force Gauge Zero Offset (steps)': config.forceGaugeZeroOffset,
      'Position Max (mm)': config.maxPosition,
      'Velocity Max (mm/s)': config.maxVelocity,
      'Acceleration Max (mm/s^2)': config.maxAcceleration,
      'Tensile Force Max (N)': config.maxForceTensile,
      'Homing Velocity (mm/s)': config.homingVelocity,
      'Homing Offset (mm)': config.homingOffset,
      'Jaw Offset (mm)': config.jawOffset,
    };
  }

  private sampleProfileToShared(
    profile: ProtoSampleProfile,
  ): SharedSampleProfile {
    return {
      maxForce: profile.maxForce,
      maxVelocity: profile.maxVelocity,
      maxDisplacement: profile.maxDisplacement,
      sampleWidth: profile.sampleWidth,
      sampleThickness: profile.sampleThickness,
      serial: '', // serial is UI-only, not in protocol
    };
  }
}

export default BridgeHandler;
export {
  MSG_WRITE_MACHINE_CONFIGURATION_WRITE,
  MSG_WRITE_MOTION_ENABLE,
  MSG_WRITE_TEST_RUN,
  MSG_WRITE_MANUAL_MOVE,
  MSG_WRITE_TEST_MOVE,
  MSG_WRITE_SAMPLE_PROFILE_WRITE,
  MSG_WRITE_GAUGE_LENGTH,
  MSG_WRITE_GAUGE_FORCE,
  MSG_WRITE_FILE_DOWNLOAD,
  STOREDSAMPLE_WIRE_SIZE,
};
