/* eslint global-require: off, no-console: off, promise/always-return: off */

import { app, BrowserWindow, shell } from 'electron';

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { deviceLogger } from '@utils/logger';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';
import NotificationSender from './handlers/NotificationSender';
import BridgeHandler from './handlers/BridgeHandler';
import DeviceInterface from './handlers/DeviceInterface';
import {
  initializeDataManager,
  cleanupDataManager,
} from './dataManager';
// Set the app name before anything else
app.setName('MAD Control');

// Enable remote debugging for SIL testing (must be called before app is ready)
if (process.env.SIL_TEST === '1' && process.env.ELECTRON_CDP_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.ELECTRON_CDP_PORT);
}

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;
let bridge: BridgeHandler | null = null;

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug').default();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch((error: Error) => {
      deviceLogger.error('Failed to install extensions:', error);
    });
};

const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    icon: getAssetPath('icon.png'),
    title: 'MAD Control',
    webPreferences: {
      // Use production preload path if packaged OR if SIL_TEST env is set
      preload:
        app.isPackaged || process.env.SIL_TEST === '1'
          ? path.join(__dirname, 'preload.js')
          : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));
  mainWindow.on('ready-to-show', async () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const notificationSender = new NotificationSender(mainWindow);
  bridge = new BridgeHandler();
  // DeviceInterface registers IPC handlers and bridge event listeners in its constructor.
  // It must be created BEFORE bridge.start() so that 'error' events are handled.
  void new DeviceInterface(
    bridge,
    notificationSender,
    mainWindow,
  );
  bridge.start();

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();

  initializeDataManager();
};

/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  cleanupDataManager();
  if (bridge) {
    bridge.stop();
    bridge = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app
  .whenReady()
  .then(() => {
    createWindow();
    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow();
    });
  })
  .catch((error: Error) => {
    deviceLogger.error('Failed to initialize app:', error);
  });
