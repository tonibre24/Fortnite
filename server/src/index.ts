import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '@br/shared';
import { GameServer } from './GameServer.js';

const port = Number(process.env.PORT ?? DEFAULT_PORT);
const seed = process.env.SEED === undefined ? undefined : Number(process.env.SEED);

/**
 * The built client, if there is one.
 *
 * Resolved relative to this file so it works the same whether the server is run
 * from source with tsx (server/src) or compiled (server/dist). When the build
 * has not been run there is simply nothing to serve and the socket still works,
 * which is exactly the dev case where Vite owns the page.
 */
function findClientDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, '../../client/dist');
  return existsSync(candidate) ? candidate : undefined;
}

const clientDir = process.env.CLIENT_DIR ?? findClientDir();
const server = new GameServer({ port, seed, clientDir });

await server.start();
if (clientDir === undefined) {
  console.log('no built client found — run `npm run build` to serve the game from this port');
}

const shutdown = (signal: string): void => {
  console.log(`\n${signal} received, shutting down`);
  void server.stop().then(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
