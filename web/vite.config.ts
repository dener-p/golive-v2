import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const sharedEntry = fileURLToPath(
  new URL('../packages/shared/src/index.ts', import.meta.url),
);
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:8787';

export default defineConfig({
  resolve: {
    alias: {
      '@golive/shared': sharedEntry,
    },
  },
  optimizeDeps: {
    exclude: ['@golive/shared'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': SERVER_URL,
      '/auth': SERVER_URL,
      '/rooms': SERVER_URL,
      '/ws': { target: SERVER_URL.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});