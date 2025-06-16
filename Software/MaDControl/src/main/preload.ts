// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export type Channels =
  | 'ipc-example'
  | 'device-connect'
  | 'device-list-ports'
  | 'device-data-all'
  | 'sample-data-latest'
  | 'device-state'
  | 'device-connected'
  | 'get-machine-configuration'
  | 'save-machine-configuration'
  | 'set-motion-enabled'
  | 'manual-move'
  | 'home'
  | 'set_length_zero'
  | 'get-firmware-version'
  | 'get-latest-firmware-version'
  | 'update-firmware'
  | 'flash-from-file'
  | 'firmware-update-progress'
  | 'firmware-update-error'
  | 'device-responding';

const electronHandler = {
  ipcRenderer: {
    sendMessage(channel: Channels, ...args: unknown[]) {
      ipcRenderer.send(channel, ...args);
    },
    on(channel: Channels, func: (...args: unknown[]) => void) {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) =>
        func(...args);
      ipcRenderer.on(channel, subscription);

      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },
    once(channel: Channels, func: (...args: unknown[]) => void) {
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },
    sendSync(channel: Channels, args: unknown[]) {
      return ipcRenderer.sendSync(channel, args);
    },
    invoke: (channel: Channels, ...args: unknown[]) => {
      return ipcRenderer.invoke(channel, ...args);
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
