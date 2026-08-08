/**
 * Headless verification harness - the primary test tool for this project.
 *
 * Boots the real server in-process, connects N clients that drive the real
 * client netcode with randomized input, runs an accelerated round, then prints
 * a report. Exits non-zero when anything looks wrong, so it doubles as CI.
 */
import { TICK_MS } from '@br/shared';
import { GameServer } from '../server/src/GameServer.js';
import { SimClient } from './SimClient.js';

interface SimOptions {
  clients: number;
  seconds: number;
  timeScale: number;
  latencyMs: number;
  jitterMs: number;
  lossPercent: number;
  seed: number;
  verbose: boolean;
}

function readOptions(): SimOptions {
  const num = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got "${raw}"`);
    return parsed;
  };
  return {
    clients: num('SIM_CLIENTS', 8),
    seconds: num('SIM_SECONDS', 20),
    timeScale: num('SIM_TIME_SCALE', 4),
    latencyMs: num('SIM_LATENCY_MS', 60),
    jitterMs: num('SIM_JITTER_MS', 20),
    lossPercent: num('SIM_LOSS_PCT', 0),
    seed: num('SIM_SEED', 0x5eed1234),
    verbose: process.env.SIM_VERBOSE === '1',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const opts = readOptions();
  const log = opts.verbose ? (m: string) => console.log(`  [server] ${m}`) : () => {};

  console.log('battle royale — simulated round');
  console.log(
    `  ${opts.clients} clients · ${opts.seconds}s round · ${opts.timeScale}x speed · ` +
      `${opts.latencyMs}±${opts.jitterMs}ms latency · ${opts.lossPercent}% loss`,
  );
  console.log('');

  const server = new GameServer({
    port: 0,
    seed: opts.seed,
    timeScale: opts.timeScale,
    log,
  });
  const port = await server.start();
  const url = `ws://127.0.0.1:${port}`;

  const clients: SimClient[] = [];
  for (let i = 0; i < opts.clients; i++) {
    clients.push(
      new SimClient({
        url,
        name: `sim-${i}`,
        seed: opts.seed + i * 7919,
        timeScale: opts.timeScale,
        latencyMs: opts.latencyMs,
        jitterMs: opts.jitterMs,
        lossPercent: opts.lossPercent,
      }),
    );
  }

  for (const client of clients) client.start();

  // Give every client a chance to complete the handshake before timing starts.
  const handshakeDeadline = Date.now() + 5000;
  while (Date.now() < handshakeDeadline && clients.some((c) => c.playerId === 0)) {
    await sleep(20);
  }

  // Everything measured from here on is the round proper, not process warm-up.
  server.resetStats();
  const wallClockMs = (opts.seconds * 1000) / opts.timeScale;
  await sleep(wallClockMs);

  for (const client of clients) client.stop();
  await sleep(50);
  await server.stop();

  printReport(server, clients, opts);
}

function printReport(server: GameServer, clients: SimClient[], opts: SimOptions): void {
  const stats = server.tickStats;
  const connected = clients.filter((c) => c.playerId !== 0);
  const clientErrors = clients.flatMap((c) => c.errors);

  const expectedTicks = opts.seconds * (1000 / TICK_MS);

  console.log('server');
  console.log(`  ticks            ${stats.ticks} (expected ~${Math.round(expectedTicks)})`);
  console.log(`  avg tick         ${server.averageTickMs.toFixed(3)} ms`);
  console.log(`  max tick         ${stats.maxDurationMs.toFixed(3)} ms`);
  console.log(`  dropped ticks    ${stats.droppedTicks}`);
  console.log(`  exceptions       ${server.errors.length}`);
  console.log('');

  console.log('clients');
  console.log(`  connected        ${connected.length}/${clients.length}`);
  const simRtt = average(connected.map((c) => c.rttMs)) * opts.timeScale;
  console.log(`  avg rtt          ${simRtt.toFixed(1)} ms (simulated)`);
  console.log(`  exceptions       ${clientErrors.length}`);
  console.log('');

  for (const err of server.errors.slice(0, 5)) {
    console.log(`server exception: ${err.message}\n${err.stack}`);
  }
  for (const err of clientErrors.slice(0, 5)) {
    console.log(`client exception: ${err}`);
  }

  const problems: string[] = [];
  if (server.errors.length > 0) problems.push(`${server.errors.length} server exceptions`);
  if (clientErrors.length > 0) problems.push(`${clientErrors.length} client exceptions`);
  if (connected.length < clients.length) {
    problems.push(`${clients.length - connected.length} clients failed to join`);
  }
  if (stats.droppedTicks > 0) problems.push(`${stats.droppedTicks} dropped ticks`);
  if (stats.ticks < expectedTicks * 0.9) {
    problems.push(`only ${stats.ticks} of ~${Math.round(expectedTicks)} ticks ran`);
  }

  if (problems.length === 0) {
    console.log('PASS — no problems detected');
  } else {
    console.log('FAIL');
    for (const p of problems) console.log(`  · ${p}`);
    process.exitCode = 1;
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

await main();
