import { beforeEach, describe, expect, it } from 'vitest';
import {
  ColliderIndex,
  FIRE_RATE_GRACE_MS,
  FIXED_DT_MS,
  MAX_HEALTH,
  MAX_SHIELD,
  WEAPONS,
  fireIntervalMs,
  getArena,
} from '@riftfront/shared';
import { PlayerSimulation } from './PlayerSimulation.js';
import { PlayerState } from '../schema/PlayerState.js';

const arena = new ColliderIndex(getArena().colliders);
const RIFLE_INTERVAL = fireIntervalMs(WEAPONS.rifle);

function makeSim(nowMs = 1000): { sim: PlayerSimulation; state: PlayerState } {
  const sim = new PlayerSimulation('session-a', { x: 0, y: 5, z: 0 }, nowMs);
  const state = new PlayerState();
  state.id = 'session-a';
  state.alive = true;
  PlayerSimulation.resetVitals(state);
  sim.syncTo(state);
  return { sim, state };
}

describe('fire-rate validation', () => {
  let sim: PlayerSimulation;
  let now: number;

  beforeEach(() => {
    now = 1000;
    sim = makeSim(now).sim;
  });

  it('accepts the first shot', () => {
    expect(sim.tryConsumeShot(0, now, true, true, FIRE_RATE_GRACE_MS)).toBeNull();
  });

  it('rejects a second shot fired too soon', () => {
    sim.tryConsumeShot(0, now, true, true, FIRE_RATE_GRACE_MS);
    expect(sim.tryConsumeShot(1, now + 10, true, true, FIRE_RATE_GRACE_MS)).toBe('rateLimited');
  });

  it('accepts a shot once the weapon interval has elapsed', () => {
    sim.tryConsumeShot(0, now, true, true, FIRE_RATE_GRACE_MS);
    expect(sim.tryConsumeShot(1, now + RIFLE_INTERVAL, true, true, FIRE_RATE_GRACE_MS)).toBeNull();
  });

  it('allows only the configured grace window of jitter', () => {
    sim.tryConsumeShot(0, now, true, true, FIRE_RATE_GRACE_MS);
    const justInside = now + RIFLE_INTERVAL - FIRE_RATE_GRACE_MS + 0.5;
    expect(sim.tryConsumeShot(1, justInside, true, true, FIRE_RATE_GRACE_MS)).toBeNull();

    const sim2 = makeSim(now).sim;
    sim2.tryConsumeShot(0, now, true, true, FIRE_RATE_GRACE_MS);
    const justOutside = now + RIFLE_INTERVAL - FIRE_RATE_GRACE_MS - 1;
    expect(sim2.tryConsumeShot(1, justOutside, true, true, FIRE_RATE_GRACE_MS)).toBe('rateLimited');
  });

  it('caps the achievable rate at the weapon RPM under a spam attack', () => {
    let accepted = 0;
    // One simulated second of the client sending a fire message every millisecond.
    for (let ms = 0; ms < 1000; ms++) {
      if (sim.tryConsumeShot(ms, now + ms, true, true, FIRE_RATE_GRACE_MS) === null) accepted++;
    }
    const theoreticalMax = Math.ceil(1000 / (RIFLE_INTERVAL - FIRE_RATE_GRACE_MS)) + 1;
    expect(accepted).toBeLessThanOrEqual(theoreticalMax);
    expect(accepted).toBeLessThanOrEqual(WEAPONS.rifle.magazineSize);
  });

  it('rejects replayed and out-of-order shot sequences', () => {
    sim.tryConsumeShot(5, now, true, true, FIRE_RATE_GRACE_MS);
    expect(sim.tryConsumeShot(5, now + 10_000, true, true, FIRE_RATE_GRACE_MS)).toBe(
      'staleSequence',
    );
    expect(sim.tryConsumeShot(3, now + 20_000, true, true, FIRE_RATE_GRACE_MS)).toBe(
      'staleSequence',
    );
  });

  it('rejects shots while dead or outside a running match', () => {
    expect(sim.tryConsumeShot(1, now, false, true, FIRE_RATE_GRACE_MS)).toBe('notAlive');
    expect(sim.tryConsumeShot(1, now, true, false, FIRE_RATE_GRACE_MS)).toBe('matchNotRunning');
  });
});

