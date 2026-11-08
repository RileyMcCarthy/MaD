/**
 * The store's two configuration guards for firmware it cannot drive: a
 * configuration laid out for another protocol is neither read nor overwritten.
 * The device client and data folder are stood in with `vi.mock`, so the store
 * module loads without a worker or a file system.
 */
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { behaviour } from '@vibes/behaviour';
import { subscribeLog, type LogEntry } from '@/diagnostics/log';
import { NotificationType, type MachineConfiguration } from '@/domain';

const device = vi.hoisted(() => ({
  blockReason: null as string | null,
  readMachineConfiguration: vi.fn(),
  writeMachineConfiguration: vi.fn(),
}));

vi.mock('@/device/session', () => ({
  DEFAULT_BAUD_RATE: 2_000_000,
  deviceClient: {
    motionBlockReason: () => device.blockReason,
    readMachineConfiguration: device.readMachineConfiguration,
    writeMachineConfiguration: device.writeMachineConfiguration,
  },
}));

vi.mock('@/storage/DataStore', () => ({ dataStore: {} }));

const { useStore, __resetStoreForTests } = await import('./useStore');

const REASON = 'This firmware is too old for this app.';
const ON_BOARD = { name: 'on the board' } as unknown as MachineConfiguration;
const EDITED = { name: 'edited' } as unknown as MachineConfiguration;

let logged: LogEntry[] = [];
let stopLog: () => void = () => {};

beforeEach(() => {
  __resetStoreForTests();
  device.blockReason = null;
  device.readMachineConfiguration.mockReset().mockResolvedValue(ON_BOARD);
  device.writeMachineConfiguration.mockReset().mockResolvedValue(true);
  useStore.setState({ config: null, error: null, notifications: [] });
  logged = [];
  stopLog = subscribeLog((e) => void logged.push(e));
});

afterEach(() => stopLog());

describe('configuration guards', () => {
  behaviour(
    {
      id: 'store.config-refused-on-other-firmware',
      covers: 'src/store/useStore.ts',
      given: "a board connected whose firmware the app cannot drive, and a machine configuration already on screen",
      expect: {
        'not-read': "refreshing the configuration never asks the board for it, and the one on screen stays",
        'not-saved':
          'saving a configuration never sends it to the board, resolves false, and warns the operator why',
      },
      why: {
        'not-read':
          'firmware on another protocol lays its configuration out differently, so every value read from it would be wrong',
        'not-saved': 'a configuration written in this layout would overwrite the other firmware\'s with misplaced values',
      },
    },
    async () => {
      device.blockReason = REASON;
      useStore.setState({ config: EDITED });

      await useStore.getState().refreshConfig();
      expect(device.readMachineConfiguration).not.toHaveBeenCalled();
      expect(useStore.getState().config).toBe(EDITED);

      expect(await useStore.getState().saveConfig(ON_BOARD)).toBe(false);
      expect(device.writeMachineConfiguration).not.toHaveBeenCalled();
      expect(useStore.getState().config).toBe(EDITED);
      expect(logged).toContainEqual(
        expect.objectContaining({ level: 'warn', cat: 'store', tag: 'save-config-refused', msg: REASON }),
      );
      expect(useStore.getState().notifications).toContainEqual(
        expect.objectContaining({ Type: NotificationType.WARN, Message: REASON }),
      );
    },
  );

  behaviour(
    {
      id: 'store.config-allowed-on-matching-firmware',
      covers: 'src/store/useStore.ts',
      given: "a board connected whose firmware the app can drive",
      expect: {
        read: 'refreshing the configuration reads it from the board and shows it',
        saved: 'saving a configuration sends it to the board and shows it once the board accepts it',
      },
    },
    async () => {
      await useStore.getState().refreshConfig();
      expect(device.readMachineConfiguration).toHaveBeenCalledTimes(1);
      expect(useStore.getState().config).toBe(ON_BOARD);

      expect(await useStore.getState().saveConfig(EDITED)).toBe(true);
      expect(device.writeMachineConfiguration).toHaveBeenCalledWith(EDITED);
      expect(useStore.getState().config).toBe(EDITED);
      expect(logged.some((e) => e.tag === 'save-config-refused')).toBe(false);
    },
  );
});
