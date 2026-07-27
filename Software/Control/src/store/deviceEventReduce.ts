/**
 * Pure device-event → store-patch reduction (Sprint B4).
 *
 * Extracted from useStore's subscribe handler so event contracts can be unit-
 * tested without Zustand / timers / DeviceClient.
 */

import type { DeviceEvent } from '@/device/events';
import type { MachineConfiguration, MachineState, SampleData, SampleProfile } from '@/domain';

export type DeviceEventPatch = {
  machineState?: MachineState | null;
  config?: MachineConfiguration | null;
  sampleProfile?: SampleProfile | null;
  firmwareVersion?: string | null;
  /** Sample arrived — caller updates lastSampleAt / liveBuffer. */
  sample?: SampleData;
  /** Throttled error toast message (undefined = no toast). */
  errorToast?: string;
  /** Diagnostics counter kinds to bump. */
  counters?: Array<'connected' | 'device-error' | 'timeout' | 'nack' | 'disconnected'>;
  /** Disconnect bookkeeping. */
  disconnect?: { reason?: string; unexpected: boolean };
  /** Append notification toast from firmware. */
  notification?: { Type: string; Message: string };
};

/**
 * Reduce a single DeviceEvent into a store patch.
 * @param userDisconnect intentional UI disconnect (no error banner).
 */
export function reduceDeviceEvent(e: DeviceEvent, userDisconnect: boolean): DeviceEventPatch {
  switch (e.kind) {
    case 'sample':
      return { sample: e.data };
    case 'state':
      return { machineState: e.data };
    case 'configuration':
      return { config: e.data };
    case 'sampleProfile':
      return { sampleProfile: e.data };
    case 'firmwareVersion':
      return { firmwareVersion: e.data.version };
    case 'connected':
      return { counters: ['connected'] };
    case 'error':
      return {
        counters: ['device-error'],
        errorToast: `Device error: ${e.message}`,
      };
    case 'timeout':
      return { counters: ['timeout'] };
    case 'ack':
      return e.success ? {} : { counters: ['nack'] };
    case 'notification':
      return { notification: { Type: e.data.Type, Message: e.data.Message } };
    case 'disconnected': {
      const unexpected = !userDisconnect;
      return {
        counters: ['disconnected'],
        disconnect: { reason: e.reason, unexpected },
        machineState: null,
      };
    }
    case 'portAvailable':
    case 'data':
      return {};
    default:
      return {};
  }
}

/** Responding iff a sample arrived within the timeout window. */
export function isResponding(nowMs: number, lastSampleAtMs: number, timeoutMs: number): boolean {
  if (lastSampleAtMs <= 0) return false;
  return nowMs - lastSampleAtMs < timeoutMs;
}