describe('ammunition', () => {
  it('starts with a full magazine and reserve for both weapons', () => {
    const { sim } = makeSim();
    expect(sim.ammoFor('rifle')).toEqual({
      magazine: WEAPONS.rifle.magazineSize,
      reserve: WEAPONS.rifle.reserveAmmo,
    });
    expect(sim.ammoFor('shotgun')).toEqual({
      magazine: WEAPONS.shotgun.magazineSize,
      reserve: WEAPONS.shotgun.reserveAmmo,
    });
  });

  it('consumes one round per accepted shot and blocks on an empty magazine', () => {
    const { sim } = makeSim();
    let now = 1000;
    for (let i = 0; i < WEAPONS.rifle.magazineSize; i++) {
      expect(sim.tryConsumeShot(i, now, true, true, FIRE_RATE_GRACE_MS)).toBeNull();
      now += RIFLE_INTERVAL;
    }
    expect(sim.currentAmmo.magazine).toBe(0);
    expect(sim.tryConsumeShot(999, now, true, true, FIRE_RATE_GRACE_MS)).toBe('emptyMagazine');
  });

  it('tracks ammunition per weapon independently', () => {
    const { sim } = makeSim();
    sim.tryConsumeShot(0, 1000, true, true, FIRE_RATE_GRACE_MS);
    expect(sim.ammoFor('rifle').magazine).toBe(WEAPONS.rifle.magazineSize - 1);
    expect(sim.ammoFor('shotgun').magazine).toBe(WEAPONS.shotgun.magazineSize);
  });
});

describe('reloading', () => {
  it('refills the magazine from the reserve after the reload duration', () => {
    const { sim, state } = makeSim();
    let now = 1000;
    for (let i = 0; i < 10; i++) {
      sim.tryConsumeShot(i, now, true, true, FIRE_RATE_GRACE_MS);
      now += RIFLE_INTERVAL;
    }
    expect(sim.currentAmmo.magazine).toBe(WEAPONS.rifle.magazineSize - 10);

    expect(sim.tryStartReload(now, true, state)).toBeNull();
    expect(state.reloading).toBe(true);
    expect(state.reloadEndsAtMs).toBe(now + WEAPONS.rifle.reloadDurationMs);

    // Not finished a millisecond early.
    expect(sim.finishReloadIfDue(now + WEAPONS.rifle.reloadDurationMs - 1, state)).toBe(false);
    expect(sim.currentAmmo.magazine).toBe(WEAPONS.rifle.magazineSize - 10);

    expect(sim.finishReloadIfDue(now + WEAPONS.rifle.reloadDurationMs, state)).toBe(true);
    expect(sim.currentAmmo.magazine).toBe(WEAPONS.rifle.magazineSize);
    expect(sim.currentAmmo.reserve).toBe(WEAPONS.rifle.reserveAmmo - 10);
    expect(state.reloading).toBe(false);
  });

  it('refuses to reload a full magazine, while dead, or while already reloading', () => {
    const { sim, state } = makeSim();
    expect(sim.tryStartReload(1000, true, state)).toBe('magazineFull');
    expect(sim.tryStartReload(1000, false, state)).toBe('notAlive');

    sim.tryConsumeShot(0, 1000, true, true, FIRE_RATE_GRACE_MS);
    expect(sim.tryStartReload(2000, true, state)).toBeNull();
    expect(sim.tryStartReload(2001, true, state)).toBe('alreadyReloading');
  });

  it('refuses to reload with an empty reserve', () => {
    const { sim, state } = makeSim();
    const ammo = sim.ammoFor('rifle');
    ammo.reserve = 0;
    ammo.magazine = 1;
    expect(sim.tryStartReload(1000, true, state)).toBe('noReserve');
  });

  it('only transfers what the reserve still holds', () => {
    const { sim, state } = makeSim();
    const ammo = sim.ammoFor('rifle');
    ammo.magazine = 0;
    ammo.reserve = 4;
    sim.tryStartReload(1000, true, state);
    sim.finishReloadIfDue(1000 + WEAPONS.rifle.reloadDurationMs, state);
    expect(ammo.magazine).toBe(4);
    expect(ammo.reserve).toBe(0);
  });

  it('cancels a reload in progress', () => {
    const { sim, state } = makeSim();
    sim.tryConsumeShot(0, 1000, true, true, FIRE_RATE_GRACE_MS);
    sim.tryStartReload(2000, true, state);
    sim.cancelReload(state);
    expect(state.reloading).toBe(false);
    expect(state.reloadEndsAtMs).toBe(0);
  });
});

