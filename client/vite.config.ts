import { defineConfig } from 'vite';
// Imported by path rather than through '@br/shared': Vite loads this config in
// Node and leaves bare specifiers to Node's resolver, which cannot read the
// workspace's TypeScript entry point. Relative imports get bundled instead.
import { DEFAULT_PORT } from '../shared/src/constants.js';
import { WS_PATH } from '../shared/src/net.js';

/**
 * Dev keeps two processes - Vite on 5173 for hot reload, the game server on
 * 8080 - but the client must not know that. Vite proxies the WebSocket path
 * through to the server, so the page talks to its own origin in dev exactly as
 * it does in production, and there is one code path instead of two.
 *
 * This target is the only place a backend host appears, and it never reaches
 * the browser bundle: it is dev-server config, and the proxy is what a reverse
 * proxy does for us in production.
 */
const devServerPort = Number(process.env.PORT ?? DEFAULT_PORT);

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      [WS_PATH]: {
        target: `ws://127.0.0.1:${devServerPort}`,
        ws: true,
        // Vite logs a noisy ECONNREFUSED spam loop if the game server is not up
        // yet; this keeps a restart of the server from killing the dev client.
        rewriteWsOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
