/**
 * Playwright Global Setup
 * 
 * Prepares the test environment before any tests run:
 * 1. Ensures MaDControl is built
 * 2. Ensures firmware binary exists  
 * 3. Ensures Python venv exists
 * 
 * NOTE: The emulator is started/stopped per-test by fixtures.ts for true isolation.
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

// Paths
const SIL_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(SIL_ROOT, '..');
const FIRMWARE_BIN = path.join(SIL_ROOT, 'build/firmware/mad-firmware-native.bin');
const MADCONTROL_DIR = path.join(PROJECT_ROOT, 'Software/MaDControl');
const MADCONTROL_MAIN = path.join(MADCONTROL_DIR, 'release/app/dist/main/main.js');

// Export paths for use in tests
export const paths = {
  silRoot: SIL_ROOT,
  projectRoot: PROJECT_ROOT,
  firmwareBin: FIRMWARE_BIN,
  madControlDir: MADCONTROL_DIR,
  madControlMain: MADCONTROL_MAIN,
};

async function globalSetup() {
  console.log('\n🚀 Global Setup: Preparing test environment...\n');

  // 0. Kill any stale emulator processes from previous runs
  try {
    execSync('pkill -f "socat.*tty.rpi" 2>/dev/null || true', { stdio: 'ignore' });
    execSync('pkill -f "Server.py" 2>/dev/null || true', { stdio: 'ignore' });
    execSync('pkill -f "mad-firmware-native.bin" 2>/dev/null || true', { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    // Ignore errors - no processes to kill is fine
  }

  // 1. Ensure MaDControl is built
  if (!fs.existsSync(MADCONTROL_MAIN)) {
    console.log('📦 Building MaDControl...');
    execSync('npm run build', { cwd: MADCONTROL_DIR, stdio: 'inherit' });
  }

  // 2. Ensure firmware binary exists
  if (!fs.existsSync(FIRMWARE_BIN)) {
    console.log('🔧 Building firmware...');
    const fwDir = path.join(PROJECT_ROOT, 'Firmware/MaDCore');
    execSync('pio run -e native', { cwd: fwDir, stdio: 'inherit' });
    
    // Copy to SIL/build
    const srcBin = path.join(fwDir, '.pio/build/native/program');
    fs.mkdirSync(path.dirname(FIRMWARE_BIN), { recursive: true });
    fs.copyFileSync(srcBin, FIRMWARE_BIN);
    fs.chmodSync(FIRMWARE_BIN, 0o755);
  }

  // 3. Ensure Python venv exists
  const venvPython = path.join(SIL_ROOT, 'venv/bin/python3');
  if (!fs.existsSync(venvPython)) {
    console.log('🐍 Creating Python virtual environment...');
    execSync('python3 -m venv venv && venv/bin/pip install -r requirements.txt', { 
      cwd: SIL_ROOT, 
      stdio: 'inherit' 
    });
  }

  console.log('✅ Prerequisites verified. Emulator will start per-test.\n');
}

export default globalSetup;
