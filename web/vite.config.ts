import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const sharedEntry = fileURLToPath(
  new URL('../packages/shared/src/index.ts', import.meta.url),
);

export default defineConfig(({ mode }) => {
  // SERVER_URL: the shared backend this frontend proxies /api, /auth, /rooms and /ws to.
  // Read from the monorepo root .env (documented in .env.example) so the same file that
  // configures the server also drives the frontend; keep prod as the default.
  const env = loadEnv(mode, repoRoot, '');
  const SERVER_URL =
    process.env.SERVER_URL ?? env.SERVER_URL ?? 'http://localhost:3000';

  return {
    envDir: repoRoot,
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
  };
});
