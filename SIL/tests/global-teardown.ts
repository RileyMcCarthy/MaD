/**
 * Playwright Global Teardown
 * 
 * Cleans up any stale emulator processes after all tests complete.
 * NOTE: Each test manages its own emulator lifecycle via fixtures.ts.
 * This is just a safety net for orphaned processes.
 */

import { execSync } from 'child_process';

async function globalTeardown() {
  console.log('\n🧹 Global Teardown: Cleaning up stale processes...\n');

  // Kill any remaining related processes (safety net)
  try {
    execSync('pkill -f "socat.*tty.rpi" 2>/dev/null || true', { stdio: 'ignore' });
    execSync('pkill -f "Server.py" 2>/dev/null || true', { stdio: 'ignore' });
    execSync('pkill -f "mad-firmware-native.bin" 2>/dev/null || true', { stdio: 'ignore' });
  } catch {
    // Ignore errors - processes may already be dead
  }

  // Give processes time to clean up
  await new Promise((r) => setTimeout(r, 500));

  console.log('✅ Teardown complete\n');
}

export default globalTeardown;
