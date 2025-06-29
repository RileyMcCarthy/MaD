// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export type Channels =
  // Legacy/Example
  | 'ipc-example'

  // Device connection and management
  | 'device-connect'
  | 'device-list-ports'
  | 'device-data-all'
  | 'sample-data-latest'
  | 'device-state'
  | 'device-connected'
  | 'device-responding'

  // Machine configuration
  | 'get-machine-configuration'
  | 'save-machine-configuration'

  // Motion control
  | 'set-motion-enabled'
  | 'manual-move'
  | 'home-axis'
  | 'zero-force'
  | 'stream-gcode'

  // Legacy motion (keeping for compatibility)
  | 'home'
  | 'set_length_zero'
  | 'set_force_zero'

  // Firmware management
  | 'get-firmware-version'
  | 'get-latest-firmware-version'
  | 'update-firmware'
  | 'flash-from-file'
  | 'cancel-firmware-flash'
  | 'firmware-update-progress'
  | 'firmware-flash-status'

  // Sample profiles and testing
  | 'sample-profile-run'
  | 'run-test'

  // Serial port management
  | 'connect-port'

  // Event listeners (from main to renderer) - STANDARDIZED NAMING
  | 'sample-data-updates' // Replaces: sample-data, sample-data-updated
  | 'machine-state-updates' // Replaces: machine-state, machine-state-updated
  | 'machine-configuration-updates' // Replaces: machine-configuration
  | 'firmware-version-updates' // Replaces: firmware-version
  | 'device-status-updates' // Replaces: serial-connection-status, device-responding-status
  | 'notification-error'
  | 'notification-warning'
  | 'notification-info'
  | 'notification-success';

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
    // Add removeAllListeners method for cleanup
    removeAllListeners(channel: Channels) {
      ipcRenderer.removeAllListeners(channel);
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
