import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

// Separate from vite.config.ts so the PWA plugin doesn't run during tests.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      // v8 here; the e2e run reports istanbul-shaped data from the browser.
      // The two are NOT merged per-file — see tools/merge-coverage.mjs for why
      // combining different instrumenters silently invents numbers.
      provider: 'v8',
      reporter: ['text', 'json'],
      reportsDirectory: 'coverage/unit',
      // Scoped to the firmware loader on purpose. This is the one part of the
      // app that can brick a board, and the bug we shipped there lived in the
      // gap between "protocol is 100% covered" and "the adapter that touches
      // Web Serial is untested". The gate exists to keep that gap closed;
      // widening it to all of src/ would just produce a number nobody trusts.
      include: ['src/firmware/**'],
      exclude: ['src/firmware/**/*.test.ts', 'src/firmware/golden/**'],
      thresholds: {
        lines: 90,
        functions: 100,
        branches: 70,
      },
    },
  },
});
