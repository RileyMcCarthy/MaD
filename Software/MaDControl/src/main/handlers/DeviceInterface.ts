import { ipcMain, BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  MachineState,
  SampleData,
  MachineConfiguration,
  NotificationType,
  FirmwareVersion,
  SampleProfile,
  FileDownloadProgress,
} from '@shared/SharedInterface';
import { deviceLogger } from '@utils/logger';
import {
  encodeMove,
  decodeStoredSample,
  Move as ProtoMove,
  GCode,
  STOREDSAMPLE_WIRE_SIZE,
  MSG_SAMPLE_PERIOD_MS,
  MSG_WRITE_TEST_RUN,
  MSG_WRITE_MOTION_ENABLE,
  MSG_WRITE_MANUAL_MOVE,
  MSG_WRITE_SAMPLE_PROFILE_WRITE,
  MSG_WRITE_TEST_MOVE,
  MSG_WRITE_FILE_DOWNLOAD,
} from '../generated/protoemb';
import NotificationSender from './NotificationSender';
import BridgeHandler from './BridgeHandler';
import { showFirmwareFileDialog } from '../util';

/**
 * Number of moves to batch into a single TEST_MOVE message.
 */
const BATCH_MOVE_COUNT = 32;

/**
 * Parse a G-code text line into a ProtoMove struct.
 * Returns null for unparseable lines.
 */
function parseGcodeToMove(line: string): ProtoMove | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length === 0) return null;

  let g = 0;
  let x = 0; // mm (UI units)
  let f = 0; // mm/s (UI units)
  let p = 0; // ms

  for (const token of tokens) {
    const code = token[0].toUpperCase();
    const value = parseFloat(token.substring(1));
    if (isNaN(value)) continue;

    switch (code) {
      case 'G':
        g = Math.round(value);
        break;
      case 'X':
        x = value; // already mm
        break;
      case 'F':
        f = value; // already mm/s
        break;
      case 'P':
        p = Math.round(value); // ms
        break;
    }
  }

  // g is the actual G-code number (0, 1, 28, 90, 91, 122, etc.)
  // encodeMove will map it to wire index via GCODE_VALUE_TO_WIRE
  return { g: g as GCode, x, f, p };
}

/**
 * Decode binary StoredSample structs into CSV string for file downloads.
 * position_um / setpoint_um are the firmware sample frame (machine µm minus gauge length at zero-length).
 */
