/**
 * Central app store (Zustand).
 *
 * Subscribes once to the device worker's event stream and reflects device
 * status into React. High-frequency sample data goes to the out-of-React
 * `liveBuffer`; only a throttled "latest sample" is mirrored here for readouts.
 */

import { create } from 'zustand';
import { deviceClient, DEFAULT_BAUD_RATE } from '@/device/session';
import { dataStore } from '@/storage/DataStore';
import { DeviceEvent } from '@/device/events';
import {
  MachineState,
  SampleData,
  MachineConfiguration,
  SampleProfile,
  Notification,
  NotificationType,
} from '@/domain';
import { pushSample, resetLiveBuffer, seedSamples } from './liveBuffer';
import { record } from '@/diagnostics/recorder';
import { MSG_SAMPLE_PERIOD_MS } from '@/protocol/generated/protoemb';

// Numeric readout refresh. 4 Hz is the classic instrument-display rate: fast
// enough to feel live, slow enough that the digits are actually readable.
// (Charts are unaffected — they stream from liveBuffer at full rate.)
const SAMPLE_MIRROR_INTERVAL_MS = 250;

export interface UiNotification extends Notification {
  id: number;
  t: number;
}

export interface ConnectArgs {
  /** A specific already-granted port; if omitted, prompts via requestPort(). */
  port?: SerialPort;
  /** Baud rate (default DEFAULT_BAUD_RATE = 2,000,000, matching the firmware UART). */
  baud?: number;
}

interface AppState {
  connection: 'disconnected' | 'connecting' | 'connected';
  /** True while the firmware is actually replying (recent samples), not just port-open. */
  responding: boolean;
  error: string | null;
  portLabel: string | null;
  /** True after an unexpected link loss while we still hold the last port. */
  canReconnect: boolean;

  machineState: MachineState | null;
  latestSample: SampleData | null;
  config: MachineConfiguration | null;
  sampleProfile: SampleProfile | null;
  firmwareVersion: string | null;
  notifications: UiNotification[];

  /** Reactive mirror of the data folder, restored at startup and kept in sync
   *  so every screen re-renders when it changes (not just Settings). */
  dataFolder: string | null;
  dataFolderReady: boolean;
  dataFolderNeedsPermission: boolean;

  // actions
  init: () => void;
  connect: (args?: ConnectArgs) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Retry the last successful port/baud after an unexpected disconnect. */
  reconnect: () => Promise<void>;
  /** Restore the remembered data folder (called once at startup). */
  restoreDataFolder: () => Promise<void>;
  /** Prompt for a data folder (user gesture). */
  chooseDataFolder: () => Promise<void>;
  /** Re-grant access to a remembered folder (user gesture). */
  grantDataFolder: () => Promise<void>;
  refreshConfig: () => Promise<void>;
  saveConfig: (config: MachineConfiguration) => Promise<boolean>;
  refreshSampleProfile: () => Promise<void>;
  saveSampleProfile: (profile: SampleProfile) => Promise<boolean>;
  /** Set the active sample profile locally (e.g. the one selected for a run) so
   *  the live charts show its limits without a device round-trip. */
  setSampleProfile: (profile: SampleProfile | null) => void;
  setMotionEnabled: (enabled: boolean) => Promise<boolean>;
  /** Disable all motion immediately (software stop), preempting any in-flight upload. */
  emergencyStop: () => Promise<void>;
  manualMove: (mm: number, speed: number) => Promise<boolean>;
  homeAxis: () => Promise<void>;
  zeroForce: () => Promise<void>;
  zeroLength: () => Promise<void>;
  dismissNotification: (id: number) => void;
  /** Append a notification (used by global error handlers and ad-hoc messages). */
  notify: (type: NotificationType, message: string) => void;

