import { defineConfig, type Plugin } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
import { existsSync } from 'node:fs';

const src = fileURLToPath(new URL('./src', import.meta.url));

/**
 * The protocol core's WebAssembly glue (src/wasm) exists only after
 * `npm run build:wasm`, and the Behaviour ledger job runs the suite without
 * it; the tests that reach it stand it in with `vi.mock`. Vitest 2 let such a
 * mock replace an import that resolved to nothing; Vitest 5 fails the import
 * first. When the glue has not been built, resolve its two imports to
 * themselves so the mock can answer them. Once built, nothing changes.
 */
function unbuiltWasmGlue(): Plugin {
  const glue = /(?:^@|[\\/]src)\/wasm\/protoemb_runtime(?:\.js|_bg\.wasm\?url)$/;
  return {
    name: 'mad-unbuilt-wasm-glue',
    enforce: 'pre',
    resolveId(id) {
      if (!glue.test(id) || existsSync(`${src}/wasm/protoemb_runtime.js`)) return null;
      return id.replace(/^.*[\\/]src\//, '@/');
    },
  };
}

// Separate from vite.config.ts so the PWA plugin doesn't run during tests.
export default defineConfig({
  plugins: [unbuiltWasmGlue()],
  resolve: {
    alias: {
      '@': src,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts', 'e2e/**/*.test.ts'],
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
