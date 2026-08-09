/**
 * Headless verification harness - the primary test tool for this project.
 *
 * Boots the real server in-process, connects N clients that drive the real
 * client netcode with randomized input, runs an accelerated round, then prints
 * a report. Exits non-zero when anything looks wrong, so it doubles as CI.
 */
import {
  BUS_DURATION_TICKS,
  LOBBY_COUNTDOWN_TICKS,
  RECONCILE_EPSILON,
  ROUND_END_TICKS,
  ROUND_PHASE_NAMES,
  STORM_PHASES,
  TICK_MS,
  stormTotalTicks,
} from '@br/shared';
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

/**
 * Lobby countdown, bus ride, the whole storm and the victory screen.
 *
 * Derived rather than hardcoded so that retuning the storm or the bus keeps the
 * sim covering a complete round - a shorter default would stop before anyone
 * landed, and the combat and loot checks would have nothing to look at.
 */
function fullRoundSeconds(): number {
  const ticks = LOBBY_COUNTDOWN_TICKS + BUS_DURATION_TICKS + stormTotalTicks() + ROUND_END_TICKS;
  return Math.ceil((ticks * TICK_MS) / 1000);
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
    seconds: num('SIM_SECONDS', fullRoundSeconds()),
    // 4x leaves the tick loop ~12ms of budget against a sub-4ms tick. Faster
    // rounds start dropping ticks to container scheduling jitter, and a flaky
    // failure on the one signal that means "the server fell behind" is worse
    // than a slower run.
    timeScale: num('SIM_TIME_SCALE', 4),
    latencyMs: num('SIM_LATENCY_MS', 60),
    jitterMs: num('SIM_JITTER_MS', 20),
    lossPercent: num('SIM_LOSS_PCT', 0),
    seed: num('SIM_SEED', 0x5eed1234),
    verbose: process.env.SIM_VERBOSE === '1',
  };
}

/** Share of a round that may be lost to host scheduling before it counts. */
const MAX_DROPPED_TICK_FRACTION = 0.01;

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

  // Let every client finish the handshake and receive a first snapshot before
  // the measurement window opens.
  const handshakeDeadline = Date.now() + 5000;
  while (Date.now() < handshakeDeadline && clients.some((c) => !c.client.ready)) {
    await sleep(20);
  }

  server.resetStats();
  for (const client of clients) client.resetStats();
  await sleep((opts.seconds * 1000) / opts.timeScale);

  const liveError = measureLiveError(server, clients);
  // Sampled before teardown: closing a client removes its player from the world.
  const survivors = server.world.aliveCount;

  for (const client of clients) client.stop();
  await sleep(50);
  await server.stop();

  printReport(server, clients, opts, liveError, survivors);
}

/**
 * Distance between each client's predicted position and the server's
 * authoritative one, sampled while both are still running. Prediction runs
 * ahead of authority by roughly the latency, so a moving player is expected to
 * show a nonzero lead here; the number that must stay at zero is the
 * reconciliation error, which is what the client actually has to correct away.
 */
function measureLiveError(server: GameServer, clients: SimClient[]): number[] {
  const errors: number[] = [];
  for (const client of clients) {
    const player = server.world.players.get(client.playerId);
    if (player === undefined) continue;
    errors.push(client.positionErrorVersus(player.state.pos));
  }
  return errors;
}

