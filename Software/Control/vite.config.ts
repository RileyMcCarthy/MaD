import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('./package.json') as { version: string };

// Build identity, surfaced in the session log so a bug report names the exact
// build it came from. A shallow CI checkout or a tarball has no git metadata,
// so a failure here is expected rather than fatal.
function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

// Frontend-only MaD control app. No backend: talks to the Propeller 2 over
// Web Serial and runs the protocol core (compiled from Rust) as WebAssembly.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __GIT_SHA__: JSON.stringify(gitSha()),
  },
  plugins: [
    react(),
    VitePWA({
      // Prompt, never auto-reload: this app holds a live hardware connection and
      // may be mid-test. A silent skipWaiting/clientsClaim reload would tear down
      // the worker that owns the serial port. We register manually (src/pwa.ts)
      // and only apply an update when idle/disconnected.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'MaD Control',
        short_name: 'MaD',
        description: 'MaD tensile-tester control (Web Serial + WASM)',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        icons: [],
      },
      workbox: {
        // The wasm + worker assets must be precached for offline use.
        globPatterns: ['**/*.{js,css,html,wasm,svg}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // Don't hijack the open page; the new SW waits until we apply it.
        skipWaiting: false,
        clientsClaim: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    // Hidden source maps: emitted for post-mortem debugging of a field issue,
    // but not referenced from the shipped bundle.
    sourcemap: 'hidden',
  },
  server: {
    port: 5174,
  },
});
