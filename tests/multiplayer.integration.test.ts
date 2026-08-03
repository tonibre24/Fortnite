import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_HEALTH, MAX_SHIELD, PROTOCOL_VERSION } from '@riftfront/shared';
import { BotClient } from './helpers/BotClient.js';
import { Steerer } from './helpers/steering.js';
import { sleep, startTestServer, waitFor, type TestServerHandle } from './helpers/testServer.js';

/**
 * End-to-end multiplayer test.
 *
 * Boots the real server process, connects two real clients over WebSockets, drives them
 * with real inputs, fires real weapons and asserts that the authoritative server applied
 * damage and replicated it to both clients.
 */

let server: TestServerHandle;

beforeAll(async () => {
  server = await startTestServer({
    env: {
      RIFTFRONT_MIN_PLAYERS: '2',
      RIFTFRONT_COUNTDOWN_MS: '500',
      RIFTFRONT_MATCH_DURATION_MS: '120000',
      RIFTFRONT_RESPAWN_DELAY_MS: '1000',
    },
  });
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

async function createRoomCode(): Promise<string> {
  const response = await fetch(`${server.httpUrl}/api/rooms`, { method: 'POST' });
  expect(response.ok).toBe(true);
  const body = (await response.json()) as { code: string };
  return body.code;
}

/**
 * Drives both bots towards each other and has the attacker fire whenever the defender
 * is in range. Returns as soon as `stopWhen` holds, or when the time budget expires.
 */
async function engage(
  attacker: BotClient,
  defender: BotClient,
  durationMs: number,
  stopWhen: () => boolean,
): Promise<void> {
  const attackerSteering = new Steerer(attacker);
  const defenderSteering = new Steerer(defender);
  const tickMs = 16;
  const started = Date.now();
  let fireAccumulatorMs = 0;

  while (Date.now() - started < durationMs) {
    if (stopWhen()) return;

    const attackerSelf = attacker.self;
    const defenderSelf = defender.self;
    if (!attackerSelf || !defenderSelf) {
      await sleep(tickMs);
      continue;
    }

    const target = { x: defenderSelf.x, y: defenderSelf.y, z: defenderSelf.z };
    const from = { x: attackerSelf.x, y: attackerSelf.y, z: attackerSelf.z };

    const { distance } = attackerSteering.step(target, tickMs, 4);
    defenderSteering.step(from, tickMs, 6);

    // Fire at roughly the rifle's cadence; the server enforces the real rate.
    fireAccumulatorMs += tickMs;
    if (distance < 40 && fireAccumulatorMs >= 130) {
      fireAccumulatorMs = 0;
      const aimPoint = { x: target.x, y: target.y + 1.0, z: target.z };
      attackerSteering.aimAt(aimPoint);
      attacker.fireAt(aimPoint);
      if ((attacker.self?.magazine ?? 0) === 0) attacker.reload();
    }

    await sleep(tickMs);
  }
}

describe('two clients in one room', () => {
  it('completes a full join -> move -> shoot -> damage -> disconnect cycle', async () => {
    const code = await createRoomCode();
    expect(code).toMatch(/^[A-Z2-9]{5}$/);

    // --- 1. Both clients join the same room ---------------------------------
    const alpha = await BotClient.create(server.httpUrl, 'Alpha', code, 'create');
    const bravo = await BotClient.create(server.httpUrl, 'Bravo', code, 'join');

    try {
      await waitFor('both clients to see two players', () => alpha.state.players.size === 2);
      await waitFor('bravo to see two players', () => bravo.state.players.size === 2);

      expect(alpha.room.roomId).toBe(bravo.room.roomId);
      expect(alpha.state.roomCode).toBe(code);
      expect(alpha.events.welcome[0]?.protocolVersion).toBe(PROTOCOL_VERSION);

      const alphaNames = [...alpha.state.players.values()].map((p) => p.displayName).sort();
      expect(alphaNames).toEqual(['Alpha', 'Bravo']);

      // --- 2. The match reaches PLAYING ------------------------------------
      await waitFor('the match to start', () => alpha.state.phase === 'PLAYING', 20_000);
      expect(bravo.state.phase).toBe('PLAYING');

      // --- 3. Server-authoritative movement --------------------------------
      // Face the arena centre first: a bot walking blindly into a wall would be a bad
      // test, not a server bug. Spawns face outward-ish, so this guarantees open ground.
      const startAlpha = alpha.position;
      alpha.faceTowards({ x: 0, y: 0, z: 0 });
      for (let i = 0; i < 60; i++) {
        alpha.sendInput(0, 1, alpha.sprintButtons());
        await sleep(16);
      }
      await waitFor(
        'alpha to move under server simulation',
        () => Math.hypot(alpha.position.x - startAlpha.x, alpha.position.z - startAlpha.z) > 1,
        8_000,
      );

      // Movement is visible to the other client, i.e. state is synchronised.
      await waitFor(
        'bravo to observe alpha at the new position',
        () => {
          const alphaFromBravo = bravo.state.players.get(alpha.sessionId);
          if (!alphaFromBravo) return false;
          return (
            Math.hypot(alphaFromBravo.x - alpha.position.x, alphaFromBravo.z - alpha.position.z) <
            1.5
          );
        },
        8_000,
      );

      expect(alpha.self?.lastProcessedInputSeq).toBeGreaterThan(0);

      // --- 4. Firing and authoritative damage -------------------------------
      const bravoStartTotal = (bravo.self?.health ?? 0) + (bravo.self?.shield ?? 0);
      expect(bravoStartTotal).toBe(MAX_HEALTH + MAX_SHIELD);

      await engage(alpha, bravo, 75_000, () => alpha.events.kills.length > 0);

      expect(alpha.events.shots.length).toBeGreaterThan(0);
      expect(alpha.events.hits.length).toBeGreaterThan(0);

      const firstHit = alpha.events.hits[0];
      expect(firstHit.targetId).toBe(bravo.sessionId);
      expect(firstHit.damage).toBeGreaterThan(0);

      // Every shot broadcast carries one end point per pellet, for tracer rendering.
      const shot = alpha.events.shots[0];
      expect(shot.shooterId).toBe(alpha.sessionId);
      expect(shot.endPoints.length).toBeGreaterThan(0);
      expect(shot.endPoints.length).toBe(shot.impactNormals.length);

      // The victim was told it took damage, from the right attacker.
      await waitFor(
        'bravo to receive a damage event',
        () => bravo.events.damaged.length > 0,
        5_000,
      );
      expect(bravo.events.damaged[0].attackerId).toBe(alpha.sessionId);
      expect(bravo.events.damaged[0].attackerName).toBe('Alpha');

      // Both clients agree on the victim's vitals.
      await waitFor(
        'both clients to agree that bravo lost effective health',
        () => {
          const fromAlpha = alpha.state.players.get(bravo.sessionId);
          const fromBravo = bravo.self;
          if (!fromAlpha || !fromBravo) return false;
          const alphaTotal = fromAlpha.health + fromAlpha.shield;
          const bravoTotal = fromBravo.health + fromBravo.shield;
          return (
            alphaTotal === bravoTotal && (alphaTotal < bravoStartTotal || fromBravo.deaths > 0)
          );
        },
        8_000,
      );

      // Damage is credited on the server, not reported by the client.
      await waitFor(
        'the server to credit alpha with damage dealt',
        () => (alpha.self?.damageDealt ?? 0) > 0,
        5_000,
      );

      // --- 5. Elimination, scoring and respawn -----------------------------
      expect(alpha.events.kills.length).toBeGreaterThan(0);
      const kill = alpha.events.kills[0];
      expect(kill.attackerId).toBe(alpha.sessionId);
      expect(kill.victimId).toBe(bravo.sessionId);
      expect(kill.attackerName).toBe('Alpha');
      expect(kill.victimName).toBe('Bravo');

      // Both clients receive the same kill feed entry.
      await waitFor('bravo to see the kill feed entry', () => bravo.events.kills.length > 0, 5_000);
      expect(bravo.events.kills[0].victimId).toBe(bravo.sessionId);

      await waitFor(
        'the scoreboard to record the elimination',
        () => (alpha.self?.kills ?? 0) > 0 && (bravo.self?.deaths ?? 0) > 0,
        5_000,
      );

      // The victim comes back with full vitals and a fresh magazine.
      await waitFor(
        'bravo to respawn with restored vitals',
        () => {
          const self = bravo.self;
          return (
            self !== undefined &&
            self.alive &&
            self.health === MAX_HEALTH &&
            self.shield === MAX_SHIELD
          );
        },
        15_000,
      );
      expect(bravo.self?.magazine).toBe(30);

      // --- 6. Ammunition is server-owned ------------------------------------
      expect(alpha.self?.magazine).toBeLessThanOrEqual(30);
      expect(alpha.self?.magazine).toBeGreaterThanOrEqual(0);

      // --- 7. Clean disconnect leaves no ghost players ----------------------
      await bravo.leave();
      await waitFor('alpha to see bravo removed', () => alpha.state.players.size === 1, 8_000);
      expect(alpha.state.players.get(bravo.sessionId)).toBeUndefined();

      await alpha.leave();
    } finally {
      await alpha.leave().catch(() => undefined);
      await bravo.leave().catch(() => undefined);
    }
  }, 120_000);

  it('rejects a client using a different protocol version', async () => {
    const code = await createRoomCode();
    const host = await BotClient.create(server.httpUrl, 'Host', code, 'create');

    try {
      const { Client } = await import('colyseus.js');
      const stale = new Client(server.httpUrl);
      await expect(
        stale.join('match', {
          displayName: 'Stale',
          protocolVersion: PROTOCOL_VERSION + 1,
          roomCode: code,
        }),
      ).rejects.toThrow();
    } finally {
      await host.leave();
    }
  }, 30_000);

  it('reports a missing room instead of silently creating one', async () => {
    const response = await fetch(`${server.httpUrl}/api/rooms/ZZZZZ`);
    expect(response.status).toBe(404);

    const invalid = await fetch(`${server.httpUrl}/api/rooms/nope`);
    expect(invalid.status).toBe(400);

    const { Client } = await import('colyseus.js');
    const client = new Client(server.httpUrl);
    await expect(
      client.join('match', {
        displayName: 'Lost',
        protocolVersion: PROTOCOL_VERSION,
        roomCode: 'ZZZZZ',
      }),
    ).rejects.toThrow();
  }, 30_000);

  it('sanitises hostile display names before replicating them', async () => {
    const code = await createRoomCode();
    const bot = await BotClient.create(server.httpUrl, '<script>alert(1)</script>', code, 'create');

    try {
      await waitFor('the player to appear in state', () => bot.state.players.size === 1);
      const name = bot.self?.displayName ?? '';
      expect(name).not.toContain('<');
      expect(name).not.toContain('>');
      expect(name.length).toBeLessThanOrEqual(16);
    } finally {
      await bot.leave();
    }
  }, 30_000);
});
