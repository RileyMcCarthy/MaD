import { SerialPort } from 'serialport';
import EventEmitter from 'events';
import { serialLogger } from '@utils/logger';
import * as fs from 'fs';

class SerialPortHandler extends EventEmitter {
  private port: SerialPort | null = null;

  async listPorts(): Promise<string[]> {
    try {
      const ports = await SerialPort.list();
      let portPaths = ports.map((port) => port.path);

      serialLogger.info('Raw ports detected:', portPaths);
      serialLogger.info('Platform:', process.platform);

      // On macOS, transform tty.* devices to cu.* devices for outgoing connections
      if (process.platform === 'darwin') {
        const transformedPorts: string[] = [];

        portPaths.forEach((ttyPath) => {
          if (ttyPath.includes('/dev/tty.')) {
            // Transform tty.* to cu.* for outgoing connections
            const deviceName = ttyPath.replace('/dev/tty.', '');
            const cuPath = `/dev/cu.${deviceName}`;

            // Check if the cu.* device actually exists
            if (fs.existsSync(cuPath)) {
              transformedPorts.push(cuPath);
              serialLogger.info(`Transformed ${ttyPath} to ${cuPath}`);
            } else {
              // If cu.* doesn't exist, keep the tty.* device
              transformedPorts.push(ttyPath);
              serialLogger.info(`Kept ${ttyPath} (no corresponding cu.* device found)`);
            }
          } else {
            // Keep non-tty devices as-is
            transformedPorts.push(ttyPath);
          }
        });

        portPaths = transformedPorts;
        serialLogger.info('macOS: Transformed tty.* devices to cu.* for outgoing connections');
        serialLogger.info('Final transformed ports:', portPaths);
      }

      serialLogger.info('Available ports:', portPaths);
      return portPaths;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      serialLogger.error('Failed to list serial ports:', errorMessage);
      return [];
    }
  }

  async connect(portPath: string, baudRate: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        if (this.port && this.port.isOpen) {
          this.port.close();
        }

        this.port = new SerialPort({
          path: portPath,
          baudRate,
        });

        this.port.on('open', () => {
          serialLogger.info(`Connected to ${portPath} at ${baudRate} baud`);
          this.emit('open', `Connected to ${portPath}`);
          this.emit('open-callback', `Connected to ${portPath}`);
          resolve();
        });

        this.port.on('data', (data: Buffer) => {
          this.emit('data', data);
        });

        this.port.on('close', () => {
          serialLogger.info('Serial port closed');
          this.emit('close', 'Serial port closed');
        });

        this.port.on('error', (error: Error) => {
          serialLogger.error('Serial port error:', error.message);
          this.emit('error', error);
          reject(error);
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        serialLogger.error('Failed to connect to serial port:', errorMessage);
        reject(new Error(errorMessage));
      }
    });
  }

  write_data(data: Buffer): void {
    if (this.port && this.port.isOpen) {
      this.port.write(data, (error) => {
        if (error) {
          serialLogger.error('Write error:', error.message);
          this.emit('error', error);
        }
      });
    } else {
      serialLogger.warn('Attempted to write to closed serial port');
    }
  }

  getCurrentPath(): string | null {
    return this.port?.path || null;
  }

  getCurrentBaudRate(): number | null {
    return this.port?.baudRate || null;
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.port && this.port.isOpen) {
        this.port.close((error) => {
          if (error) {
            serialLogger.error(
              'Error disconnecting serial port:',
              error.message,
            );
            reject(error);
          } else {
            serialLogger.info('Serial port disconnected successfully');
            resolve();
          }
        });
      } else {
        resolve(); // Already disconnected
      }
    });
  }

  close(): void {
    if (this.port && this.port.isOpen) {
      this.port.close((error) => {
        if (error) {
          serialLogger.error('Error closing serial port:', error.message);
        } else {
          serialLogger.info('Serial port closed successfully');
        }
      });
    }
  }
}

export default SerialPortHandler;
