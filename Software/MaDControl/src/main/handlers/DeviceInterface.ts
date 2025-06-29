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
} from '@shared/SharedInterface';
import DataProcessor, { ReadType, WriteType } from './DataProcessor';
import NotificationSender from './NotificationSender';
import SerialPortHandler from './SerialPortHandler';
import { showFirmwareFileDialog } from '../util';
import { deviceLogger } from '@utils/logger';

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

  private currentFlashProcess: any = null; // Track the current flashing process

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
      if (this.serialport.getCurrentPath()) {
        //deviceLogger.debug('Requesting sample data from device');
        this.dataProcessor.readData(ReadType.SAMPLE);
      }
      // Check if device stopped responding and emit event if status changed
      const now = Date.now();
      const wasResponding = this.device_connected;
      const isResponding = (now - this.last_sample_data_ms) <= 1000;

      if (wasResponding !== isResponding) {
        if (!isResponding && wasResponding) {
          deviceLogger.warn('Device stopped responding - no sample data received for >1 second');
        }
        this.device_connected = isResponding;

        // Emit event to notify frontend of responding status change
        this.window.webContents.send('device-status-updates', {
          responding: isResponding,
          connected: this.serialport.getCurrentPath() !== null,
          message: isResponding ? 'Device is responding' : 'Device stopped responding'
        });
      }
    }, this.sample_interval_ms);

    // Periodic task to request MACHINE_STATE every 100ms
    setInterval(() => {
      if (this.serialport.getCurrentPath()) {
        //deviceLogger.debug('Requesting machine state from device');
        this.dataProcessor.readData(ReadType.STATE);
      }
    }, 1000);

    ipcMain.handle('device-connect', async (_event, portPath, baudRate) => {
      deviceLogger.info('Attempting to connect to device');
      this.device_connected = false;

      try {
        await this.serialport.connect(portPath, baudRate);
        return `Connected to ${portPath}`;
      } catch (error) {
        // Check if this is a "Canceled" error
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Canceled')) {
          deviceLogger.warn('Caught "Canceled" error during device connect, handling gracefully');
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
      return await this.serialport.listPorts();
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
      console.log('🔍 DeviceInterface: device-responding handler called, returning:', this.device_connected);
      return this.device_connected;
    });

    ipcMain.handle('device-connected', async () => {
      const isConnected = this.serialport.getCurrentPath() !== null;
      console.log('🔍 DeviceInterface: device-connected handler called, port path:', this.serialport.getCurrentPath(), 'returning:', isConnected);
      return isConnected;
    });

    ipcMain.handle('get-machine-configuration', async () => {
      deviceLogger.info('Getting Machine Configuration');
      this.dataProcessor.readData(ReadType.MACHINE_CONFIGURATION);
      return waitForResponse(ipcMain, 'machine-configuration-updated', 1000);
    });

    ipcMain.handle('save-machine-configuration', async (_event, newConfig: MachineConfiguration) => {
        this.dataProcessor.writeData(
          WriteType.MACHINE_CONFIGURATION,
          Buffer.from(JSON.stringify(newConfig)),
        );
        deviceLogger.info('Saving Machine Configuration:', newConfig);
        return true;
      },
    );

    ipcMain.handle('set-motion-enabled', async (_event, enabled: boolean) => {
      this.dataProcessor.writeData(
        WriteType.MOTION_ENABLE,
        Buffer.from(enabled ? '1' : '0'),
      );
      return waitForResponse(ipcMain, 'motion-enabled-ack', 1000);
    });

    ipcMain.handle('manual-move', async (_event, mm: number, speed: number) => {
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
      return true;
    });

    ipcMain.handle('home-axis', async () => {
      this.dataProcessor.writeData(WriteType.MANUAL_MOVE, Buffer.from('{"G":28}'));
      return true;
    });

    ipcMain.handle('zero-force', async () => {
      this.dataProcessor.writeData(WriteType.GAUGE_FORCE, Buffer.from('0'));
      return true;
    });

    ipcMain.handle('stream-gcode', async (_event, gcode: string) => {
      const lines = gcode.split('\n').filter(line => line.trim() !== '');

      const streamGcode = async () => {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line === '') continue;

          let success = false;
          let retryCount = 0;
          const maxRetries = 3;

          while (!success && retryCount < maxRetries) {
            try {
              this.dataProcessor.writeData(WriteType.TEST_MOVE, Buffer.from(line));

              // Wait for acknowledgment with timeout
              await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                  reject(new Error('Timeout waiting for G-code acknowledgment'));
                }, 5000);

                const handleAck = () => {
                  clearTimeout(timeout);
                  resolve(undefined);
                };

                this.dataProcessor.once('ack', handleAck);
              });

              success = true;
            } catch (error) {
              retryCount++;
              if (retryCount < maxRetries) {
                deviceLogger.warn(`Retrying G-code line (attempt ${retryCount}/${maxRetries}):`, line);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
              } else {
                deviceLogger.error(`Failed to send G-code line after ${maxRetries} attempts:`, line);
                throw error;
              }
            }
          }
        }
      };

      try {
        await streamGcode();
        return { success: true };
      } catch (error) {
        deviceLogger.error('Error in G-code streaming process:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    ipcMain.handle('get-firmware-version', async () => {
      deviceLogger.info('Getting Firmware Version');
      this.dataProcessor.readData(ReadType.FIRMWARE_VERSION);
      return waitForResponse(ipcMain, 'firmware-version-updated', 1000);
    });

    ipcMain.handle('flash-from-file', async () => {
      try {
        deviceLogger.info('Attempting to flash firmware from local file');
        const result = await showFirmwareFileDialog(this.window);

        if (!result) {
          return {
            success: false,
            error: 'No file selected'
          };
        }

        const firmwarePath = result;

        // Validate file exists and has correct extension
        if (!fs.existsSync(firmwarePath)) {
          return {
            success: false,
            error: 'Selected file does not exist'
          };
        }

        const fileExtension = path.extname(firmwarePath).toLowerCase();
        if (fileExtension !== '.bin') {
          return {
            success: false,
            error: 'Invalid file type. Please select a .bin file.'
          };
        }

        // Flash the firmware
        const flashResult = await this.flashFirmware(firmwarePath);

        return flashResult;

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        deviceLogger.error('Unhandled error in flash-from-file:', errorMessage);
        return {
          success: false,
          error: errorMessage
        };
      }
    });

    // Add handler to cancel firmware flashing
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

    // Set up data processor event handlers
    this.dataProcessor.on('data', (data: SampleData) => {
      deviceLogger.debug('Received sample data from device:', data);
      this.sample_data_buffer.push(data);
      this.last_sample_data_ms = Date.now();
      const wasResponding = this.device_connected;
      this.device_connected = true;
      this.window.webContents.send('sample-data-updates', data);

      // Emit responding status if it changed from not responding to responding
      if (!wasResponding) {
        this.window.webContents.send('device-status-updates', {
          responding: true,
          connected: this.serialport.getCurrentPath() !== null,
          message: 'Device is responding'
        });
      }
    });

    this.dataProcessor.on('ack', (command: string, ack: boolean) => {
      deviceLogger.debug('Received ACK from device:', command, ack);
      if (command === 'MOTION_ENABLE') {
        deviceLogger.debug('motion enabled ack1', command, ack);
        ipcMain.emit('motion-enabled-ack', ack);
      }
    });

    this.dataProcessor.on('state', (state: MachineState) => {
      deviceLogger.debug('Received machine state from device:', state);
      this.machine_state = state;
      this.window.webContents.send('machine-state-updates', state);
    });

    this.dataProcessor.on('motion-enabled', (enabled: boolean) => {
      deviceLogger.debug('motion enabled ack', enabled);
      ipcMain.emit('motion-enabled-ack', enabled);
    });

    this.dataProcessor.on('machine-configuration', (config: MachineConfiguration) => {
      this.machine_configuration = config;
      this.window.webContents.send('machine-configuration-updates', config);
      ipcMain.emit('machine-configuration-updated', config);
    });

    this.dataProcessor.on('firmware-version', (version: FirmwareVersion) => {
      this.firmwareVersion = version;
      this.window.webContents.send('firmware-version-updates', version);
      ipcMain.emit('firmware-version-updated', version);
    });

    this.dataProcessor.on('notification', (notification: Notification) => {
      this.notificationSender.sendNotification(notification);
    });

    this.dataProcessor.on('unknown', (_type: string, _data: Buffer) => {
      deviceLogger.warn('Received unknown data type');
    });

    this.dataProcessor.on('sample-data', (data: SampleData) => {
      // deviceLogger.debug("Sample Data: ", data);
      this.sample_data_buffer.push(data);
      this.last_sample_data_ms = Date.now();
      const wasResponding = this.device_connected;
      this.device_connected = true;
      this.window.webContents.send('sample-data-updates', data);

      // Emit responding status if it changed from not responding to responding
      if (!wasResponding) {
        this.window.webContents.send('device-status-updates', {
          responding: true,
          connected: this.serialport.getCurrentPath() !== null,
          message: 'Device is responding'
        });
      }
    });

    this.dataProcessor.on('machine-state', (state: MachineState) => {
      this.machine_state = state;
      // deviceLogger.debug("machine state: ", this.machine_state);
      this.window.webContents.send('machine-state-updates', state);
    });

    this.dataProcessor.on('machine-configuration', (config: MachineConfiguration) => {
      this.machine_configuration = config;
      deviceLogger.info("Machine Configuration", this.machine_configuration);
      this.window.webContents.send('machine-configuration-updates', config);
      ipcMain.emit('machine-configuration-updated', config);
    });

    this.dataProcessor.on('firmware-version', (version: FirmwareVersion) => {
      this.firmwareVersion = version;
      this.window.webContents.send('firmware-version-updates', version);
      ipcMain.emit('firmware-version-updated', version);
    });

    this.dataProcessor.on('notification', (notification: Notification) => {
      this.notificationSender.sendNotification(notification);
    });

    this.dataProcessor.on('unknown', (_type: string, _data: Buffer) => {
      deviceLogger.info('message type unknown');
    });

    this.serialport.on('open', (message: string) => {
      console.log('🔌 DeviceInterface: Serial port opened, sending connection status:', message);
      this.window.webContents.send('device-status-updates', {
        connected: true,
        responding: this.device_connected,
        message,
      });
    });

    this.serialport.on('open-callback', (message: string) => {
      console.log('🔌 DeviceInterface: Serial port open-callback, sending connection status:', message);
      this.window.webContents.send('device-status-updates', {
        connected: true,
        responding: this.device_connected,
        message,
      });
    });

    this.serialport.on('close', (message: string) => {
      console.log('🔌 DeviceInterface: Serial port closed, sending connection status:', message);
      this.device_connected = false;
      this.window.webContents.send('device-status-updates', {
        connected: false,
        responding: false,
        message,
      });
    });

    this.serialport.on('error', (error: Error) => {
      console.log('🔌 DeviceInterface: Serial port error, sending connection status:', error.message);
      this.device_connected = false;
      this.window.webContents.send('device-status-updates', {
        connected: false,
        responding: false,
        message: error.message,
      });
    });

    // Handle cleanup when serial port is closed
    this.serialport.on('close', async () => {
      try {
        // Optional: Add any cleanup logic here
      } catch (closeErr) {
        deviceLogger.warn('Warning while closing serial port:', closeErr);
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
        deviceLogger.warn('Warning while closing serial port:', closeErr);
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
          deviceLogger.warn(`Unable to make ${loadp2Path} executable:`, err);
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
          deviceLogger.warn('Warning while reconnecting:', reconnectErr);
          this.sendProgressMessage('Note: Could not automatically reconnect. Please reconnect manually if needed.');
        }
      }

      return flashResult;
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      deviceLogger.error('Error in firmware flashing:', error);

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

        // Send flashing started event
        this.window.webContents.send('firmware-flash-status', {
          status: 'preparing',
          message: 'Preparing to flash firmware...'
        });

        // First, check if the firmware file exists and has content
        try {
          const stats = fs.statSync(firmwarePath);
          this.window.webContents.send(
            'firmware-update-progress',
            `Firmware binary size: ${stats.size} bytes`,
          );

          if (stats.size === 0) {
            this.window.webContents.send('firmware-flash-status', {
              status: 'error',
              message: 'Firmware file is empty'
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
            message: `Error accessing firmware file: ${errorMsg}`
          });
          return resolve({
            success: false,
            error: `Error accessing firmware binary: ${errorMsg}`,
          });
        }

        // Next, check if the flashloader exists
        const flashloaderPath = path.join(process.cwd(), 'bin', 'P2ES_flashloader.bin');

        if (!fs.existsSync(flashloaderPath)) {
          this.window.webContents.send('firmware-flash-status', {
            status: 'error',
            message: `Flash loader not found at ${flashloaderPath}`
          });
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
          deviceLogger.warn(`Warning: Could not get flash loader file size: ${err}`);
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

        // Send flashing started event
        this.window.webContents.send('firmware-flash-status', {
          status: 'flashing',
          message: 'Firmware flashing in progress...'
        });

        const flashProcess = spawn(loadp2Path, cmdArgs);
        this.currentFlashProcess = flashProcess; // Track the process

        let output = '';
        let errorOutput = '';
        let processCompleted = false;

        // Set up a timeout to kill the process if it hangs (5 minutes)
        const timeout = setTimeout(() => {
          if (!processCompleted && flashProcess && !flashProcess.killed) {
            deviceLogger.warn('Flash process timed out, killing process');
            flashProcess.kill('SIGKILL');
            this.currentFlashProcess = null;
            this.window.webContents.send('firmware-flash-status', {
              status: 'error',
              message: 'Firmware flashing timed out after 5 minutes'
            });
            resolve({
              success: false,
              error: 'Firmware flashing timed out after 5 minutes',
            });
          }
        }, 5 * 60 * 1000); // 5 minutes

        const cleanup = () => {
          processCompleted = true;
          clearTimeout(timeout);
          this.currentFlashProcess = null;
        };

        flashProcess.stdout.on('data', (data) => {
          const message = data.toString();
          output += message;
          deviceLogger.info(`LoadP2 stdout: ${message}`);
          this.window.webContents.send('firmware-update-progress', message);
        });

        flashProcess.stderr.on('data', (data) => {
          const message = data.toString();
          errorOutput += message;
          deviceLogger.error(`LoadP2 stderr: ${message}`);
          this.window.webContents.send('firmware-update-progress', message);
        });

        flashProcess.on('close', (code, signal) => {
          cleanup();
          deviceLogger.info(`LoadP2 process exited with code ${code}, signal ${signal}`);

          if (signal === 'SIGTERM' || signal === 'SIGKILL') {
            this.window.webContents.send(
              'firmware-update-progress',
              'Firmware flashing was canceled',
            );
            this.window.webContents.send('firmware-flash-status', {
              status: 'canceled',
              message: 'Firmware flashing was canceled by user'
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
              message: 'Firmware flashed successfully'
            });
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

            this.window.webContents.send('firmware-flash-status', {
              status: 'error',
              message: errorMessage
            });

            resolve({
              success: false,
              error: errorMessage,
            });
          }
        });

        flashProcess.on('error', (err) => {
          cleanup();
          const errorMsg = err instanceof Error ? err.message : String(err);
          deviceLogger.error('Error spawning LoadP2 tool:', errorMsg);

          this.window.webContents.send('firmware-flash-status', {
            status: 'error',
            message: `Failed to run LoadP2 tool: ${errorMsg}`
          });

          resolve({
            success: false,
            error: `Failed to run LoadP2 tool: ${errorMsg}`,
          });
        });

      } catch (err) {
        // Handle any unexpected errors
        const errorMsg = err instanceof Error ? err.message : String(err);
        deviceLogger.error('Unexpected error in flashWithLoadP2:', errorMsg);
        this.window.webContents.send('firmware-flash-status', {
          status: 'error',
          message: `Unexpected error during flashing: ${errorMsg}`
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

  private cleanupTempDir(dirPath: string): void {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        this.sendProgressMessage(`Cleaned up temporary files in ${dirPath}`);
      }
    } catch (error) {
      deviceLogger.error('Error cleaning up temp directory:', error);
    }
  }
}

export default DeviceInterface;