  /** A new app version is downloaded and waiting to be applied. */
  updateReady: boolean;
  /** Called by the PWA layer when a new SW is waiting; stores the apply fn. */
  notifyUpdateAvailable: (apply: () => void) => void;
  /** Apply a pending app update — refused while connected/testing (it reloads). */
  applyUpdate: () => void;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;
let notificationSeq = 0;
let pendingSample: SampleData | null = null;
let mirrorTimer: ReturnType<typeof setInterval> | null = null;
let respondingTimer: ReturnType<typeof setInterval> | null = null;
let lastSampleAt = 0;
/** Throttle for device-error toasts so a burst of protocol errors can't spam. */
let lastErrorToastAt = 0;
/** No sample within this window ⇒ "not responding". */
const RESPONDING_TIMEOUT_MS = 2000;

/** Last successful connection, kept for reconnect (SerialPort isn't serializable). */
let lastPort: SerialPort | null = null;
let lastBaud = DEFAULT_BAUD_RATE;
/** Set just before a user-initiated disconnect so loss handling can tell them apart. */
let userDisconnect = false;
/** Pending service-worker update applier (set by the PWA layer). */
let pendingUpdate: (() => void) | null = null;

/** Persisted serial preference so we can auto-reconnect next session. The port
 *  object itself isn't serializable — we re-find it via getPorts() by USB id. */
const SERIAL_PREF_KEY = 'mad.serialPref';
interface SerialPref {
  baud: number;
  vendorId?: number;
  productId?: number;
}

function saveSerialPref(port: SerialPort, baud: number): void {
  try {
    const info = port.getInfo();
    const pref: SerialPref = { baud, vendorId: info.usbVendorId, productId: info.usbProductId };
    localStorage.setItem(SERIAL_PREF_KEY, JSON.stringify(pref));
  } catch {
    /* storage unavailable; auto-reconnect just won't persist */
  }
}

function clearSerialPref(): void {
  try {
    localStorage.removeItem(SERIAL_PREF_KEY);
  } catch {
    /* ignore */
  }
}

function readSerialPref(): SerialPref | null {
  try {
    return JSON.parse(localStorage.getItem(SERIAL_PREF_KEY) ?? 'null') as SerialPref | null;
  } catch {
    return null;
  }
}

/** Find a still-granted port matching the saved preference. Matches by USB id;
 *  only falls back to "the sole granted port" when the pref has no USB id (the
 *  SIL fake serial / an adapter that doesn't report one) — never binds to an
 *  unrelated real device just because it's the only one plugged in. */
async function findGrantedPortForPref(pref: SerialPref | null): Promise<SerialPort | null> {
  let ports: SerialPort[] = [];
  try {
    ports = await deviceClient.getPorts();
  } catch {
    return null;
  }
  if (ports.length === 0) return null;
  const byId = ports.find((p) => {
    const i = p.getInfo();
    return (
      pref?.vendorId !== undefined &&
      i.usbVendorId === pref.vendorId &&
      i.usbProductId === pref.productId
    );
  });
  if (byId) return byId;
  return pref?.vendorId === undefined && ports.length === 1 ? ports[0] : null;
}

/** Auto-reconnect to a previously-used, still-granted port at startup. */
async function maybeAutoConnect(connect: AppState['connect']): Promise<void> {
  const pref = readSerialPref();
  if (!pref) return;
  const match = await findGrantedPortForPref(pref);
  if (!match) return;
  await connect({ port: match, baud: pref.baud });
}

type SetState = (partial: Partial<AppState>) => void;
type GetState = () => AppState;

function stopTimers(): void {
  if (mirrorTimer) {
    clearInterval(mirrorTimer);
    mirrorTimer = null;
  }
  if (respondingTimer) {
    clearInterval(respondingTimer);
    respondingTimer = null;
  }
}

/** Retry a one-shot device read a few times. The protocol client is
 *  single-in-flight with no per-request retry, so a connect-time read can lose
 *  its window to the periodic sample/state polls (or a just-restarted, still
 *  warming emulator). Since the link is up, retrying recovers it instead of
 *  failing permanently. Returns undefined if every attempt misses. */
async function retryRead<T>(fn: () => Promise<T>, attempts = 4): Promise<T | undefined> {
  for (let i = 0; i < attempts; i++) {
    try {
       
      return await fn();
    } catch {
      /* missed its window — try again */
    }
  }
  return undefined;
}

/** Shared post-connect setup for both the serial and dev-WebSocket paths. */
function afterConnect(set: SetState, getState: GetState, label: string): void {
  set({ connection: 'connected', portLabel: label });

  if (mirrorTimer) clearInterval(mirrorTimer);
  mirrorTimer = setInterval(() => {
    if (pendingSample) {
      set({ latestSample: pendingSample });
      pendingSample = null;
    }
  }, SAMPLE_MIRROR_INTERVAL_MS);

  // Health watchdog: "responding" iff a sample arrived recently.
  if (respondingTimer) clearInterval(respondingTimer);
  lastSampleAt = 0;
  respondingTimer = setInterval(() => {
    const responding = Date.now() - lastSampleAt < RESPONDING_TIMEOUT_MS;
    if (responding !== getState().responding) set({ responding });
  }, 500);

  // Seed charts with any samples the worker decoded before the UI caught up.
  void deviceClient
    .getStoredSamples()
    .then((samples) => seedSamples(samples, MSG_SAMPLE_PERIOD_MS))
    .catch(() => undefined);

  // Pull initial device info. These are background best-effort reads — retry
  // a transient miss (the link is up) and never raise the top-level `error`
  // (only a user-initiated Machine→Reload should surface a config failure).
  void retryRead(() => deviceClient.readMachineConfiguration()).then((config) => {
    if (config) set({ config });
  });
  void retryRead(() => deviceClient.readSampleProfile()).then((sampleProfile) => {
    if (sampleProfile) set({ sampleProfile });
  });
  void retryRead(() => deviceClient.readFirmwareVersion()).then((version) => {
    if (version) set({ firmwareVersion: version });
  });
}

export const useStore = create<AppState>((set, getState) => ({
  connection: 'disconnected',
  responding: false,
  error: null,
  portLabel: null,
  canReconnect: false,
  machineState: null,
  latestSample: null,
  config: null,
  sampleProfile: null,
  firmwareVersion: null,
  notifications: [],
  dataFolder: null,
  dataFolderReady: false,
  dataFolderNeedsPermission: false,
  updateReady: false,

  init: () => {
    if (initialized) return;
    initialized = true;
    unsubscribe = deviceClient.subscribe((events: DeviceEvent[]) => {
      for (const e of events) {
        switch (e.kind) {
          case 'sample':
            pushSample(e.data);
            pendingSample = e.data;
            lastSampleAt = Date.now();
            break;
          case 'state':
            set({ machineState: e.data });
            break;
          case 'configuration':
            set({ config: e.data });
            break;
          case 'sampleProfile':
            set({ sampleProfile: e.data });
            break;
          case 'firmwareVersion':
            set({ firmwareVersion: e.data.version });
            break;
          case 'connected':
            record('info', 'connected');
            break;
          case 'error': {
            record('error', 'device-error', e.message);
            const now = Date.now();
            if (now - lastErrorToastAt > 5000) {
              lastErrorToastAt = now;
              getState().notify(NotificationType.WARN, `Device error: ${e.message}`);
            }
            break;
          }
          case 'timeout':
            record('warn', 'timeout');
            break;
          case 'ack':
            if (!e.success) record('warn', 'nack', `command ${e.command}`);
            break;
          case 'notification':
            set((s) => ({
              notifications: [
                ...s.notifications.slice(-49),
                { ...e.data, id: (notificationSeq += 1), t: Date.now() },
              ],
            }));
            break;
          case 'disconnected': {
            const lost = !userDisconnect;
            userDisconnect = false;
            stopTimers();
            record(lost ? 'warn' : 'info', 'disconnected', e.reason ?? '');
            // Flush the freshest sample so the frozen readouts show the true last
            // reading at the moment of loss (the 250ms mirror could be stale).
            const flushed = pendingSample;
            pendingSample = null;
            set({
              connection: 'disconnected',
              machineState: null,
              responding: false,
              ...(flushed ? { latestSample: flushed } : {}),
              ...(lost
                ? {
                    error: e.reason ? `Device disconnected (${e.reason})` : 'Device disconnected',
                    canReconnect: lastPort !== null,
                  }
                : {}),
            });
            if (lost) {
              set((s) => ({
                notifications: [
                  ...s.notifications.slice(-49),
                  {
                    Type: NotificationType.ERROR,
                    Message: 'Device disconnected — check the cable, then Reconnect.',
                    id: (notificationSeq += 1),
                    t: Date.now(),
                  },
                ],
              }));
            }
            break;
          }
          case 'portAvailable': {
            // The device came back (replug) — try to resume automatically.
            const s = getState();
            if (s.connection === 'disconnected' && s.canReconnect) void s.reconnect();
            break;
          }
          default:
            break;
        }
      }
    });

    // Restore persisted session: data folder + last serial device.
    void getState().restoreDataFolder();
    void maybeAutoConnect(getState().connect);
  },

  connect: async (args = {}) => {
    set({ connection: 'connecting', error: null });
    try {
      const port = args.port ?? (await deviceClient.requestPort());
      const baud = args.baud ?? DEFAULT_BAUD_RATE;
      resetLiveBuffer();
      userDisconnect = false;
      await deviceClient.connect(port, baud);
      lastPort = port;
      lastBaud = baud;
      saveSerialPref(port, baud); // remember for next-session auto-reconnect
      const info = port.getInfo();
      const label =
        info.usbVendorId !== undefined
          ? `USB ${info.usbVendorId.toString(16)}:${(info.usbProductId ?? 0).toString(16)}`
          : 'Serial device';
      set({ canReconnect: false });
      afterConnect(set, getState, label);
    } catch (err) {
      // A failed (re)connect keeps canReconnect as-is so the user can retry.
      set({
        connection: 'disconnected',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  disconnect: async () => {
    stopTimers();
    userDisconnect = true;
    clearSerialPref(); // intentional disconnect ⇒ don't auto-reconnect next session
    await deviceClient.disconnect();
    set({
      connection: 'disconnected',
      responding: false,
      latestSample: null,
      machineState: null,
      canReconnect: false,
    });
  },

  reconnect: async () => {
    const s = getState();
    if (s.connection !== 'disconnected') return;
    // Re-resolve via getPorts() (a replug yields a fresh SerialPort object; the
    // cached lastPort handle may be stale); fall back to the cached handle.
    const port = (await findGrantedPortForPref(readSerialPref())) ?? lastPort;
    if (!port) return;
    await s.connect({ port, baud: lastBaud });
  },

  restoreDataFolder: async () => {
    const ready = await dataStore.restoreDirectory();
    set({
      dataFolder: dataStore.directoryName,
      dataFolderReady: ready,
      dataFolderNeedsPermission: dataStore.needsPermission,
    });
  },

  chooseDataFolder: async () => {
    await dataStore.chooseDirectory();
    set({
      dataFolder: dataStore.directoryName,
      dataFolderReady: dataStore.connected,
      dataFolderNeedsPermission: dataStore.needsPermission,
    });
  },

  grantDataFolder: async () => {
    await dataStore.requestPermission();
    set({
      dataFolder: dataStore.directoryName,
      dataFolderReady: dataStore.connected,
      dataFolderNeedsPermission: dataStore.needsPermission,
    });
  },

  refreshConfig: async () => {
    try {
      const config = await deviceClient.readMachineConfiguration();
      set({ config });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  saveConfig: async (config) => {
    const ok = await deviceClient.writeMachineConfiguration(config);
    if (ok) set({ config });
    return ok;
  },

  refreshSampleProfile: async () => {
    try {
      const sampleProfile = await deviceClient.readSampleProfile();
      set({ sampleProfile });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  saveSampleProfile: async (profile) => {
    const ok = await deviceClient.writeSampleProfile(profile);
    if (ok) await getState().refreshSampleProfile();
    return ok;
  },

  setSampleProfile: (profile) => set({ sampleProfile: profile }),

  setMotionEnabled: (enabled) => deviceClient.setMotionEnabled(enabled),
  emergencyStop: async () => {
    const ok = await deviceClient.emergencyStop().catch(() => false);
    set((s) => ({
      notifications: [
        ...s.notifications.slice(-49),
        {
          Type: ok ? NotificationType.WARN : NotificationType.ERROR,
          Message: ok
            ? 'Emergency stop — motion disabled.'
            : 'Emergency stop sent — confirm the machine has stopped.',
          id: (notificationSeq += 1),
          t: Date.now(),
        },
      ],
    }));
  },
  manualMove: (mm, speed) => deviceClient.manualMove(mm, speed),
  homeAxis: () => deviceClient.homeAxis(),
  zeroForce: () => deviceClient.zeroForce(),
  zeroLength: () => deviceClient.zeroLength(),

  dismissNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),

  notify: (type, message) =>
    set((s) => ({
      notifications: [
        ...s.notifications.slice(-49),
        { Type: type, Message: message, id: (notificationSeq += 1), t: Date.now() },
      ],
    })),

  notifyUpdateAvailable: (apply) => {
    pendingUpdate = apply;
    set({ updateReady: true });
    getState().notify(
      NotificationType.INFO,
      'A new version is available. It will be applied when you disconnect.',
    );
  },

  applyUpdate: () => {
    const s = getState();
    if (s.connection !== 'disconnected' || s.machineState?.testRunning) {
      getState().notify(NotificationType.WARN, 'Disconnect the device before updating.');
      return;
    }
    pendingUpdate?.();
  },
}));

/** Test-only: tear down the singleton subscription + module state so each test
 *  starts from a clean slate (the store is otherwise an app-lifetime singleton). */
export function __resetStoreForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  stopTimers();
  initialized = false;
  pendingSample = null;
  lastSampleAt = 0;
  lastErrorToastAt = 0;
  lastPort = null;
  lastBaud = DEFAULT_BAUD_RATE;
  userDisconnect = false;
  pendingUpdate = null;
}
