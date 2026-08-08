import { DEFAULT_PORT } from '@br/shared';
import { GameServer } from './GameServer.js';

const port = Number(process.env.PORT ?? DEFAULT_PORT);
const seed = process.env.SEED === undefined ? undefined : Number(process.env.SEED);

const server = new GameServer({ port, seed });

await server.start();

const shutdown = (signal: string): void => {
  console.log(`\n${signal} received, shutting down`);
  void server.stop().then(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