describe('input handling', () => {
  const command = (seq: number): Parameters<PlayerSimulation['enqueueInput']>[0][number] => ({
    seq,
    moveX: 0,
    moveZ: 1,
    yaw: 0,
    pitch: 0,
    buttons: 0,
  });

  it('drops replayed and out-of-order commands', () => {
    const { sim } = makeSim();
    expect(sim.enqueueInput([command(1), command(2), command(3)], 1000, 50)).toBe(3);
    expect(sim.enqueueInput([command(2), command(1)], 1000, 50)).toBe(0);
  });

  it('advances lastProcessedSeq only for simulated commands', () => {
    const { sim } = makeSim();
    sim.enqueueInput([command(1), command(2), command(3)], 1000, 50);
    sim.simulate(arena, 2, false);
    expect(sim.lastProcessedSeq).toBe(2);
    expect(sim.queuedInputCount).toBe(1);
  });

  it('caps how many commands one tick may consume', () => {
    const { sim } = makeSim();
    const many = Array.from({ length: 40 }, (_, i) => command(i + 1));
    sim.enqueueInput(many, 1000, 100);
    const result = sim.simulate(arena, 4, false);
    expect(result.processed).toBe(4);
  });

  it('throttles a client that floods commands faster than the simulation rate', () => {
    const { sim } = makeSim();
    let seq = 1;
    let accepted = 0;
    // Ten simulated seconds of a client sending 10x the legitimate command rate.
    for (let tick = 0; tick < 10_000; tick++) {
      const nowMs = 1000 + tick;
      accepted += sim.enqueueInput([command(seq++)], nowMs, 10_000);
    }
    const legitimateCommands = 10_000 / FIXED_DT_MS;
    expect(accepted).toBeLessThan(legitimateCommands * 2);
  });

  it('does not move a frozen (eliminated) player', () => {
    const { sim } = makeSim();
    const start = { ...sim.movement.position };
    sim.enqueueInput([command(1), command(2), command(3)], 1000, 50);
    sim.simulate(arena, 3, true);
    expect(sim.movement.position.x).toBe(start.x);
    expect(sim.movement.position.z).toBe(start.z);
  });
});

describe('respawn reset', () => {
  it('restores position, vitals, ammunition and weapon', () => {
    const { sim, state } = makeSim();
    // Damage the player and burn some ammo.
    state.health = 12;
    state.shield = 0;
    state.alive = false;
    sim.weaponId = 'shotgun';
    for (let i = 0; i < 3; i++) {
      sim.tryConsumeShot(i, 1000 + i * 2000, true, true, FIRE_RATE_GRACE_MS);
    }
    sim.enqueueInput([{ seq: 90, moveX: 0, moveZ: 1, yaw: 0, pitch: 0, buttons: 0 }], 1000, 50);

    sim.respawnAt({ x: 10, y: 1, z: -4 }, 5000);
    state.alive = true;
    PlayerSimulation.resetVitals(state);
    sim.syncTo(state);

    expect(sim.movement.position).toEqual({ x: 10, y: 1, z: -4 });
    expect(sim.movement.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(sim.weaponId).toBe('rifle');
    expect(sim.currentAmmo).toEqual({
      magazine: WEAPONS.rifle.magazineSize,
      reserve: WEAPONS.rifle.reserveAmmo,
    });
    expect(sim.queuedInputCount).toBe(0);
    expect(state.health).toBe(MAX_HEALTH);
    expect(state.shield).toBe(MAX_SHIELD);
    expect(state.reloading).toBe(false);
  });

  it('clears rewind history so a respawned player cannot be hit at their old position', () => {
    const { sim } = makeSim();
    sim.history.record(1000, { x: 0, y: 0, z: 0 }, true);
    sim.history.record(1050, { x: 1, y: 0, z: 0 }, true);
    sim.respawnAt({ x: 20, y: 0, z: 20 }, 2000);
    const sample = sim.history.sampleAt(1025);
    expect(sample?.position).toEqual({ x: 20, y: 0, z: 20 });
  });
});

describe('message budget', () => {
  it('eventually rejects a client that floods messages', () => {
    const { sim } = makeSim();
    let rejected = 0;
    for (let i = 0; i < 5000; i++) {
      if (!sim.allowMessage(1000)) rejected++;
    }
    expect(rejected).toBeGreaterThan(0);
    expect(sim.rejectedMessages).toBe(rejected);
  });
});