function decodeBinarySampleDataToCSV(data: Buffer): string {
  const lines: string[] = ['time_us,index,force_mN,position_um,setpoint_um'];
  const numSamples = Math.floor(data.length / STOREDSAMPLE_WIRE_SIZE);

  for (let i = 0; i < numSamples; i++) {
    const offset = i * STOREDSAMPLE_WIRE_SIZE;
    const sample = decodeStoredSample(
      data.subarray(offset, offset + STOREDSAMPLE_WIRE_SIZE),
    );
    // StoredSample fields are in UI units (N, mm) — convert back to raw for CSV
    const forceMN = Math.round(sample.force * 1000);
    const positionUM = Math.round(sample.position * 1000);
    const setpointUM = Math.round(sample.setpoint * 1000);
    lines.push(
      `${sample.time},${sample.index},${forceMN},${positionUM},${setpointUM}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Helper: wait for a single event from BridgeHandler with timeout.
 */
function waitForBridgeEvent(
  bridge: BridgeHandler,
  eventName: string,
  timeout: number,
  filter?: (...args: any[]) => boolean,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      bridge.removeListener(eventName, handler);
      reject(new Error(`Timeout waiting for bridge event: ${eventName}`));
    }, timeout);

    const handler = (...args: any[]) => {
      if (filter && !filter(...args)) return; // keep listening
      clearTimeout(timeoutId);
      bridge.removeListener(eventName, handler);
      resolve(args.length === 1 ? args[0] : args);
    };

    bridge.on(eventName, handler);
  });
}

function waitForDownloadChunkOrNack(
  bridge: BridgeHandler,
  timeout: number,
): Promise<{ kind: 'data'; chunk: Buffer } | { kind: 'nack' }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutId);
      bridge.removeListener('data', onData);
      bridge.removeListener('ack', onAck);
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout waiting for file-download response'));
    }, timeout);

    const onData = (command: number, payload: Buffer) => {
      if (command !== MSG_WRITE_FILE_DOWNLOAD) return;
      cleanup();
      resolve({ kind: 'data', chunk: payload });
    };

    const onAck = (command: number, success: boolean) => {
      if (command !== MSG_WRITE_FILE_DOWNLOAD) return;
      if (success) return;
      cleanup();
      resolve({ kind: 'nack' });
    };

    bridge.on('data', onData);
    bridge.on('ack', onAck);
  });
}

class DeviceInterface {
  private bridge: BridgeHandler;

  private notificationSender: NotificationSender;

  private window: BrowserWindow;

  private deviceConnected: boolean = false;

  private deviceResponding: boolean = false;

  /** Latest firmware machine flags from bridge (for tests / diagnostics). */
  private lastMachineState: MachineState | null = null;

  /** Latest live sample from bridge (for SIL / diagnostics; DOM may lag). */
  private lastSample: SampleData | null = null;

  private currentFlashProcess: any = null;

  private connectedPort: string | null = null;

  private connectedBaud: number = 115200;

  constructor(
    bridge: BridgeHandler,
    notificationSender: NotificationSender,
    window: BrowserWindow,
  ) {
    this.bridge = bridge;
    this.notificationSender = notificationSender;
    this.window = window;

    this.setupBridgeEventHandlers();
    this.setupIPCHandlers();
  }

  /**
   * Wire up BridgeHandler events → renderer IPC sends.
   */
  private setupBridgeEventHandlers(): void {
    // Live sample data → renderer
    this.bridge.on('sample', (sampleData: SampleData) => {
      if (!this.deviceResponding) {
        this.deviceResponding = true;
        this.window.webContents.send('device-status-updates', {
          responding: true,
          connected: this.deviceConnected,
          message: 'Device is responding',
        });
      }
      this.lastSample = sampleData;
      this.window.webContents.send('sample-data-updates', sampleData);
    });

    // Machine state → renderer
    this.bridge.on('state', (state: MachineState) => {
      this.lastMachineState = state;
      this.window.webContents.send('machine-state-updates', state);
    });

    // Machine configuration → renderer
    this.bridge.on('configuration', (config: MachineConfiguration) => {
      this.window.webContents.send('machine-configuration-updates', config);
      ipcMain.emit('machine-configuration-updated', config);
    });

    // Firmware version → renderer
    this.bridge.on('firmware-version', (version: FirmwareVersion) => {
      this.window.webContents.send('firmware-version-updates', version);
      ipcMain.emit('firmware-version-updated', version);
    });

    // Sample profile → renderer
    this.bridge.on('sample-profile', (profile: SampleProfile) => {
      this.window.webContents.send('sample-profile-updates', profile);
      ipcMain.emit('sample-profile-updated', profile);
    });

    // Notifications → notification sender
    this.bridge.on('notification', (notification: any) => {
      this.notificationSender.sendNotification(notification);
    });

    // Connection events
    this.bridge.on('connected', (port: string) => {
      deviceLogger.info(`Device connected to ${port}`);
      this.deviceConnected = true;
      this.connectedPort = port;
      this.window.webContents.send('device-status-updates', {
        connected: true,
        responding: this.deviceResponding,
        message: `Connected to ${port}`,
      });
    });

    this.bridge.on('disconnected', () => {
      deviceLogger.info('Device disconnected');
      this.deviceConnected = false;
      this.deviceResponding = false;
      this.connectedPort = null;
      this.lastMachineState = null;
      this.lastSample = null;
      this.window.webContents.send('device-status-updates', {
        connected: false,
        responding: false,
        message: 'Disconnected',
      });
    });

    // Bridge process died
    this.bridge.on('bridge-exit', (code: number | null) => {
      deviceLogger.warn(`Bridge process exited with code ${code}`);
      this.deviceConnected = false;
      this.deviceResponding = false;
      this.lastMachineState = null;
      this.lastSample = null;
      this.window.webContents.send('device-status-updates', {
        connected: false,
        responding: false,
        message: 'Bridge process exited unexpectedly',
      });
    });

    // Timeout — device stopped responding
    this.bridge.on('timeout', () => {
      if (this.deviceResponding) {
        this.deviceResponding = false;
        deviceLogger.warn('Device stopped responding (timeout)');
        this.window.webContents.send('device-status-updates', {
          responding: false,
          connected: this.deviceConnected,
          message: 'Device stopped responding',
        });
      }
    });

    // Bridge errors
    this.bridge.on('error', (message: string) => {
      deviceLogger.error(`Bridge error: ${message}`);
    });
  }

  /**
   * Register all IPC handlers.
   */
  private setupIPCHandlers(): void {
    ipcMain.handle(
      'device-connect',
      async (_event, portPath: string, baudRate: number) => {
        deviceLogger.info(`Attempting to connect to device at ${portPath}`);
        this.deviceConnected = false;
        this.deviceResponding = false;
        this.connectedBaud = baudRate;

        try {
          // Ensure bridge is running
          if (!this.bridge.isRunning()) {
            this.bridge.start();
            await new Promise((resolve) => setTimeout(resolve, 500));
          }

          // Send connect request and wait for 'connected' event
          const connectPromise = waitForBridgeEvent(
            this.bridge,
            'connected',
            5000,
          );
          this.bridge.connect(portPath, baudRate);
          await connectPromise;

          // Start periodic polling for sample and state data
          this.bridge.registerPeriodicPolling();

          return `Connected to ${portPath}`;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          deviceLogger.error('Connection failed:', errorMessage);
          throw new Error(errorMessage);
        }
      },
    );

    ipcMain.handle('device-list-ports', async () => {
      if (!this.bridge.isRunning()) {
        this.bridge.start();
        // If start() failed (e.g. binary missing), don't wait and retry
        if (!this.bridge.isRunning()) {
          return [];
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const portsPromise = waitForBridgeEvent(this.bridge, 'ports', 3000);
      this.bridge.listPorts();
      const ports = await portsPromise;

      // Post-process: add virtual port for SIL testing
      const portList: string[] = Array.isArray(ports) ? ports : [];
      if (
        fs.existsSync('/tmp/tty.rpi') &&
        !portList.includes('/tmp/tty.rpi')
      ) {
        portList.unshift('/tmp/tty.rpi');
      }

      // macOS: transform tty.* to cu.* for compatibility
      if (process.platform === 'darwin') {
        return portList.map((p: string) => p.replace('/dev/tty.', '/dev/cu.'));
      }
      return portList;
    });

    ipcMain.handle('device-data-all', async () => {
      const storedPromise = waitForBridgeEvent(
        this.bridge,
        'stored-samples',
        3000,
      );
      this.bridge.getStoredSamples();
      const samples = await storedPromise;
      return Array.isArray(samples) ? samples : [];
    });

    ipcMain.handle('device-sample-period-ms', async () => {
      return MSG_SAMPLE_PERIOD_MS;
    });

    ipcMain.handle('device-responding', async () => {
      return this.deviceResponding;
    });

    ipcMain.handle('device-connected', async () => {
      return this.deviceConnected;
    });

    ipcMain.handle('device-machine-state', async () => {
      if (!this.deviceConnected) {
        return this.lastMachineState;
      }
      try {
        const fresh = waitForBridgeEvent(this.bridge, 'state', 3000);
        this.bridge.readMachineStateNow();
        await fresh;
      } catch {
        deviceLogger.debug(
          'device-machine-state: timed out waiting for read; returning cache',
        );
      }
      return this.lastMachineState;
    });

    ipcMain.handle('device-latest-sample', async () => {
      return this.lastSample;
    });

    ipcMain.handle('get-machine-configuration', async () => {
      deviceLogger.info('Getting Machine Configuration');
      const configPromise = waitForBridgeEvent(
        this.bridge,
        'configuration',
        2000,
      );
      this.bridge.readMachineConfiguration();
      return configPromise;
    });

    ipcMain.handle(
      'save-machine-configuration',
      async (_event, newConfig: MachineConfiguration) => {
        deviceLogger.info('Saving Machine Configuration:', newConfig);
        this.bridge.writeMachineConfiguration(newConfig);
        return true;
      },
    );

    ipcMain.handle('set-motion-enabled', async (_event, enabled: boolean) => {
      deviceLogger.debug('set-motion-enabled', enabled);
      const ackPromise = waitForBridgeEvent(
        this.bridge,
        'ack',
        2000,
        (command: number) => command === MSG_WRITE_MOTION_ENABLE,
      );
      this.bridge.writeMotionEnable(enabled);
      const [, success] = await ackPromise;
      return success;
    });

    ipcMain.handle('manual-move', async (_event, mm: number, speed: number) => {
      const s = this.lastMachineState;
      deviceLogger.info(
        `manual-move mm=${mm} speed=${speed} state=motionEnabled:${s?.motionEnabled} testRunning:${s?.testRunning} fault:${s?.faultedReason} restriction:${s?.restrictedReason} pos=${this.lastSample?.['Machine Position (mm)']}`,
      );
      if (!this.deviceConnected) {
        deviceLogger.warn('manual-move ignored: device not connected');
        return false;
      }
      // G91 must be applied before the relative G0; wait for each firmware ACK so the pair
      // cannot reorder across the bridge (fixes flaky SIL jogs when writes pile up).
      const moves: ProtoMove[] = [
        { g: 91 as GCode, x: 0, f: 0, p: 0 },
        { g: 0 as GCode, x: mm, f: speed, p: 0 },
      ];
      for (const move of moves) {
        const ackPromise = waitForBridgeEvent(
          this.bridge,
          'ack',
          5000,
          (command: number) => command === MSG_WRITE_MANUAL_MOVE,
        );
        this.bridge.writeManualMove(move);
        try {
          const [, success] = await ackPromise;
          deviceLogger.info(
            `manual-move g${move.g} x=${move.x} f=${move.f} ack=${success}`,
          );
          if (!success) {
            return false;
          }
        } catch (err) {
          deviceLogger.error(
            `manual-move g${move.g} x=${move.x} f=${move.f} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return false;
        }
      }
      return true;
    });

    ipcMain.handle('home-axis', async () => {
      this.bridge.writeManualMove({ g: 28 as GCode, x: 0, f: 0, p: 0 }); // G28
      return true;
    });

    ipcMain.handle('zero-force', async () => {
      this.bridge.writeGaugeForce();
      return true;
    });

    ipcMain.handle('zero-length', async () => {
      this.bridge.writeGaugeLength();
      return true;
    });

    ipcMain.handle('get-sample-profile', async () => {
      deviceLogger.info('Getting Sample Profile');
      const profilePromise = waitForBridgeEvent(
        this.bridge,
        'sample-profile',
        2000,
      );
      this.bridge.readSampleProfile();
      return profilePromise;
    });

    ipcMain.handle(
      'save-sample-profile',
      async (_event, newProfile: SampleProfile) => {
        // Convert UI units to firmware units before sending.
        // Firmware expects: force in mN, velocity in mm/s, displacement/geometry in mm.
        const firmwareProfile: SampleProfile = {
          maxForce: Math.max(0, newProfile.maxForce ?? 0),
          maxVelocity: Math.max(0, Math.round(newProfile.maxVelocity ?? 0)),
          maxDisplacement: Math.max(
            0,
            Math.round(newProfile.maxDisplacement ?? 0),
          ),
          sampleWidth: Math.max(0, Math.round(newProfile.sampleWidth ?? 0)),
          sampleThickness: Math.max(
            0,
            Math.round(newProfile.sampleThickness ?? 0),
          ),
          serial: newProfile.serial ?? '',
        };

        const ackPromise = waitForBridgeEvent(
          this.bridge,
          'ack',
          2000,
          (command: number) => command === MSG_WRITE_SAMPLE_PROFILE_WRITE,
        );
        this.bridge.writeSampleProfile(firmwareProfile);
        deviceLogger.info(
          'Saving Sample Profile (firmware units):',
          firmwareProfile,
        );

        const [, success] = await ackPromise;

        if (!success) {
          this.notificationSender.sendNotification({
            Type: NotificationType.ERROR,
            Message:
              'Device rejected the sample profile. Previous limits will remain in use.',
          });
        } else {
          // Re-read the saved profile
          setTimeout(() => this.bridge.readSampleProfile(), 100);
        }

        return success;
      },
    );

    // Run Test handler — uploads binary move structs then starts test
    ipcMain.handle(
      'run-test',
      async (
        _event,
        params: { gcode: string[]; gcodeId: string; testDataId: string },
      ) => {
        const { gcode, gcodeId, testDataId } = params;
        deviceLogger.info(
          `Starting test run (gcodeId=${gcodeId}, testDataId=${testDataId})...`,
        );

        try {
          // Step 1: Open gcode file on firmware SD card with gcodeId
          deviceLogger.info(`Opening gcode file with id ${gcodeId}...`);
          const openAck = waitForBridgeEvent(
            this.bridge,
            'ack',
            5000,
            (command: number) => command === MSG_WRITE_TEST_MOVE,
          );
          // Send gcodeId as ASCII bytes to open the file
          const idBuf = Buffer.alloc(6, 0);
          idBuf.write(gcodeId.slice(0, 6), 0, 'ascii');
          this.bridge.writeTestMove(Array.from(idBuf));
          await openAck;

          // Step 2: Convert gcode lines to binary moves and upload in batches
          const lines = gcode.filter((line) => {
            const trimmed = line.trim();
            return trimmed !== '' && !trimmed.startsWith(';');
          });

          const moveBuffers: Buffer[] = [];
          for (const line of lines) {
            const move = parseGcodeToMove(line.trim());
            if (move) {
              moveBuffers.push(encodeMove(move));
            } else {
              deviceLogger.warn(`Skipping unparseable gcode line: ${line}`);
            }
          }

          deviceLogger.info(
            `Uploading ${moveBuffers.length} gcode moves in batches of ${BATCH_MOVE_COUNT}...`,
          );

          for (let i = 0; i < moveBuffers.length; i += BATCH_MOVE_COUNT) {
            const batch = moveBuffers.slice(
              i,
              Math.min(i + BATCH_MOVE_COUNT, moveBuffers.length),
            );
            const batchBuffer = Buffer.concat(batch);

            let success = false;
            let retryCount = 0;
            const maxRetries = 3;

            while (!success && retryCount < maxRetries) {
              try {
                const batchAck = waitForBridgeEvent(
                  this.bridge,
                  'ack',
                  5000,
                  (command: number) => command === MSG_WRITE_TEST_MOVE,
                );
                this.bridge.writeTestMove(Array.from(batchBuffer));
                await batchAck;
                success = true;
              } catch (error) {
                retryCount += 1;
                if (retryCount < maxRetries) {
                  deviceLogger.warn(
                    `Retrying gcode batch upload (attempt ${retryCount}/${maxRetries}) at index ${i}`,
                  );
                  await new Promise((resolve) => setTimeout(resolve, 1000));
                } else {
                  throw error;
                }
              }
            }
          }

          deviceLogger.info('Gcode upload complete. Starting test...');

          // Step 3: Start the test — send gcodeId + testDataId, firmware responds with ACK
          const testAck = waitForBridgeEvent(
            this.bridge,
            'ack',
            5000,
            (command: number) => command === MSG_WRITE_TEST_RUN,
          );
          this.bridge.writeTestRun(gcodeId, testDataId);
          await testAck;
          deviceLogger.info(
            `Test started: gcodeId=${gcodeId}, testDataId=${testDataId}`,
          );

          return { success: true, gcodeId, testDataId };
        } catch (error) {
          const errMsg =
            error instanceof Error ? error.message : 'Unknown error';
          deviceLogger.error(`Test failed: ${errMsg}`);
          return { success: false, error: errMsg, gcodeId: '', testDataId: '' };
        }
      },
    );

    // Download test data file from firmware SD card
    ipcMain.handle(
      'download-test-file',
      async (_event, params: { testName: string; savePath: string }) => {
        const { testName, savePath } = params;
        deviceLogger.info(
          `Starting file download: ${testName} -> ${savePath}`,
        );

        const SAMPLES_PER_REQUEST = 100;
        const MAX_NOT_READY_RETRIES = 80;
        const NOT_READY_RETRY_DELAY_MS = 100;

        try {
          const allSampleBuffers: Buffer[] = [];
          let sampleIndex = 0;
          let downloadedBinaryBytes = 0;
          let done = false;

          while (!done) {
            // Build binary request: testName(16) + sampleIndex(u32LE) + sampleCount(u32LE)
            const requestBuf = Buffer.alloc(24);
            requestBuf.fill(0);
            requestBuf.write(
              testName,
              0,
              Math.min(testName.length, 16),
              'utf-8',
            );
            requestBuf.writeUInt32LE(sampleIndex, 16);
            requestBuf.writeUInt32LE(SAMPLES_PER_REQUEST, 20);

            let response:
              | { kind: 'data'; chunk: Buffer }
              | { kind: 'nack' }
              | null = null;
            let notReadyRetries = 0;

            while (response === null) {
              this.bridge.writeFileDownload(Array.from(requestBuf));
              const next = await waitForDownloadChunkOrNack(this.bridge, 10000);

              if (next.kind === 'nack') {
                if (sampleIndex === 0 && notReadyRetries < MAX_NOT_READY_RETRIES) {
                  notReadyRetries += 1;
                  await new Promise((resolve) =>
                    setTimeout(resolve, NOT_READY_RETRY_DELAY_MS),
                  );
                  continue;
                }

                throw new Error('Test data not ready');
              }

              response = next;
            }

            const { chunk } = response;

            if (chunk.length === 0) {
              done = true;
            } else {
              allSampleBuffers.push(chunk);
              downloadedBinaryBytes += chunk.length;
              const samplesReceived = Math.floor(
                chunk.length / STOREDSAMPLE_WIRE_SIZE,
              );
              sampleIndex += samplesReceived;

              const progress: FileDownloadProgress = {
                fileName: testName,
                // Report actual binary payload bytes (not sample count).
                bytesDownloaded: downloadedBinaryBytes,
                // Unknown total until transfer ends.
                totalBytes: 0,
                status: 'downloading',
              };
              this.window.webContents.send(
                'file-download-progress',
                progress,
              );

              if (samplesReceived < SAMPLES_PER_REQUEST) {
                done = true;
              }
            }
          }

          const binaryData = Buffer.concat(allSampleBuffers);
          const csvContent = decodeBinarySampleDataToCSV(binaryData);
          fs.writeFileSync(savePath, csvContent);
          deviceLogger.info(
            `CSV saved to ${savePath} (${sampleIndex} samples, ${binaryData.length} binary bytes → ${csvContent.length} CSV bytes)`,
          );

          const completionProgress: FileDownloadProgress = {
            fileName: testName,
            bytesDownloaded: binaryData.length,
            totalBytes: binaryData.length,
            status: 'complete',
          };
          this.window.webContents.send(
            'file-download-progress',
            completionProgress,
          );

          return {
            success: true,
            filePath: savePath,
            fileSize: binaryData.length,
          };
        } catch (error) {
          const errMsg =
            error instanceof Error ? error.message : 'Unknown error';
          deviceLogger.error(`File download failed: ${errMsg}`);

          const errorProgress: FileDownloadProgress = {
            fileName: testName,
            bytesDownloaded: 0,
            totalBytes: 0,
            status: 'error',
            error: errMsg,
          };
          this.window.webContents.send(
            'file-download-progress',
            errorProgress,
          );

          return { success: false, error: errMsg };
        }
      },
    );

    ipcMain.handle('stream-gcode', async (_event, gcode: string) => {
      const lines = gcode.split('\n').filter((line) => {
        const trimmed = line.trim();
        return trimmed !== '' && !trimmed.startsWith(';');
      });

      try {
        const moveBuffers: Buffer[] = [];
        for (const line of lines) {
          const move = parseGcodeToMove(line.trim());
          if (move) {
            moveBuffers.push(encodeMove(move));
          } else {
            deviceLogger.warn(`Skipping unparseable gcode line: ${line}`);
          }
        }

        for (let i = 0; i < moveBuffers.length; i += BATCH_MOVE_COUNT) {
          const batch = moveBuffers.slice(
            i,
            Math.min(i + BATCH_MOVE_COUNT, moveBuffers.length),
          );
          const batchBuffer = Buffer.concat(batch);

          let success = false;
          let retryCount = 0;
          const maxRetries = 3;

          while (!success && retryCount < maxRetries) {
            try {
              const batchAck = waitForBridgeEvent(
                this.bridge,
                'ack',
                5000,
                (command: number) => command === MSG_WRITE_TEST_MOVE,
              );
              this.bridge.writeTestMove(Array.from(batchBuffer));
              await batchAck;
              success = true;
            } catch (error) {
              retryCount += 1;
              if (retryCount < maxRetries) {
                deviceLogger.warn(
                  `Retrying G-code batch (attempt ${retryCount}/${maxRetries}) at index ${i}`,
                );
                await new Promise((resolve) => setTimeout(resolve, 1000));
              } else {
                throw error;
              }
            }
          }
        }

        return { success: true };
      } catch (error) {
        deviceLogger.error('Error in G-code streaming:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    });

    ipcMain.handle('get-firmware-version', async () => {
      deviceLogger.info('Getting Firmware Version');
      const versionPromise = waitForBridgeEvent(
        this.bridge,
        'firmware-version',
        2000,
      );
      this.bridge.readFirmwareVersion();
      return versionPromise;
    });

    ipcMain.handle('flash-from-file', async () => {
      try {
        deviceLogger.info('Attempting to flash firmware from local file');
        const result = await showFirmwareFileDialog(this.window);

        if (!result) {
          return { success: false, error: 'No file selected' };
        }

        const firmwarePath = result;

        if (!fs.existsSync(firmwarePath)) {
          return { success: false, error: 'Selected file does not exist' };
        }

        const fileExtension = path.extname(firmwarePath).toLowerCase();
        if (fileExtension !== '.bin') {
          return {
            success: false,
            error: 'Invalid file type. Please select a .bin file.',
          };
        }

        return await this.flashFirmware(firmwarePath);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error occurred';
        deviceLogger.error(
          'Unhandled error in flash-from-file:',
          errorMessage,
        );
        return { success: false, error: errorMessage };
      }
    });

    ipcMain.handle('cancel-firmware-flash', async () => {
      if (this.currentFlashProcess) {
        try {
          deviceLogger.info('Canceling firmware flash process');
          this.currentFlashProcess.kill('SIGTERM');
          this.currentFlashProcess = null;
          this.sendProgressMessage('Firmware flashing canceled by user');
          return { success: true, message: 'Firmware flashing canceled' };
        } catch (error) {
          deviceLogger.error('Error canceling flash process:', error);
          return { success: false, error: 'Failed to cancel flash process' };
        }
      }
      return { success: false, error: 'No flash process running' };
    });
  }

  /**
   * Flash firmware to the device.
   */
  public async flashFirmware(
    firmwarePath: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.sendProgressMessage('Preparing to flash firmware...');

      const portPath = this.connectedPort;
      const baudRate = this.connectedBaud;

      if (!portPath) {
        return {
          success: false,
          error:
            'No serial port connected. Please connect to a port first before updating firmware.',
        };
      }

      // Disconnect bridge serial (but keep process alive)
      this.sendProgressMessage('Closing serial port before flashing...');
      try {
        this.bridge.unregisterPeriodicPolling();
        this.bridge.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 500));
        this.sendProgressMessage('Serial port closed successfully');
      } catch (closeErr) {
        deviceLogger.warn('Warning while closing serial port:', closeErr);
        this.sendProgressMessage(
          'Warning while closing serial port, continuing anyway...',
        );
      }

      // Get the loadp2 binary path
      const loadp2BinaryName = (() => {
        if (process.platform === 'win32') return 'loadp2.exe';
        if (process.platform === 'darwin') return 'loadp2.mac';
        return 'loadp2';
      })();
      const loadp2Path = path.join(process.cwd(), 'bin', loadp2BinaryName);

      if (!fs.existsSync(loadp2Path)) {
        return {
          success: false,
          error: `LoadP2 tool not found at ${loadp2Path}. Please make sure it's installed in the bin directory.`,
        };
      }

      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(loadp2Path, '755');
          this.sendProgressMessage(`Made ${loadp2Path} executable`);
        } catch (err) {
          deviceLogger.warn(`Unable to make ${loadp2Path} executable:`, err);
        }
      }

      const flashResult = await this.flashWithLoadP2(
        loadp2Path,
        firmwarePath,
        portPath,
      );

      // Reconnect after successful flash
      if (flashResult.success && portPath && baudRate) {
        this.sendProgressMessage(
          'Firmware flashed successfully. Reconnecting to device...',
        );
        try {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const connectPromise = waitForBridgeEvent(
            this.bridge,
            'connected',
            5000,
          );
          this.bridge.connect(portPath, baudRate);
          await connectPromise;
          this.bridge.registerPeriodicPolling();
          this.sendProgressMessage('Reconnected to device successfully');
        } catch (reconnectErr) {
          deviceLogger.warn('Warning while reconnecting:', reconnectErr);
          this.sendProgressMessage(
            'Note: Could not automatically reconnect. Please reconnect manually if needed.',
          );
        }
      }

      return flashResult;
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      deviceLogger.error('Error in firmware flashing:', error);
      return { success: false, error: `Error flashing firmware: ${error}` };
    }
  }

  /**
   * Flash firmware using LoadP2 with two-stage approach.
   */
  private flashWithLoadP2(
    loadp2Path: string,
    firmwarePath: string,
    port: string,
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      try {
        this.window.webContents.send(
          'firmware-update-progress',
          'Using LoadP2 tool to flash firmware in two stages...',
        );

        this.window.webContents.send('firmware-flash-status', {
          status: 'preparing',
          message: 'Preparing to flash firmware...',
        });

        // Validate firmware file
        try {
          const stats = fs.statSync(firmwarePath);
          this.window.webContents.send(
            'firmware-update-progress',
            `Firmware binary size: ${stats.size} bytes`,
          );

          if (stats.size === 0) {
            this.window.webContents.send('firmware-flash-status', {
              status: 'error',
              message: 'Firmware file is empty',
            });
            return resolve({
              success: false,
              error: 'Firmware binary file is empty',
            });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.window.webContents.send('firmware-flash-status', {
            status: 'error',
            message: `Error accessing firmware file: ${errorMsg}`,
          });
          return resolve({
            success: false,
            error: `Error accessing firmware binary: ${errorMsg}`,
          });
        }

        // Check flashloader
        const flashloaderPath = path.join(
          process.cwd(),
          'bin',
          'P2ES_flashloader.bin',
        );

        if (!fs.existsSync(flashloaderPath)) {
          this.window.webContents.send('firmware-flash-status', {
            status: 'error',
            message: `Flash loader not found at ${flashloaderPath}`,
          });
          return resolve({
            success: false,
            error: `Flash loader binary not found at ${flashloaderPath}`,
          });
        }

        try {
          const loaderStats = fs.statSync(flashloaderPath);
          this.window.webContents.send(
            'firmware-update-progress',
            `Flash loader size: ${loaderStats.size} bytes`,
          );
        } catch (err) {
          deviceLogger.warn(
            `Warning: Could not get flash loader file size: ${err}`,
          );
        }

        const twoStageCmd = `@0=${flashloaderPath},@8000+${firmwarePath}`;
        const cmdArgs = ['-b2000000', '-p', port, twoStageCmd];

        this.window.webContents.send(
          'firmware-update-progress',
          `Running command: ${loadp2Path} ${cmdArgs.join(' ')}`,
        );

        this.window.webContents.send('firmware-flash-status', {
          status: 'flashing',
          message: 'Firmware flashing in progress...',
        });

        const flashProcess = spawn(loadp2Path, cmdArgs);
        this.currentFlashProcess = flashProcess;

        let errorOutput = '';
        let processCompleted = false;

        const timeout = setTimeout(
          () => {
            if (!processCompleted && flashProcess && !flashProcess.killed) {
              deviceLogger.warn('Flash process timed out, killing process');
              flashProcess.kill('SIGKILL');
              this.currentFlashProcess = null;
              this.window.webContents.send('firmware-flash-status', {
                status: 'error',
                message: 'Firmware flashing timed out after 5 minutes',
              });
              resolve({
                success: false,
                error: 'Firmware flashing timed out after 5 minutes',
              });
            }
          },
          5 * 60 * 1000,
        );

        const cleanup = () => {
          processCompleted = true;
          clearTimeout(timeout);
          this.currentFlashProcess = null;
        };

        flashProcess.stdout.on('data', (data: Buffer) => {
          const message = data.toString();
          deviceLogger.info(`LoadP2 stdout: ${message}`);
          this.window.webContents.send('firmware-update-progress', message);
        });

        flashProcess.stderr.on('data', (data: Buffer) => {
          const message = data.toString();
          errorOutput += message;
          deviceLogger.error(`LoadP2 stderr: ${message}`);
          this.window.webContents.send('firmware-update-progress', message);
        });

        flashProcess.on('close', (code, signal) => {
          cleanup();
          deviceLogger.info(
            `LoadP2 process exited with code ${code}, signal ${signal}`,
          );

          if (signal === 'SIGTERM' || signal === 'SIGKILL') {
            this.window.webContents.send(
              'firmware-update-progress',
              'Firmware flashing was canceled',
            );
            this.window.webContents.send('firmware-flash-status', {
              status: 'canceled',
              message: 'Firmware flashing was canceled by user',
            });
            resolve({
              success: false,
              error: 'Firmware flashing was canceled',
            });
            return;
          }

          if (code === 0) {
            this.window.webContents.send(
              'firmware-update-progress',
              'Firmware binary flashed successfully using two-stage loader',
            );
            this.window.webContents.send('firmware-flash-status', {
              status: 'success',
              message: 'Firmware flashed successfully',
            });
            resolve({ success: true });
          } else {
            let errorMessage = `LoadP2 exited with code ${code}.`;

            if (errorOutput.includes('cannot open serial port')) {
              errorMessage =
                'Error: Cannot open serial port. The port may be in use or you may need permission to access it.';
            } else if (errorOutput.includes('No such file or directory')) {
              errorMessage = 'Error: Could not find the firmware file.';
            } else if (
              errorOutput.toLowerCase().includes('permission denied')
            ) {
              errorMessage =
                'Error: Permission denied when accessing the port.';
            } else {
              errorMessage += ` ${errorOutput}`;
            }

            this.window.webContents.send('firmware-flash-status', {
              status: 'error',
              message: errorMessage,
            });
            resolve({ success: false, error: errorMessage });
          }
        });

        flashProcess.on('error', (err) => {
          cleanup();
          const errorMsg = err instanceof Error ? err.message : String(err);
          deviceLogger.error('Error spawning LoadP2 tool:', errorMsg);

          this.window.webContents.send('firmware-flash-status', {
            status: 'error',
            message: `Failed to run LoadP2 tool: ${errorMsg}`,
          });
          resolve({
            success: false,
            error: `Failed to run LoadP2 tool: ${errorMsg}`,
          });
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        deviceLogger.error('Unexpected error in flashWithLoadP2:', errorMsg);
        this.window.webContents.send('firmware-flash-status', {
          status: 'error',
          message: `Unexpected error during flashing: ${errorMsg}`,
        });
        resolve({
          success: false,
          error: `Unexpected error during flashing: ${errorMsg}`,
        });
      }
    });
  }

  private sendProgressMessage(message: string): void {
    this.window.webContents.send('firmware-update-progress', message);
  }
}

export default DeviceInterface;
