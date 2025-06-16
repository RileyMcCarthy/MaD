import { ipcMain, BrowserWindow } from 'electron';
import EventEmitter from 'events';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  MachineState,
  SampleData,
  MachineConfiguration,
  Notification,
  NotificationType,
  FirmwareVersion,
} from '../../shared/SharedInterface';
import DataProcessor, { ReadType, WriteType } from './DataProcessor';
import NotificationSender from './NotificationSender';
import SerialPortHandler from './SerialPortHandler';
import {
  getLatestFirmwareVersion,
  downloadLatestArtifact,
} from '../utils/GithubDownloader';
import { showFirmwareFileDialog } from '../util';

function emitAndWaitForResponse(
  emitter: EventEmitter,
  emitEvent: string,
  responseEvent: string,
  timeout: number,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timeout error on ${responseEvent}`));
    }, timeout);

    emitter.once(responseEvent, (response) => {
      clearTimeout(timeoutId);
      resolve(response);
    });

    emitter.emit(emitEvent);
  });
}

function waitForResponse(
  emitter: EventEmitter,
  responseEvent: string,
  timeout: number,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timeout error on ${responseEvent}`)); // I think I need to pass something here, nuthing is returning undefined and im seconding it tostring after failed read of machineprofile after writing it...
    }, timeout);

    emitter.once(responseEvent, (response) => {
      clearTimeout(timeoutId);
      resolve(response);
    });
  });
}

class DeviceInterface {
  // Interface for handling device connections
  // also stores asyncronous data like state, data
  // will handle ack for retrying gcode messages etc
  private serialport: SerialPortHandler;

  private dataProcessor: DataProcessor;

  private notificationSender: NotificationSender;

  private sample_data_buffer: SampleData[] = [];

  private machine_state: MachineState | null = null;

  private machine_configuration: MachineConfiguration | null = null;

  private device_connected: boolean = false;

  private window: BrowserWindow;

  private sample_interval_ms: number;

  private last_sample_data_ms: number;

  private firmwareVersion: FirmwareVersion | null = null;

  constructor(
    dataProcessor: DataProcessor,
    notificationSender: NotificationSender,
    serialport: SerialPortHandler,
    window: BrowserWindow,
  ) {
    this.serialport = serialport;
    this.dataProcessor = dataProcessor;
    this.notificationSender = notificationSender;
    this.window = window;
    this.sample_interval_ms = 100;
    this.last_sample_data_ms = Date.now();

    // Periodic task to request SAMPLE every 100ms
    setInterval(() => {
      this.dataProcessor.readData(ReadType.SAMPLE);
      if (Date.now() - this.last_sample_data_ms > 1000) {
        this.device_connected = false;
      }
    }, this.sample_interval_ms);

    // Periodic task to request MACHINE_STATE every 100ms
    setInterval(() => {
      this.dataProcessor.readData(ReadType.STATE);
    }, 1000);

    ipcMain.handle('device-connect', async (event, portPath, baudRate) => {
      console.log('Attempting to connect to device');
      this.device_connected = false;

      try {
        await this.serialport.connect(portPath, baudRate);
        return waitForResponse(this.serialport, 'open-callback', 1000);
      } catch (error) {
        // Check if this is a "Canceled" error
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Canceled')) {
          console.warn('Caught "Canceled" error during device connect, handling gracefully');
          this.notificationSender.sendNotification({
            Type: NotificationType.WARN,
            Message: 'Connection was canceled. Please try again.',
          });
          return 'Connection was canceled. Please try again.';
        }

        // For other errors, rethrow
        throw error;
      }
    });

    ipcMain.handle('device-list-ports', async () => {
      return emitAndWaitForResponse(
        this.serialport,
        'list-ports',
        'available-ports',
        1000,
      );
    });

    ipcMain.handle('device-data-all', async () => {
      return this.sample_data_buffer;
    });

    ipcMain.handle('sample-data-latest', async () => {
      return this.sample_data_buffer[this.sample_data_buffer.length - 1];
    });

    ipcMain.handle('device-state', async () => {
      if (this.machine_state === null) {
        return null;
      }
      return this.machine_state;
    });

    ipcMain.handle('device-responding', async () => {
      return this.device_connected;
    });

    ipcMain.handle('device-connected', async () => {
      return this.serialport.getCurrentPath() !== null;
    });

