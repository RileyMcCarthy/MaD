/**
 * Playwright Global Teardown
 * 
 * Cleans up any stale emulator processes after all tests complete.
 * NOTE: Each test manages its own emulator lifecycle via fixtures.ts.
 * This is just a safety net for orphaned processes.
 */

import { execSync } from 'child_process';
import path from 'path';

const EMULATOR_BIN = path.join(path.resolve(__dirname, '..'), 'target/debug/mad-emulator');

async function globalTeardown() {
  console.log('\n🧹 Global Teardown: Cleaning up stale processes...\n');

  // Kill any remaining Rust emulator processes (safety net). Match the full
  // binary path, not the bare substring, so unrelated processes are untouched.
  try {
    execSync(`pkill -f "${EMULATOR_BIN}" 2>/dev/null || true`, { stdio: 'ignore' });
  } catch {
    // Ignore errors - processes may already be dead
  }

  // Give processes time to clean up
  await new Promise((r) => setTimeout(r, 500));

  console.log('✅ Teardown complete\n');
}

export default globalTeardown;
