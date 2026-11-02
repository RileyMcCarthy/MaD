/**
 * The firmware check run after every connect: read the firmware's version and
 * protocol, decide whether this app can drive it (src/domain/firmwareCompat.ts),
 * and block motion at the device client when it cannot.
 *
 * Kept out of useStore so the sequence can be tested without the store's
 * singletons; the store passes the real device client and its retrying read.
 */

import {
  blocksMotion,
  checkFirmwareCompat,
  describeFirmwareCompat,
  type FirmwareCompat,
} from '@/domain';
import { logger } from '@/diagnostics/log';

export interface FirmwareCheckClient {
  readFirmwareVersion(): Promise<string>;
  readDeviceInfo(): Promise<{ protocolVersion: number } | null>;
  setMotionBlock(reason: string | null): void;
}

export interface FirmwareCheckPatch {
  firmwareVersion?: string;
  deviceProtocol?: number | null;
  firmwareCompat?: FirmwareCompat | null;
}

export interface FirmwareCheckOptions {
  client: FirmwareCheckClient;
  /** A device read retried over transient misses; undefined when every attempt missed. */
  read: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  /** False once the connection this check belongs to has been replaced. */
  isCurrent: () => boolean;
  apply: (patch: FirmwareCheckPatch) => void;
  appProtocol: number;
  minFirmware: string | null;
  /**
   * The reads that interpret the firmware's structured replies (machine
   * configuration, sample profile). Run once the verdict says the layouts
   * match; skipped otherwise, where every value they returned could be misread.
   */
  afterCompatible?: () => void;
}

const log = logger('store');

/**
 * Motion fails closed: the caller blocks it when the connection opens
 * (`CHECKING`), and this lifts the block only for firmware that answers with
 * this app's protocol. Firmware on another protocol, or one that never
 * answers, keeps every motion command refused until the connection ends.
 *
 * Resolves with the verdict, or undefined when the connection was replaced
 * before the board answered.
 */
export async function checkConnectedFirmware(opts: FirmwareCheckOptions): Promise<FirmwareCompat | undefined> {
  const { client, read, isCurrent, apply, appProtocol, minFirmware, afterCompatible } = opts;
  const version = await read(() => client.readFirmwareVersion());
  if (!isCurrent()) return undefined;
  if (version) apply({ firmwareVersion: version });
  // undefined: no answer at all. null: refused, i.e. firmware from before the handshake.
  const info = await read(() => client.readDeviceInfo());
  if (!isCurrent()) return undefined;
  if (info === undefined) {
    const unanswered: FirmwareCompat = { kind: 'unanswered' };
    log.warn('firmware-compat', 'no reply to the device-info read', { verdict: unanswered.kind, appProtocol });
    client.setMotionBlock(describeFirmwareCompat(unanswered));
    apply({ firmwareCompat: unanswered, deviceProtocol: null });
    return unanswered;
  }
  const deviceProtocol = info?.protocolVersion ?? null;
  const compat = checkFirmwareCompat({
    deviceProtocol,
    deviceFirmware: version ?? null,
    appProtocol,
    minFirmware,
  });
  const data = { verdict: compat.kind, deviceProtocol, appProtocol, firmware: version ?? null };
  if (compat.kind === 'ok') log.info('firmware-compat', undefined, data);
  else log.warn('firmware-compat', describeFirmwareCompat(compat), data);
  const blocked = blocksMotion(compat);
  client.setMotionBlock(blocked ? describeFirmwareCompat(compat) : null);
  apply({ firmwareCompat: compat, deviceProtocol });
  if (!blocked) afterCompatible?.();
  return compat;
}