    ipcMain.handle('get-machine-configuration', async () => {
      console.log('Getting Machine Configuration');
      this.dataProcessor.readData(ReadType.MACHINE_CONFIGURATION);
      return waitForResponse(ipcMain, 'machine-configuration-updated', 1000);
    });

    ipcMain.handle('save-machine-configuration', async (event, newConfig: MachineConfiguration) => {
        this.dataProcessor.writeData(
          WriteType.MACHINE_CONFIGURATION,
          Buffer.from(JSON.stringify(newConfig)),
        );
        console.log('Saving Machine Configuration: ', newConfig);
        return true;
      },
    );

    ipcMain.handle('set-motion-enabled', async (event, enabled: boolean) => {
      this.dataProcessor.writeData(
        WriteType.MOTION_ENABLE,
        Buffer.from(enabled ? '1' : '0'),
      );
      return waitForResponse(ipcMain, 'motion-enabled-ack', 1000);
    });

    ipcMain.handle('manual-move', async (event, mm: number, speed: number) => {
      // Using a simplified G-code like format for manual moves
      // The actual Move interface doesn't match what's used here, but this format works with the device
      const moveString = `{
        "G": 0,
        "X": ${mm.toFixed(6)},
        "F": ${speed.toFixed(6)},
        "P": 0
      }`;
      const incrementalMove = `{"G":91}`;
      this.dataProcessor.writeData(
        WriteType.MANUAL_MOVE,
        Buffer.from(incrementalMove),
      );
      this.dataProcessor.writeData(
        WriteType.MANUAL_MOVE,
        Buffer.from(moveString),
      );
      //return waitForResponse(ipcMain, 'motion-enabled-ack', 1000);
      return true;
    });

    ipcMain.handle('home', async (event) => {
      const homeMove = `{"G":28}`;
      this.dataProcessor.writeData(
        WriteType.MANUAL_MOVE,
        Buffer.from(homeMove),
      );
      return true;
    });

    ipcMain.handle('set_length_zero', async (event) => {
      this.dataProcessor.writeData(WriteType.GAUGE_LENGTH, Buffer.from([0]));
      return true;
    });

    ipcMain.handle('set_force_zero', async (event) => {
      this.dataProcessor.writeData(WriteType.GAUGE_FORCE, Buffer.from([0]));
      return true;
    });

    ipcMain.handle('run-test', async (event, { sampleProfile, gcode, testName }) => {
      //this.dataProcessor.writeData(WriteType.SAMPLE_PROFILE, Buffer.from(JSON.stringify(sampleProfile)));

      // Start test run (will clear gcode queue)
      this.dataProcessor.writeData(WriteType.TEST_RUN, Buffer.from(testName));

      // Wait for test run acknowledgment
      const testRunning = await waitForResponse(ipcMain, 'test-run-ack', 1000);
      if (!testRunning) {
        return false;
      }

      // Create a subprocess to stream G-code
      const streamGcode = async () => {
        try {
          // Stream each gcode line as JSON
          for (const line of gcode) {
            // Skip comments and blank lines
            const trimmedLine = line.trim();
            if (trimmedLine && !trimmedLine.startsWith(';')) {
              let success = false;
              let retryCount = 0;
              const maxRetries = 3;

              while (!success && retryCount < maxRetries) {
                this.dataProcessor.writeData(
                  WriteType.TEST_MOVE,
                  Buffer.from(trimmedLine),
                );
                // Wait for acknowledgment before sending next line
                const ack = await waitForResponse(ipcMain, 'test-move-ack', 1000);
                if (ack) {
                  success = true;
                } else {
                  retryCount++;
                  console.log(`Retrying G-code line (attempt ${retryCount}/${maxRetries}):`, trimmedLine);
                  // Wait a bit before retrying
                  await new Promise(resolve => setTimeout(resolve, 100));
                }
              }

              if (!success) {
                console.error(`Failed to send G-code line after ${maxRetries} attempts:`, trimmedLine);
                // You might want to handle this error case differently
                // For example, stopping the test or notifying the user
              }
            }
          }
        } catch (error) {
          console.error('Error in G-code streaming process:', error);
        }
        this.dataProcessor.writeData(WriteType.TEST_MOVE, Buffer.from('G144'));
      };

      // Start the G-code streaming process
      streamGcode().catch(console.error);

      return true;
    });

