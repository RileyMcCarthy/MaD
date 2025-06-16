import { SerialPort } from 'serialport';
import { EventEmitter } from 'events';
import os from 'os';

class SerialPortHandler extends EventEmitter {
  private port: SerialPort | null = null;
  private currentPath: string | null = null;
  private currentBaudRate: number | null = null;

  constructor() {
    super();

    this.on('list-ports', async () => {
      const ports = await SerialPort.list();
      let portPaths = ports.map((port) => port.path);

      // On macOS, handle tty.* vs cu.* devices
      if (os.platform() === 'darwin') {
        // Create an array to hold the result
        const macPorts = [];

        for (const portPath of portPaths) {
          // If this is a tty.* device, generate the cu.* equivalent
          if (portPath.includes('/dev/tty.')) {
            const cuPath = portPath.replace('/dev/tty.', '/dev/cu.');
            // Add the cu.* path instead of the tty.* path
            macPorts.push(cuPath);
            console.log(`Converted ${portPath} to ${cuPath}`);
          } else {
            // For non-tty.* devices, keep them as is
            macPorts.push(portPath);
          }
        }

        // Replace the original array with our modified one
        portPaths = macPorts;
      }

      this.emit('available-ports', portPaths);
      console.log('Available ports:', portPaths);
    });
  }

  write_data(data: Buffer) {
    this.port?.write(data);
  }

  async connect(path: string, baudRate: number) {
    console.log('Connecting to port:', path, 'at baud rate:', baudRate);

    // On macOS, convert tty.* paths to cu.* for better compatibility
    if (os.platform() === 'darwin' && path.includes('/dev/tty.')) {
      const cuPath = path.replace('/dev/tty.', '/dev/cu.');
      console.log(`On macOS, converting ${path} to ${cuPath} for better compatibility`);
      path = cuPath;
    }

    // Store current connection details
    this.currentPath = path;
    this.currentBaudRate = baudRate;

    const openCallback = (err: any) => {
      if (err) {
        // Handle "Canceled" error specially
        if (err.message === 'Canceled') {
          console.warn('Ignoring "Canceled" error during connection');
          this.emit('open-callback', 'Connection canceled, please try again');
          return;
        }
        this.emit('open-callback', err.message);
      } else {
        this.emit(
          'open-callback',
          `Connected to port: ${path} at baud rate: ${baudRate}`,
        );
      }
    };

    // Disconnect from any existing port
    if (this.port && this.port.isOpen) {
      console.log('Disconnecting from existing port:', this.port.path);
      try {
        await new Promise<void>((resolve) => {
          this.port?.close((err) => {
            if (err) {
              console.error('Error closing port:', err.message);

              // If it's a 'Canceled' error, we can safely ignore it
              if (err.message === 'Canceled') {
                console.warn('Ignoring "Canceled" error, likely port already closing');
                this.emit('close', `Disconnected from port: ${this.port?.path}`);
                this.port = null; // Ensure the port reference is cleared
                resolve();
                return;
              }

              this.emit('error', err);
              // Don't reject, just log the error and continue with the new connection
              console.warn('Will attempt to connect anyway');
              resolve();
            } else {
              console.log('Port closed');
              this.emit('close', `Disconnected from port: ${this.port?.path}`);
              this.port = null; // Ensure the port reference is cleared
              resolve();
            }
          });
        });
      } catch (err) {
        // Even if disconnect fails, continue with the new connection attempt
        console.warn('Error during disconnect, but will attempt to connect anyway:', err);
        this.port = null; // Force clear the port reference
      }
    }

    // Make sure port is cleared before creating a new one
    if (this.port !== null) {
      this.port = null;
    }

    // Create new port instance
    try {
      // Wrap port creation in a try-catch to handle any immediate errors
      try {
        this.port = new SerialPort(
          {
            path,
            baudRate,
          },
          openCallback,
        );
      } catch (instantiationError) {
        // Handle any synchronous errors that might occur during SerialPort creation
        console.error('Error creating port instance:', instantiationError);

        // Handle "Canceled" error specifically
        if (instantiationError instanceof Error &&
            instantiationError.message === 'Canceled') {
          console.warn('Ignoring "Canceled" error during port creation');
          this.emit('open-callback', 'Connection canceled, please try again');
          return;
        }

        // For other errors, emit and rethrow
        this.emit('error', instantiationError);
        throw instantiationError;
      }

      // Set up event handlers for the new port
      this.port.on('open', () => {
        console.log('Port opened');
        this.emit('open', `Connected to port: ${path} at baud rate: ${baudRate}`);
      });

      this.port.on('data', (data: Buffer) => {
        this.emit('data', data);
      });

      this.port.on('error', (err: Error) => {
        console.error('Serial port error:', err.message);

        // Special handling for "Canceled" errors
        if (err.message === 'Canceled') {
          console.warn('Ignoring "Canceled" error in error handler');
          // Don't propagate the error event for "Canceled" errors
          return;
        }

        this.emit('error', err);
      });
    } catch (err) {
      console.error('Failed to create or setup serial port instance:', err);
      this.emit('error', err);
      throw err;
    }
  }

  // Get current serial port path
  getCurrentPath(): string | null {
    return this.currentPath;
  }

  // Get current baud rate
  getCurrentBaudRate(): number | null {
    return this.currentBaudRate;
  }

  // Disconnect from the current port
  disconnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.port && this.port.isOpen) {
        console.log('Disconnecting from port:', this.port.path);
        this.port.close((err) => {
          if (err) {
            console.error('Error closing port:', err.message);

            // If it's a 'Canceled' error, we can safely ignore it as it usually
            // happens when the port is already being closed or in an invalid state
            if (err.message === 'Canceled') {
              console.warn('Ignoring "Canceled" error, likely port already closing');
              this.emit('close', `Disconnected from port: ${this.currentPath}`);
              this.port = null; // Clear the port reference
              resolve();
              return;
            }

            this.emit('error', err);
            reject(err);
          } else {
            console.log('Port closed');
            this.emit('close', `Disconnected from port: ${this.currentPath}`);
            this.port = null; // Clear the port reference
            resolve();
          }
        });
      } else {
        console.log('No open port to disconnect from');
        resolve();
      }
    });
  }
}

export default SerialPortHandler;
