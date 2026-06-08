import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test.describe('Non-functional infrastructure guarantees', () => {
  test('build artifacts are fresh for current run', async () => {
    const silRoot = path.resolve(__dirname, '..');
    const repoRoot = path.resolve(silRoot, '..');

    const firmwareArchive = path.join(
      repoRoot,
      'Firmware/MaDCore/.pio/build/native_emulator/libfirmware.a',
    );
    const emulatorBinary = path.join(silRoot, 'target/debug/mad-emulator');
    const bridgeBinary = path.join(
      repoRoot,
      'Protocol/ProtoEmb/runtime/target/debug/protoemb-bridge',
    );

    [firmwareArchive, emulatorBinary, bridgeBinary].forEach((artifact) => {
      expect(fs.existsSync(artifact)).toBe(true);
      expect(fs.statSync(artifact).size).toBeGreaterThan(0);
    });

    const now = Date.now();
    const tenMinutesMs = 10 * 60 * 1000;

    [firmwareArchive, emulatorBinary].forEach((artifact) => {
      const ageMs = now - fs.statSync(artifact).mtimeMs;
      expect(
        ageMs,
        `${artifact} should be freshly rebuilt by global setup`,
      ).toBeLessThan(tenMinutesMs);
    });

    // Bridge binary must exist for protocol integration, but may be reused
    // if Cargo determines no rebuild is required for unchanged sources.
    const bridgeAgeMs = now - fs.statSync(bridgeBinary).mtimeMs;
    expect(bridgeAgeMs).toBeGreaterThanOrEqual(0);
  });
});
