/**
 * Playwright Global Setup
 * 
 * Prepares the test environment before any tests run:
 * 1. Ensures MaDControl is built
 * 2. Ensures Rust emulator is built (which also builds firmware)
 * 
 * NOTE: The emulator is started/stopped per-test by fixtures.ts for true isolation.
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

// Paths
const SIL_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(SIL_ROOT, '..');
const EMULATOR_BIN = path.join(SIL_ROOT, 'target/debug/mad-emulator');
const MADCONTROL_DIR = path.join(PROJECT_ROOT, 'Software/MaDControl');
const MADCONTROL_MAIN = path.join(MADCONTROL_DIR, 'release/app/dist/main/main.js');

// Export paths for use in tests
export const paths = {
  silRoot: SIL_ROOT,
  projectRoot: PROJECT_ROOT,
  emulatorBin: EMULATOR_BIN,
  madControlDir: MADCONTROL_DIR,
  madControlMain: MADCONTROL_MAIN,
};

async function globalSetup() {
  console.log('\n🚀 Global Setup: Preparing test environment...\n');

  // 0. Kill any stale emulator processes from previous runs
  try {
    execSync('pkill -f "mad-emulator" 2>/dev/null || true', { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    // Ignore errors - no processes to kill is fine
  }

  // 1. Ensure MaDControl is built
  if (!fs.existsSync(MADCONTROL_MAIN)) {
    console.log('📦 Building MaDControl...');
    execSync('npm run build', { cwd: MADCONTROL_DIR, stdio: 'inherit' });
  }

  // 2. Ensure Rust emulator is built (this also builds firmware via build.rs)
  console.log('🔧 Building Rust emulator...');
  execSync('cargo build', { cwd: SIL_ROOT, stdio: 'inherit' });

  if (!fs.existsSync(EMULATOR_BIN)) {
    throw new Error(`Emulator binary not found at ${EMULATOR_BIN}`);
  }

  console.log('✅ Prerequisites verified. Emulator will start per-test.\n');
}

export default globalSetup;
