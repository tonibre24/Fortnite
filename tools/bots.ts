/**
 * Fills a running server with simulated players, for benchmarking and for
 * eyeballing a busy scene. Drives the real client netcode, same as the sim.
 */
import { resolveServerUrl } from '@br/shared';
import { SimClient } from './SimClient.js';

const url = process.env.BOT_URL ?? resolveServerUrl({ protocol: 'http:', host: '127.0.0.1:8080' });
const count = Number(process.env.BOT_COUNT ?? 3);

const clients: SimClient[] = [];
for (let i = 0; i < count; i++) {
  clients.push(
    new SimClient({
      url,
      name: `bot-${i}`,
      seed: 1000 + i * 31,
      timeScale: 1,
      latencyMs: 40,
      jitterMs: 10,
      lossPercent: 0,
    }),
  );
}
for (const client of clients) client.start();
console.log(`${count} bots connecting to ${url}`);

const shutdown = (): void => {
  for (const client of clients) client.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
