import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

export class FirmwareEmulation {
  private socatProcess: ChildProcess | null = null;
  private firmwareProcess: ChildProcess | null = null;
  private isRunning: boolean = false;
  private firmwareEmulationPath: string;

  constructor() {
    // Use the actual firmware emulation makefile setup
    this.firmwareEmulationPath = path.resolve(__dirname, '../../../../../Firmware/MaDCore/Emulation');
  }

  async setup(): Promise<void> {
    console.log('Setting up firmware emulation using makefile...');
    
    // Use the makefile to setup venv and install dependencies
    await this.runCommand('make', ['venv'], this.firmwareEmulationPath);
    console.log('Firmware emulation setup complete');
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Firmware emulation is already running');
      return;
    }

    console.log('Starting firmware emulation...');
    
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

    // Log output for debugging
    this.socatProcess.stdout?.on('data', (data) => {
      console.log(`Socat stdout: ${data.toString()}`);
    });

    this.socatProcess.stderr?.on('data', (data) => {
      console.log(`Socat stderr: ${data.toString()}`);
    });

    this.socatProcess.on('close', (code) => {
      console.log(`Socat process exited with code ${code}`);
    });

    // Wait for the virtual serial port to be created
    await this.waitForSerialPort();

    // Start the actual firmware emulator using makefile
    await this.startFirmwareEmulator();
    
    this.isRunning = true;
  }

  private async startFirmwareEmulator(): Promise<void> {
    console.log('Starting firmware emulator...');
    
    // Use the makefile to run the firmware emulator
    this.firmwareProcess = spawn('make', ['run'], {
      cwd: this.firmwareEmulationPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    });

    if (!this.firmwareProcess) {
      console.warn('Failed to start firmware emulator, but socat is running');
      return;
    }

    this.firmwareProcess.stdout?.on('data', (data) => {
      console.log(`Firmware stdout: ${data.toString()}`);
    });

    this.firmwareProcess.stderr?.on('data', (data) => {
      console.log(`Firmware stderr: ${data.toString()}`);
    });

    this.firmwareProcess.on('close', (code) => {
      console.log(`Firmware process exited with code ${code}`);
    });

    // Give it a moment to start
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('Firmware emulator started');
  }

  async stop(): Promise<void> {
    console.log('Stopping firmware emulation...');

    if (this.firmwareProcess) {
      this.firmwareProcess.kill('SIGTERM');
      this.firmwareProcess = null;
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