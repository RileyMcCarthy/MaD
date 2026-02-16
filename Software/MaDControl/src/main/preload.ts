// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export type Channels =
  // Device connection and management
  | 'device-connect'
  | 'device-list-ports'
  | 'device-data-all'
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
  | 'zero-length'
  | 'stream-gcode'

  // Firmware management
  | 'get-firmware-version'
  | 'flash-from-file'
  | 'cancel-firmware-flash'
  | 'firmware-update-progress'
  | 'firmware-flash-status'

  // Sample profiles and testing
  | 'get-sample-profile'
  | 'save-sample-profile'
  | 'run-test'

  // File download
  | 'download-test-file'
  | 'file-download-progress'

  // Data management
  | 'data-get-sample-profiles'
  | 'data-save-sample-profile'
  | 'data-overwrite-sample-profile'
  | 'data-delete-sample-profile'
  | 'data-get-motion-profiles'
  | 'data-save-motion-profile'
  | 'data-overwrite-motion-profile'
  | 'data-delete-motion-profile'
  | 'data-save-set'
  | 'data-overwrite-set'
  | 'data-get-sets'
  | 'data-get-test-runs'
  | 'data-get-test-run'
  | 'data-create-test-run'
  | 'data-update-test-run'
  | 'data-delete-test-run'
  | 'data-save-test-csv'
  | 'data-read-test-csv'
  | 'data-export-test-csv'
  | 'data-get-test-runs-dir'
  | 'data-open-data-dir'
  | 'data-get-data-dir'
  | 'data-choose-data-dir'
  | 'data-set-data-dir'

  // Event listeners (main → renderer)
  | 'sample-data-updates'
  | 'machine-state-updates'
  | 'machine-configuration-updates'
  | 'sample-profile-updates'
  | 'firmware-version-updates'
  | 'device-status-updates'
  | 'notification-error'
  | 'notification-warning'
  | 'notification-info'
  | 'notification-success';

const electronHandler = {
  ipcRenderer: {
    on(channel: Channels, func: (...args: unknown[]) => void) {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) =>
        func(...args);
      ipcRenderer.on(channel, subscription);

      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },
    invoke: (channel: Channels, ...args: unknown[]) => {
      return ipcRenderer.invoke(channel, ...args);
    },
    removeAllListeners(channel: Channels) {
      ipcRenderer.removeAllListeners(channel);
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
