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
import os from 'os';

// Paths
const SIL_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(SIL_ROOT, '..');
const EMULATOR_BIN = path.join(SIL_ROOT, 'target/debug/mad-emulator');
const BRIDGE_DIR = path.join(PROJECT_ROOT, 'Protocol/ProtoEmb/runtime');
const BRIDGE_BIN = path.join(BRIDGE_DIR, 'target/debug/protoemb-bridge');
const MADCONTROL_DIR = path.join(PROJECT_ROOT, 'Software/MaDControl');
const MADCONTROL_MAIN = path.join(MADCONTROL_DIR, 'release/app/dist/main/main.js');
const SD_GCODE_DIR = path.join(SIL_ROOT, 'sd/gcode');
const SD_TEST_DIR = path.join(SIL_ROOT, 'sd/test');
const MADCONTROL_SETTINGS_PATH = path.join(
  os.homedir(),
  'Library/Application Support/MaD Control/settings.json',
);

// Export paths for use in tests
export const paths = {
  silRoot: SIL_ROOT,
  projectRoot: PROJECT_ROOT,
  emulatorBin: EMULATOR_BIN,
  bridgeDir: BRIDGE_DIR,
  bridgeBin: BRIDGE_BIN,
  madControlDir: MADCONTROL_DIR,
  madControlMain: MADCONTROL_MAIN,
};

async function globalSetup() {
  console.log('\n🚀 Global Setup: Preparing test environment...\n');

  // Ensure deterministic test naming and clean SD fixture state for this run.
  fs.mkdirSync(path.dirname(MADCONTROL_SETTINGS_PATH), { recursive: true });
  // Default to the same dataDir the app would pick on a fresh install
  // (see dataManager.initializeDataManager → app.getPath('documents')/MaDControl).
  let existingDataDir = path.join(os.homedir(), 'Documents', 'MaDControl');
  if (fs.existsSync(MADCONTROL_SETTINGS_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(MADCONTROL_SETTINGS_PATH, 'utf-8')) as {
        dataDir?: string;
      };
      if (typeof parsed.dataDir === 'string' && parsed.dataDir.length > 0) {
        existingDataDir = parsed.dataDir;
      }
    } catch {
      // ignore malformed settings and restore deterministic defaults
    }
  }

  fs.writeFileSync(
    MADCONTROL_SETTINGS_PATH,
    JSON.stringify(
      {
        dataDir: existingDataDir,
        testCounter: 0,
      },
      null,
      2,
    ),
  );

  for (const dir of [SD_GCODE_DIR, SD_TEST_DIR]) {
    if (!fs.existsSync(dir)) {
      continue;
    }

    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.bin')) {
        continue;
      }
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }

  // 0. Kill any stale emulator processes from previous runs
  try {
    execSync('pkill -f "mad-emulator" 2>/dev/null || true', { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    // Ignore errors - no processes to kill is fine
  }

  // 1. Ensure MaDControl is up to date for tests (both main + renderer).
  // We always rebuild both so renderer changes (e.g. TestRuns.tsx) are
  // picked up automatically without needing a separate manual step.
  if (!fs.existsSync(MADCONTROL_MAIN)) {
    console.log('📦 Building MaDControl (full build)...');
    execSync('npm run build', { cwd: MADCONTROL_DIR, stdio: 'inherit' });
  } else {
    console.log('📦 Refreshing MaDControl main + renderer builds...');
    execSync('npm run build', { cwd: MADCONTROL_DIR, stdio: 'inherit' });
  }

  // 2. Always rebuild firmware static library first so SIL reflects latest C changes
  console.log('🔧 Building firmware (native_emulator)...');
  execSync('pio run -e native_emulator', {
    cwd: path.join(PROJECT_ROOT, 'Firmware/MaDCore'),
    stdio: 'inherit',
  });

  // 3. Ensure Rust emulator is built against the latest firmware archive
  console.log('🔧 Building Rust emulator...');
  execSync('cargo build', { cwd: SIL_ROOT, stdio: 'inherit' });

  // 4. Ensure generic ProtoEmb bridge binary is built
  console.log('🔧 Building protoemb-bridge...');
  execSync('cargo build --bin protoemb-bridge', { cwd: BRIDGE_DIR, stdio: 'inherit' });

  if (!fs.existsSync(EMULATOR_BIN)) {
    throw new Error(`Emulator binary not found at ${EMULATOR_BIN}`);
  }

  if (!fs.existsSync(BRIDGE_BIN)) {
    throw new Error(`Bridge binary not found at ${BRIDGE_BIN}`);
  }

  console.log('✅ Prerequisites verified. Emulator will start per-test.\n');
}

export default globalSetup;
