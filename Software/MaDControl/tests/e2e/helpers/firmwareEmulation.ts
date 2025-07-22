import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

export class FirmwareEmulation {
  private socatProcess: ChildProcess | null = null;
  private mockSerialProcess: ChildProcess | null = null;
  private isRunning: boolean = false;

  constructor() {
    // Simple virtual serial port emulation without full firmware build
  }

  async setup(): Promise<void> {
    console.log('Setting up firmware emulation (simple mode)...');
    // No setup required for simple socat-based emulation
    console.log('Firmware emulation setup complete');
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Firmware emulation is already running');
      return;
    }

    console.log('Starting firmware emulation (virtual serial port only)...');
    
    // Kill any existing socat processes that might interfere
    try {
      await this.runCommand('pkill', ['-f', 'socat']);
    } catch (error) {
      // Ignore errors if no processes found
    }

    // Create virtual serial port pair using socat
    // This creates /tmp/tty.rpi_client and /tmp/tty.rpi
    const socatCommand = [
      '-d', '-d', 
      'pty,raw,echo=0,link=/tmp/tty.rpi_client',
      'pty,raw,echo=0,link=/tmp/tty.rpi'
    ];
    
    this.socatProcess = spawn('socat', socatCommand, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    });

    if (!this.socatProcess) {
      throw new Error('Failed to start socat process for virtual serial port');
    }

    this.isRunning = true;

    // Log output for debugging
    this.socatProcess.stdout?.on('data', (data) => {
      console.log(`Socat stdout: ${data.toString()}`);
    });

    this.socatProcess.stderr?.on('data', (data) => {
      console.log(`Socat stderr: ${data.toString()}`);
    });

    this.socatProcess.on('close', (code) => {
      console.log(`Socat process exited with code ${code}`);
      this.isRunning = false;
    });

    // Wait for the virtual serial port to be created
    await this.waitForSerialPort();

    // Start a simple mock serial responder
    await this.startMockSerialResponder();
  }

  private async startMockSerialResponder(): Promise<void> {
    console.log('Starting mock serial responder...');
    
    // Simple Python script to respond to serial commands
    const mockScript = `
import serial
import time
import sys

try:
    ser = serial.Serial('/tmp/tty.rpi', 9600, timeout=1)
    print("Mock serial responder connected to /tmp/tty.rpi")
    
    while True:
        try:
            if ser.in_waiting > 0:
                data = ser.readline().decode('utf-8').strip()
                print(f"Received: {data}")
                
                # Respond to common commands
                if data.startswith('AT'):
                    ser.write(b'OK\\n')
                elif data.startswith('INIT'):
                    ser.write(b'READY\\n')
                elif data.startswith('STATUS'):
                    ser.write(b'CONNECTED\\n')
                else:
                    ser.write(b'ACK\\n')
                    
            time.sleep(0.1)
        except Exception as e:
            print(f"Error: {e}")
            time.sleep(1)
            
except Exception as e:
    print(f"Failed to connect to serial port: {e}")
    sys.exit(1)
`;

    // Write the mock script to a temporary file
    const scriptPath = '/tmp/mock_serial.py';
    fs.writeFileSync(scriptPath, mockScript);

    // Start the mock serial responder
    this.mockSerialProcess = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    });

    if (!this.mockSerialProcess) {
      console.warn('Failed to start mock serial responder, but socat is running');
      return;
    }

    this.mockSerialProcess.stdout?.on('data', (data) => {
      console.log(`Mock serial stdout: ${data.toString()}`);
    });

    this.mockSerialProcess.stderr?.on('data', (data) => {
      console.log(`Mock serial stderr: ${data.toString()}`);
    });

    this.mockSerialProcess.on('close', (code) => {
      console.log(`Mock serial process exited with code ${code}`);
    });

    // Give it a moment to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('Mock serial responder started');
  }

  async stop(): Promise<void> {
    console.log('Stopping firmware emulation...');

    if (this.mockSerialProcess) {
      this.mockSerialProcess.kill('SIGTERM');
      this.mockSerialProcess = null;
    }
    
    if (this.socatProcess) {
      this.socatProcess.kill('SIGTERM');
      this.socatProcess = null;
    }

    // Clean up any remaining socat processes
    try {
      await this.runCommand('pkill', ['-f', 'socat']);
    } catch (error) {
      // Ignore errors if no processes found
    }

    // Clean up temporary files
    try {
      fs.unlinkSync('/tmp/mock_serial.py');
    } catch (error) {
      // Ignore if file doesn't exist
    }

    this.isRunning = false;
    console.log('Firmware emulation stopped');
  }

  getSerialPortPath(): string {
    return '/tmp/tty.rpi_client';
  }

  private async waitForSerialPort(): Promise<void> {
    const serialPortPath = this.getSerialPortPath();
    const maxWaitTime = 10000; // 10 seconds
    const checkInterval = 500; // 500ms
    let waited = 0;

    console.log(`Waiting for virtual serial port: ${serialPortPath}`);

    while (waited < maxWaitTime) {
      if (fs.existsSync(serialPortPath)) {
        console.log('Virtual serial port is ready');
        // Wait a bit more for the port to be fully ready
        await new Promise(resolve => setTimeout(resolve, 1000));
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waited += checkInterval;
    }

    throw new Error(`Virtual serial port not ready after ${maxWaitTime}ms`);
  }

  private runCommand(command: string, args: string[], cwd?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const process = spawn(command, args, { 
        cwd: cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      process.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`));
        }
      });

      process.on('error', (error) => {
        reject(error);
      });
    });
  }

  isEmulationRunning(): boolean {
    return this.isRunning && this.socatProcess !== null;
  }
}