function printReport(
  server: GameServer,
  clients: SimClient[],
  opts: SimOptions,
  liveError: number[],
  survivors: number,
): void {
  const stats = server.tickStats;
  const connected = clients.filter((c) => c.playerId !== 0);
  const clientErrors = clients.flatMap((c) => c.errors);
  const expectedTicks = opts.seconds * (1000 / TICK_MS);
  /** Wall-clock budget per tick once the round is played back accelerated. */
  const realIntervalMs = TICK_MS / opts.timeScale;

  const maxReconcileError = Math.max(0, ...connected.map((c) => c.maxPredictionError));
  const avgReconcileError = average(connected.map((c) => c.averagePredictionError));
  const reconciles = sum(connected.map((c) => c.reconciles));
  const corrections = sum(connected.map((c) => c.corrections));
  const snapshots = sum(connected.map((c) => c.snapshotsReceived));
  const undecodable = sum(connected.map((c) => c.snapshotsDropped));
  const stale = sum(connected.map((c) => c.client.snapshotsStale));
  const bytes = sum(connected.map((c) => c.bytesIn));
  const mapMismatches = connected.filter((c) => !c.mapHashMatches).length;
  const lootTaken = server.world.pickupCount;
  const landed = clients.filter((c) => c.landed).length;
  const droppedCommands = sum(
    [...server.world.players.values()].map((p) => p.droppedCommands),
  );

  console.log('server');
  console.log(`  ticks            ${stats.ticks} (expected ~${Math.round(expectedTicks)})`);
  console.log(`  avg tick         ${server.averageTickMs.toFixed(3)} ms`);
  console.log(`  max tick         ${stats.maxDurationMs.toFixed(3)} ms of ${realIntervalMs.toFixed(1)} ms budget`);
  console.log(`  dropped ticks    ${stats.droppedTicks} (host scheduling, not tick cost)`);
  console.log(`  input starvation ${server.world.starvationSteps} idle steps`);
  console.log(`  exceptions       ${server.errors.length}`);
  console.log('');

  console.log('clients');
  console.log(`  connected        ${connected.length}/${clients.length}`);
  console.log(
    `  avg rtt          ${(average(connected.map((c) => c.rttMs)) * opts.timeScale).toFixed(1)} ms`,
  );
  console.log(`  snapshots        ${snapshots} (${undecodable} undecodable, ${stale} stale)`);
  console.log(
    `  downstream       ${(bytes / opts.seconds / Math.max(1, connected.length) / 1024).toFixed(2)} KiB/s per client`,
  );
  console.log(`  visible peers    ${average(connected.map((c) => c.remoteCount)).toFixed(1)} avg`);
  console.log(`  map hash         ${mapMismatches === 0 ? 'all agree' : `${mapMismatches} MISMATCH`}`);
  console.log(`  exceptions       ${clientErrors.length}`);
  console.log('');

  const shots = sum(connected.map((c) => c.shotsFired));
  const hits = sum(connected.map((c) => c.hitsLanded));
  console.log('combat');
  console.log(`  shots fired      ${shots}`);
  console.log(`  hits landed      ${hits} (${percent(hits, shots)} of shots)`);
  console.log(`  eliminations     ${server.world.killCount}`);
  console.log(
    `  loot             ${server.world.pickupCount} picked up, ${server.world.loot.items.size} left on the ground`,
  );
  console.log('');

  const round = server.world.round.state;
  console.log('round');
  console.log(`  phase            ${ROUND_PHASE_NAMES[round.phase] ?? '?'}`);
  console.log(`  rounds finished  ${server.world.roundsPlayed}`);
  console.log(
    `  storm            phase ${Math.min(round.stormPhase + 1, STORM_PHASES)}/${STORM_PHASES}, radius ${round.stormRadius.toFixed(0)}`,
  );
  console.log(`  landed by drop   ${landed}/${connected.length}`);
  const modes = new Set<number>();
  for (const c of connected) for (const m of c.modesSeen) modes.add(m);
  console.log(`  modes observed   ${[...modes].sort().join(',')} (0 ground, 1 bus, 2 freefall, 3 glide)`);
  console.log(`  bus-carried ticks ${sum(connected.map((c) => c.client.predictor.busSnaps))}`);
  console.log(`  still alive      ${survivors}/${connected.length}`);
  console.log('');

  console.log('desync (client prediction vs server authority)');
  console.log(`  reconciliations  ${reconciles}`);
  console.log(`  corrections      ${corrections} (${percent(corrections, reconciles)})`);
  console.log(`  avg correction   ${avgReconcileError.toExponential(2)} units`);
  console.log(`  max correction   ${maxReconcileError.toExponential(2)} units`);
  console.log(`  flooded input    ${droppedCommands} commands dropped`);
  console.log(
    `  live lead        ${average(liveError).toFixed(3)} avg, ${Math.max(0, ...liveError).toFixed(3)} max units`,
  );
  // Includes the handshake, which the counters above deliberately exclude.
  const correctionTicks = connected.flatMap((c) => c.correctionTicks).sort((a, b) => a - b);
  console.log(
    `  since connect    ${correctionTicks.length} corrections` +
      (correctionTicks.length > 0 ? ` at ticks ${correctionTicks.slice(0, 12).join(', ')}` : ''),
  );
  console.log('');

  for (const c of connected.map((c) => c.worstCorrection).filter((c) => c !== null).slice(0, 3)) {
    console.log(`  worst: ${c}`);
  }

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
  // Whether the server can compute a tick inside its budget is the real
  // question, and `max tick` answers it directly. Dropped ticks at an
  // accelerated time scale mostly measure whether the host descheduled this
  // process, which is not a property of the server, so tolerate a few.
  if (stats.droppedTicks > expectedTicks * MAX_DROPPED_TICK_FRACTION) {
    problems.push(
      `${stats.droppedTicks} dropped ticks (over ${(MAX_DROPPED_TICK_FRACTION * 100).toFixed(0)}% of the round)`,
    );
  }
  if (stats.maxDurationMs > realIntervalMs) {
    problems.push(
      `slowest tick took ${stats.maxDurationMs.toFixed(1)}ms, over the ${realIntervalMs.toFixed(1)}ms budget`,
    );
  }
  if (stats.ticks < expectedTicks * 0.9) {
    problems.push(`only ${stats.ticks} of ~${Math.round(expectedTicks)} ticks ran`);
  }
  if (mapMismatches > 0) problems.push(`${mapMismatches} clients generated a different map`);
  if (undecodable > 0) problems.push(`${undecodable} snapshots could not be decoded`);
  if (reconciles === 0) problems.push('no reconciliations happened — clients never received state');
  if (shots === 0) problems.push('nobody fired a shot — combat never engaged');
  if (hits === 0) problems.push('no shot ever connected — hit detection or lag compensation is broken');
  if (lootTaken <= 0) problems.push('no loot was ever picked up');
  // A bot can legitimately be shot out of the sky, so only a complete absence
  // of landings means the drop is broken.
  if (connected.length > 0 && landed === 0) problems.push('nobody ever landed from the bus');
  // With no packet loss the prediction must reproduce the server exactly, so
  // any correction at all means the two simulations diverged.
  if (droppedCommands > 0) problems.push(`${droppedCommands} input commands dropped by the server`);
  if (opts.lossPercent === 0 && server.world.starvationSteps === 0 && maxReconcileError > RECONCILE_EPSILON) {
    problems.push(`prediction diverged by ${maxReconcileError.toExponential(2)} units with no packet loss`);
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

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

await main();
