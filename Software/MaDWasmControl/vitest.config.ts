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
  },
});