    // Firmware update related IPC handlers
    ipcMain.handle('get-firmware-version', async () => {
      try {
        // Request firmware version from device
        console.log('Getting Firmware Version');
        this.dataProcessor.readData(ReadType.FIRMWARE_VERSION);

        // Wait for response with timeout
        return await waitForResponse(ipcMain, 'firmware-version-response', 3000);
      } catch (error) {
        console.error('Error getting firmware version:', error);
        return null;
      }
    });

    ipcMain.handle('get-latest-firmware-version', async () => {
      try {
        // Hardcoded GitHub repo for firmware
        const firmwareRepo = 'RileyMcCarthy/MaD-Firmware';
        return await getLatestFirmwareVersion(firmwareRepo);
      } catch (error) {
        console.error('Error getting latest firmware version:', error);
        return null;
      }
    });

    ipcMain.handle('update-firmware', async () => {
      try {
        // Check if we have a connected port - require an existing connection
        const port = this.serialport.getCurrentPath();

        // If no port is connected, simply fail
        if (!port) {
          return {
            success: false,
            error: 'No serial port connected. Please connect to a port first before updating firmware.',
          };
        }

        // Log message if device not responding but continue anyway
        if (!this.device_connected) {
          this.window.webContents.send(
            'firmware-update-progress',
            'Device not responding, but will attempt firmware update anyway. This is normal for first-time flashing.'
          );
        }

        // Send notification that update is starting
        this.notificationSender.sendNotification({
          Type: NotificationType.INFO,
          Message: 'Starting firmware update process...',
        });

        // Hardcoded GitHub repo for firmware
        const firmwareRepo = 'RileyMcCarthy/MaD-Firmware';

        // Create a temp directory for firmware files
        const tempDir = path.join(os.tmpdir(), 'mad-firmware-update');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        // Download the latest firmware directly using downloadLatestArtifact
        let firmwareResult;
        try {
          firmwareResult = await downloadLatestArtifact({
            repoUrl: firmwareRepo,
            artifactExtension: '.bin',  // Prefer binary files for firmware
            outputDir: tempDir,
            window: this.window,
            progressEvent: 'firmware-update-progress',
            errorEvent: 'firmware-update-error'
          });
        } catch (downloadErr) {
          const errorMessage = downloadErr instanceof Error ? downloadErr.message : String(downloadErr);

          // Check if this is a rate limit error
          if (errorMessage.includes('rate limit exceeded') || errorMessage.includes('GitHub API request forbidden (403)')) {
            // Provide a helpful message about the direct link option
            const helpfulMessage = `GitHub API rate limit exceeded. You can try using a direct firmware link instead:

1. Go to: https://github.com/RileyMcCarthy/MaD-Firmware/releases
2. Download the .bin file manually
3. Use the "Flash from file" option in the application`;

            this.window.webContents.send(
              'firmware-update-error',
              helpfulMessage
            );
          }

          this.notificationSender.sendNotification({
            Type: NotificationType.ERROR,
            Message: `Firmware download failed: ${errorMessage}`,
          });
          return {
            success: false,
            error: `Failed to download firmware: ${errorMessage}`,
          };
        }

        if (!firmwareResult.success || !firmwareResult.filePath) {
          this.notificationSender.sendNotification({
            Type: NotificationType.ERROR,
            Message: `Firmware download failed: ${firmwareResult.error || 'Unknown error'}`,
          });
          return firmwareResult;
        }

        // Flash the firmware
        let flashResult;
        try {
          flashResult = await this.flashFirmware(firmwareResult.filePath);
        } catch (flashErr) {
          const errorMessage = flashErr instanceof Error ? flashErr.message : String(flashErr);
          this.notificationSender.sendNotification({
            Type: NotificationType.ERROR,
            Message: `Firmware flashing error: ${errorMessage}`,
          });
          return {
            success: false,
            error: `Error during firmware flashing: ${errorMessage}`,
          };
        } finally {
          // Clean up downloaded files
          try {
            this.cleanupTempDir(tempDir);
          } catch (cleanupErr) {
            console.warn('Failed to clean up temporary directory:', cleanupErr);
          }
        }

        if (flashResult.success) {
          this.notificationSender.sendNotification({
            Type: NotificationType.SUCCESS,
            Message: 'Firmware updated successfully!',
          });
        } else {
          this.notificationSender.sendNotification({
            Type: NotificationType.ERROR,
            Message: `Firmware update failed: ${flashResult.error}`,
          });
        }

        return flashResult;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('Unhandled error in update-firmware:', errorMessage);

        this.notificationSender.sendNotification({
          Type: NotificationType.ERROR,
          Message: `Firmware update error: ${errorMessage}`,
        });

        return {
          success: false,
          error: `Unexpected error: ${errorMessage}`,
        };
      }
    });

