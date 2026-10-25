/**
 * Event/types contract between the device worker and the main thread.
 *
 * The worker decodes raw protocol payloads into display-layer domain types
 * (so the main thread / store never touches wire bytes for the common path),
 * and emits them through a single `DeviceEventSink` callback.
 */

import {
  SampleData,
  MachineState,
  MachineConfiguration,
  SampleProfile,
  FirmwareVersion,
  Notification,
} from '@/domain';

export type DeviceEvent =
  | { kind: 'connected' }
  /** `reason` is set when the link dropped unexpectedly (unplug, stream error). */
  | { kind: 'disconnected'; reason?: string }
  /** A granted serial port (re)appeared — e.g. the device was plugged back in. */
  | { kind: 'portAvailable' }
  | { kind: 'sample'; data: SampleData }
  | { kind: 'state'; data: MachineState }
  | { kind: 'configuration'; data: MachineConfiguration }
  | { kind: 'sampleProfile'; data: SampleProfile }
  | { kind: 'firmwareVersion'; data: FirmwareVersion }
  | { kind: 'notification'; data: Notification }
  | { kind: 'ack'; command: number; success: boolean }
  | { kind: 'data'; command: number; payload: Uint8Array }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

/** A batch of events delivered to the main thread per poll tick. */
export type DeviceEventSink = (events: DeviceEvent[]) => void;

/** Serial streams handed from the main thread to the worker on connect. */
export interface PortStreams {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export interface ConnectOptions {
  /** Response timeout for the protocol client (ms). */
  responseTimeoutMs?: number;
}

export interface FileDownloadProgress {
  fileName: string;
  bytesDownloaded: number;
  totalBytes: number;
  status: 'downloading' | 'complete' | 'error';
  error?: string;
}

export interface RunTestParams {
  gcode: string[];
  gcodeId: string;
  testDataId: string;
  gaugeLengthMm?: number;
}

export interface RunTestResult {
  success: boolean;
  gcodeId: string;
  testDataId: string;
  error?: string;
}

export interface DownloadResult {
  success: boolean;
  /** Decoded CSV content (caller persists it via the File System Access API). */
  csv?: string;
  sampleBytes?: number;
  error?: string;
}
