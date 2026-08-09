import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The dev server proxies `/api` to the game server so the browser talks to a single
 * origin during development and no CORS configuration is needed locally.
 */
const SERVER_TARGET = process.env.VITE_SERVER_HTTP ?? 'http://localhost:2567';

export default defineConfig({
  resolve: {
    alias: {
      // Consume the shared package's TypeScript sources directly: Vite compiles them
      // with the app, so editing shared code hot-reloads without a rebuild step.
      '@riftfront/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: SERVER_TARGET, changeOrigin: true },
      '/health': { target: SERVER_TARGET, changeOrigin: true },
      '/matchmake': { target: SERVER_TARGET, changeOrigin: true, ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      input: {
        // The game, plus the scripted render benchmark. `bench.html` is a dev/CI tool
        // that shares the real renderer; it links nothing the game does not already ship.
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        bench: fileURLToPath(new URL('./bench.html', import.meta.url)),
      },
      output: {
        manualChunks: {
          // Babylon is by far the largest dependency; splitting it lets the browser
          // cache the engine across deploys of the game code.
          babylon: ['@babylonjs/core'],
        },
      },
    },
  },
});
