const ipcHandlers = new Map<string, (...args: any[]) => any>();

jest.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: jest.fn((channel: string, handler: (...args: any[]) => any) => {
      ipcHandlers.set(channel, handler);
    }),
    emit: jest.fn(),
  },
  BrowserWindow: jest.fn(),
}));

jest.mock('../util', () => ({
  showFirmwareFileDialog: jest.fn(),
}));

import DeviceInterface from './DeviceInterface';
import { showFirmwareFileDialog } from '../util';

describe('DeviceInterface flash safety contracts', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    jest.clearAllMocks();
  });

  function createDeviceInterface(): DeviceInterface {
    const bridge = {
      on: jest.fn(),
      isRunning: jest.fn(() => true),
      start: jest.fn(),
      connect: jest.fn(),
      registerPeriodicPolling: jest.fn(),
      unregisterPeriodicPolling: jest.fn(),
      disconnect: jest.fn(),
      removeListener: jest.fn(),
      readFirmwareVersion: jest.fn(),
    };

    const notificationSender = {
      sendNotification: jest.fn(),
    };

    const window = {
      webContents: {
        send: jest.fn(),
      },
    };

    return new DeviceInterface(
      bridge as any,
      notificationSender as any,
      window as any,
    );
  }

  test('flash-from-file returns explicit no-file-selected error when picker is canceled', async () => {
    createDeviceInterface();

    (showFirmwareFileDialog as jest.Mock).mockResolvedValue(undefined);

    const handler = ipcHandlers.get('flash-from-file');
    expect(handler).toBeDefined();

    const result = await handler?.({});

    expect(result).toEqual({ success: false, error: 'No file selected' });
  });

  test('cancel-firmware-flash reports explicit error when no process is active', async () => {
    createDeviceInterface();

    const handler = ipcHandlers.get('cancel-firmware-flash');
    expect(handler).toBeDefined();

    const result = await handler?.({});

    expect(result).toEqual({ success: false, error: 'No flash process running' });
  });
});