    // Add a new handler for flashing firmware from a local file
    ipcMain.handle('flash-from-file', async (event) => {
      console.log('Attempting to flash firmware from local file');
      try {
        // Show a file dialog to select the firmware file
        const firmwarePath = await showFirmwareFileDialog(this.window);

        // If user cancelled the dialog, return early
        if (!firmwarePath) {
          return {
            success: false,
            error: 'File selection was cancelled'
          };
        }

        this.notificationSender.sendNotification({
          Type: NotificationType.INFO,
          Message: `Preparing to flash firmware from ${firmwarePath}`,
        });

        // Send progress notification
        this.window.webContents.send(
          'firmware-update-progress',
          `Selected firmware file: ${firmwarePath}`,
        );

        // Flash the firmware using the selected file
        const flashResult = await this.flashFirmware(firmwarePath);

        if (flashResult.success) {
          this.notificationSender.sendNotification({
            Type: NotificationType.SUCCESS,
            Message: 'Firmware updated successfully from local file!',
          });
        } else {
          this.notificationSender.sendNotification({
            Type: NotificationType.ERROR,
            Message: `Firmware update failed: ${flashResult.error}`,
          });
        }

        return flashResult;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('Unhandled error in flash-from-file:', errorMessage);

        this.notificationSender.sendNotification({
          Type: NotificationType.ERROR,
          Message: `Firmware update error: ${errorMessage}`,
        });

        return {
          success: false,
          error: `Unexpected error: ${errorMessage}`,
        };
      }
    });

    // Handle command acks
    dataProcessor.on('ack', (command: WriteType, ack: boolean) => {
      console.log('motion enabled ack1',command, ack);
      this.device_connected = true;
      switch (command) {
        case WriteType.MACHINE_CONFIGURATION:
          // Machine configuration successfully updated and saved
          if (ack) {
            notificationSender.sendSuccess('Machine Profile Updated, Please reboot');
          } else {
            notificationSender.sendError('Failed to update machine profile');
          }
          break;
        case WriteType.MOTION_ENABLE:
          console.log('motion enabled ack', ack);
          ipcMain.emit('motion-enabled-ack', ack);
          if (!ack) {
            notificationSender.sendError(
              'Failed to enable motion, check machine conditions',
            );
          }
          break;
        case WriteType.TEST_RUN:
          // Test is running
          ipcMain.emit('test-run-ack', ack);
          if (ack) {
            notificationSender.sendSuccess('Test is now running');
          } else {
            notificationSender.sendError(
              'Failed to start test, make sure motion is enabled',
            );
          }
          break;
        case WriteType.MANUAL_MOVE:
          // Manual move queued
          if (!ack) {
            notificationSender.sendError(
              'Failed to queue manual move, make sure motion is enabled',
            );
          }
          break;
        case WriteType.TEST_MOVE:
          // Test move queued, should resend if failed
          ipcMain.emit('test-move-ack', ack);
          break;
        case WriteType.SAMPLE_PROFILE:
          // Sample profile set
          if (ack) {
            notificationSender.sendSuccess('Test is setup');
          } else {
            notificationSender.sendError('Test setup failed');
          }
          break;
        default:
      }
    });

    // Handle incomming data
    dataProcessor.on('data', (command: ReadType, data: string) => {
      this.device_connected = true;
      let dataJSON;
      try {
        dataJSON = JSON.parse(data);
      } catch (err) {
        console.log('failed to parse data', err);
        return;
      }
      switch (command) {
        case ReadType.SAMPLE:
          //console.log("Sample Data: ", data);
          this.last_sample_data_ms = Date.now();
          let sampleData = dataJSON as SampleData;
          this.sample_data_buffer.push(dataJSON as SampleData);
          if (this.sample_data_buffer.length > 100) {
            this.sample_data_buffer.shift();
          }
          this.window.webContents.send(
            'sample-data-updated',
            this.sample_data_buffer[this.sample_data_buffer.length - 1],
          );
          break;
        case ReadType.STATE:
          this.machine_state = dataJSON as MachineState;
          //console.log("machine state: ", this.machine_state);
          this.window.webContents.send(
            'machine-state-updated',
            this.machine_state,
          );
          break;
        case ReadType.MACHINE_CONFIGURATION:
          this.machine_configuration = dataJSON as MachineConfiguration;
          console.log("Machine Configuration", this.machine_configuration);
          ipcMain.emit(
            'machine-configuration-updated',
            this.machine_configuration,
          );
          break;
        case ReadType.FIRMWARE_VERSION:
          this.firmwareVersion = dataJSON as FirmwareVersion;
          ipcMain.emit('firmware-version-response', this.firmwareVersion.version);
          break;
        default:
      }
    });

    // Handle notifications
    dataProcessor.on('notification', (notification: Notification) => {
      this.device_connected = true;
      switch (notification.Type) {
        case NotificationType.ERROR:
          notificationSender.sendError(notification.Message);
          break;
        case NotificationType.WARN:
          notificationSender.sendWarning(notification.Message);
          break;
        case NotificationType.INFO:
          notificationSender.sendInfo(notification.Message);
          break;
        case NotificationType.SUCCESS:
          notificationSender.sendSuccess(notification.Message);
          break;
        default:
          console.log('message type unknown');
      }
    });
  }

  /**
   * Flash firmware to the device
   * @param firmwarePath Path to firmware file to flash
   */
  public async flashFirmware(firmwarePath: string): Promise<{ success: boolean; error?: string }> {
    try {
      this.sendProgressMessage('Preparing to flash firmware...');

      // Get the current port path and baud rate before disconnecting
      const portPath = this.serialport.getCurrentPath();
      const baudRate = this.serialport.getCurrentBaudRate();

      if (!portPath) {
        return {
          success: false,
          error: 'No serial port connected. Please connect to a port first before updating firmware.',
        };
      }

      // Close the serial port and wait for it to fully close
      this.sendProgressMessage('Closing serial port before flashing...');
      try {
        await this.serialport.disconnect();
        // Add a small delay to ensure the port is fully closed
        await new Promise(resolve => setTimeout(resolve, 500));
        this.sendProgressMessage('Serial port closed successfully');
      } catch (closeErr) {
        // Log the error but continue anyway - the port might already be closed
        console.warn('Warning while closing serial port:', closeErr);
        this.sendProgressMessage('Warning while closing serial port, continuing anyway...');
      }

      // Get the loadp2 binary path from the local bin directory
      const loadp2BinaryName = (() => {
        if (process.platform === 'win32') return 'loadp2.exe';
        if (process.platform === 'darwin') return 'loadp2.mac';
        return 'loadp2'; // Linux/others
      })();
      const loadp2Path = path.join(process.cwd(), 'bin', loadp2BinaryName);

      // Check if the loadp2 binary exists
      if (!fs.existsSync(loadp2Path)) {
        return {
          success: false,
          error: `LoadP2 tool not found at ${loadp2Path}. Please make sure it's installed in the bin directory.`,
        };
      }

      // Make sure the binary is executable (on Unix systems)
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(loadp2Path, '755');
          this.sendProgressMessage(`Made ${loadp2Path} executable`);
        } catch (err) {
          console.warn(`Unable to make ${loadp2Path} executable:`, err);
        }
      }

      // Flash the firmware
      const flashResult = await this.flashWithLoadP2(loadp2Path, firmwarePath, portPath);

      // Only attempt to reconnect if the flash was successful
      if (flashResult.success && portPath && baudRate) {
        this.sendProgressMessage('Firmware flashed successfully. Reconnecting to device...');
        try {
          // Wait a moment before reconnecting to give the device time to reboot
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Attempt to reconnect
          await this.serialport.connect(portPath, baudRate);
          this.sendProgressMessage('Reconnected to device successfully');
        } catch (reconnectErr) {
          // Log the error but don't fail the overall operation - flashing was successful
          console.warn('Warning while reconnecting:', reconnectErr);
          this.sendProgressMessage('Note: Could not automatically reconnect. Please reconnect manually if needed.');
        }
      }

      return flashResult;
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('Error in firmware flashing:', error);

      return {
        success: false,
        error: `Error flashing firmware: ${error}`,
      };
    }
  }

  /**
   * Flash firmware using the LoadP2 tool with a two-stage approach
   * First flashes the P2ES_flashloader.bin at address 0, then the actual firmware at address 0x8000
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
          `Using LoadP2 tool to flash firmware in two stages...`,
        );

        // First, check if the firmware file exists and has content
        try {
          const stats = fs.statSync(firmwarePath);
          this.window.webContents.send(
            'firmware-update-progress',
            `Firmware binary size: ${stats.size} bytes`,
          );

          if (stats.size === 0) {
            this.window.webContents.send(
              'firmware-update-error',
              'Error: Firmware file is empty',
            );
            return resolve({
              success: false,
              error: 'Firmware binary file is empty',
            });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.window.webContents.send(
            'firmware-update-error',
            `Error accessing firmware file: ${errorMsg}`,
          );
          return resolve({
            success: false,
            error: `Error accessing firmware binary: ${errorMsg}`,
          });
        }

        // Next, check if the flashloader exists
        const flashloaderPath = path.join(process.cwd(), 'bin', 'P2ES_flashloader.bin');

        if (!fs.existsSync(flashloaderPath)) {
          this.window.webContents.send(
            'firmware-update-error',
            `Error: Flash loader not found at ${flashloaderPath}`,
          );
          return resolve({
            success: false,
            error: `Flash loader binary not found at ${flashloaderPath}`,
          });
        }

        // Check the flash loader file size
        try {
          const loaderStats = fs.statSync(flashloaderPath);
          this.window.webContents.send(
            'firmware-update-progress',
            `Flash loader size: ${loaderStats.size} bytes`,
          );
        } catch (err) {
          // Just log this one, not critical
          console.warn(`Warning: Could not get flash loader file size: ${err}`);
        }

        // Construct the two-stage flash command
        // Format: @0=/path/to/flashloader.bin,@8000+/path/to/program.bin
        const twoStageCmd = `@0=${flashloaderPath},@8000+${firmwarePath}`;

        // Command to flash firmware with loadp2
        const cmdArgs = [
          '-b230400',  // Baud rate
          '-p', port,  // Port
          twoStageCmd, // Two-stage flash command
        ];

        this.window.webContents.send(
          'firmware-update-progress',
          `Running command: ${loadp2Path} ${cmdArgs.join(' ')}`,
        );

        const flashProcess = spawn(loadp2Path, cmdArgs);

        let output = '';
        let errorOutput = '';

        flashProcess.stdout.on('data', (data) => {
          const message = data.toString();
          output += message;
          console.log(`LoadP2 stdout: ${message}`);
          this.window.webContents.send('firmware-update-progress', message);
        });

        flashProcess.stderr.on('data', (data) => {
          const message = data.toString();
          errorOutput += message;
          console.error(`LoadP2 stderr: ${message}`);
          this.window.webContents.send('firmware-update-error', message);
        });

        flashProcess.on('close', (code) => {
          console.log(`LoadP2 process exited with code ${code}`);

          if (code === 0) {
            this.window.webContents.send(
              'firmware-update-progress',
              'Firmware binary flashed successfully using two-stage loader',
            );
            resolve({ success: true });
          } else {
            // Provide helpful error message based on the error output
            let errorMessage = `LoadP2 exited with code ${code}.`;

            if (errorOutput.includes('cannot open serial port')) {
              errorMessage = 'Error: Cannot open serial port. The port may be in use or you may need permission to access it.';
            } else if (errorOutput.includes('No such file or directory')) {
              errorMessage = 'Error: Could not find the firmware file.';
            } else if (errorOutput.toLowerCase().includes('permission denied')) {
              errorMessage = 'Error: Permission denied when accessing the port. Try running as administrator or change port permissions.';
            } else {
              errorMessage += ` ${errorOutput}`;
            }

            this.window.webContents.send(
              'firmware-update-error',
              errorMessage,
            );

            resolve({
              success: false,
              error: errorMessage,
            });
          }
        });

        flashProcess.on('error', (err) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error('Error spawning LoadP2 tool:', errorMsg);

          this.window.webContents.send(
            'firmware-update-error',
            `Failed to run LoadP2 tool: ${errorMsg}`,
          );

          resolve({
            success: false,
            error: `Failed to run LoadP2 tool: ${errorMsg}`,
          });
        });

      } catch (err) {
        // Handle any unexpected errors
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error('Unexpected error in flashWithLoadP2:', errorMsg);
        this.window.webContents.send(
          'firmware-update-error',
          `Unexpected error during flashing: ${errorMsg}`,
        );
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

  private cleanupTempDir(dirPath: string): void {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        this.sendProgressMessage(`Cleaned up temporary files in ${dirPath}`);
      }
    } catch (error) {
      console.error('Error cleaning up temp directory:', error);
    }
  }
}

export default DeviceInterface;
