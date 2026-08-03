import { describe, expect, it } from 'vitest';
import {
  ColliderIndex,
  LAG_COMPENSATION_MAX_MS,
  PLAYER_HEAD_HEIGHT,
  WEAPONS,
  computeHitDamage,
} from '@riftfront/shared';
import { PlayerSimulation } from './PlayerSimulation.js';
import { PlayerState } from '../schema/PlayerState.js';
import { applyHit, resolveFire, type CombatParticipant } from './CombatResolver.js';
import { PositionHistory, rewindAmountMs } from './LagCompensation.js';

const FLAT_WORLD = new ColliderIndex([
  { id: 'ground', min: { x: -60, y: -1, z: -60 }, max: { x: 60, y: 0, z: 60 } },
]);

function participant(
  id: string,
  position: { x: number; y: number; z: number },
  nowMs = 1000,
): CombatParticipant {
  const sim = new PlayerSimulation(id, position, nowMs);
  const state = new PlayerState();
  state.id = id;
  state.displayName = id;
  state.alive = true;
  PlayerSimulation.resetVitals(state);
  sim.history.record(nowMs, position, true);
  sim.syncTo(state);
  return { sim, state };
}

describe('resolveFire', () => {
  const nowMs = 1000;

  it('lands a rifle shot on a target straight ahead', () => {
    const shooter = participant('shooter', { x: 0, y: 0, z: 0 });
    const victim = participant('victim', { x: 0, y: 0, z: 12 });

    const resolution = resolveFire({
      shooter,
      others: [shooter, victim],
      index: FLAT_WORLD,
      nowMs,
      direction: { x: 0, y: 0, z: 1 },
      aiming: true,
      shotSeq: 1,
    });

    expect(resolution.hits).toHaveLength(1);
    expect(resolution.hits[0].targetId).toBe('victim');
    expect(resolution.hits[0].pellets).toBe(1);
  });

  it('never hits the shooter themselves', () => {
    const shooter = participant('shooter', { x: 0, y: 0, z: 0 });
    const resolution = resolveFire({
      shooter,
      others: [shooter],
      index: FLAT_WORLD,
      nowMs,
      direction: { x: 0, y: -0.9, z: 0.1 },
      aiming: false,
      shotSeq: 1,
    });
    expect(resolution.hits).toHaveLength(0);
  });

  it('aggregates shotgun pellets into a single hit per victim', () => {
    const shooter = participant('shooter', { x: 0, y: 0, z: 0 });
    shooter.sim.weaponId = 'shotgun';
    const victim = participant('victim', { x: 0, y: 0, z: 3 });

    const resolution = resolveFire({
      shooter,
      others: [shooter, victim],
      index: FLAT_WORLD,
      nowMs,
      direction: { x: 0, y: 0, z: 1 },
      aiming: true,
      shotSeq: 1,
    });

    expect(resolution.directions).toHaveLength(WEAPONS.shotgun.pelletCount);
    expect(resolution.hits).toHaveLength(1);

    const hit = resolution.hits[0];
    expect(hit.pellets).toBeGreaterThan(1);
    expect(hit.pellets).toBeLessThanOrEqual(WEAPONS.shotgun.pelletCount);
    // Aggregated damage equals the sum of the individual pellet damages.
    expect(hit.damage).toBeGreaterThanOrEqual(hit.pellets * 1);
    expect(hit.damage).toBeLessThanOrEqual(
      hit.pellets * computeHitDamage(WEAPONS.shotgun, 0, true),
    );
  });

  it('is deadly point blank and weak at range with the shotgun', () => {
    const fire = (distance: number): number => {
      const shooter = participant('shooter', { x: 0, y: 0, z: 0 });
      shooter.sim.weaponId = 'shotgun';
      const victim = participant('victim', { x: 0, y: 0, z: distance });
      const resolution = resolveFire({
        shooter,
        others: [shooter, victim],
        index: FLAT_WORLD,
        nowMs,
        direction: { x: 0, y: 0, z: 1 },
        aiming: true,
        shotSeq: 1,
      });
      return resolution.hits[0]?.damage ?? 0;
    };

    const close = fire(3);
    const far = fire(30);
    expect(close).toBeGreaterThan(far);
    expect(close).toBeGreaterThan(60);
  });

  it('skips dead targets and spawn-protected targets', () => {
    const shooter = participant('shooter', { x: 0, y: 0, z: 0 });
    const dead = participant('dead', { x: 0, y: 0, z: 8 });
    dead.state.alive = false;
    const protectedVictim = participant('protected', { x: 0, y: 0, z: 12 });
    protectedVictim.state.spawnProtectedUntilMs = nowMs + 1000;

    const resolution = resolveFire({
      shooter,
      others: [shooter, dead, protectedVictim],
      index: FLAT_WORLD,
      nowMs,
      direction: { x: 0, y: 0, z: 1 },
      aiming: true,
      shotSeq: 1,
    });
    expect(resolution.hits).toHaveLength(0);
  });

  it('is blocked by world geometry', () => {
    const walled = new ColliderIndex([
      { id: 'ground', min: { x: -60, y: -1, z: -60 }, max: { x: 60, y: 0, z: 60 } },
      { id: 'wall', min: { x: -4, y: 0, z: 5 }, max: { x: 4, y: 5, z: 6 } },
    ]);
    const shooter = participant('shooter', { x: 0, y: 0, z: 0 });
    const victim = participant('victim', { x: 0, y: 0, z: 12 });

    const resolution = resolveFire({
      shooter,
      others: [shooter, victim],
      index: walled,
      nowMs,
      direction: { x: 0, y: 0, z: 1 },
      aiming: true,
      shotSeq: 1,
    });
    expect(resolution.hits).toHaveLength(0);
    expect(resolution.impactNormals[0]).not.toBeNull();
  });

  it('registers a headshot when aiming at head height', () => {
    const shooter = participant('shooter', { x: 0, y: 0, z: 0 });
    const victim = participant('victim', { x: 0, y: 0, z: 10 });
    // Eye height is ~1.62; aim slightly down onto the head sphere at 1.55.
    const dy = PLAYER_HEAD_HEIGHT - 1.62;
    const resolution = resolveFire({
      shooter,
      others: [shooter, victim],
      index: FLAT_WORLD,
      nowMs,
      direction: { x: 0, y: dy / 10, z: 1 },
      aiming: true,
      shotSeq: 1,
    });
    expect(resolution.hits[0]?.headshot).toBe(true);
    expect(resolution.hits[0]?.damage).toBe(computeHitDamage(WEAPONS.rifle, 10, true));
  });

  it('rewinds a moving target to where the shooter saw it', () => {
    const shooter = participant('shooter', { x: 0, y: 0, z: 0 });
    shooter.sim.rttMs = 200;

    // Victim was in the line of fire 150 ms ago and has since strafed away.
    const victim = participant('victim', { x: 0, y: 0, z: 12 });
    victim.sim.history.clear();
    victim.sim.history.record(nowMs - 200, { x: 0, y: 0, z: 12 }, true);
    victim.sim.history.record(nowMs, { x: 9, y: 0, z: 12 }, true);
    victim.sim.movement.position = { x: 9, y: 0, z: 12 };

    const resolution = resolveFire({
      shooter,
      others: [shooter, victim],
      index: FLAT_WORLD,
      nowMs,
      direction: { x: 0, y: 0, z: 1 },
      aiming: true,
      shotSeq: 1,
    });

    expect(resolution.rewindMs).toBeGreaterThan(0);
    expect(resolution.hits).toHaveLength(1);
  });

  it('does not rewind further than the configured cap', () => {
    expect(rewindAmountMs(10_000, 100)).toBe(LAG_COMPENSATION_MAX_MS);
    expect(rewindAmountMs(0, 0)).toBe(0);
  });
});

describe('applyHit', () => {
  const hit = {
    targetId: 'victim',
    damage: 60,
    headshot: false,
    pellets: 1,
    point: { x: 0, y: 1, z: 1 },
  };

  it('spends shield before health', () => {
    const victim = participant('victim', { x: 0, y: 0, z: 0 }).state;
    const applied = applyHit(hit, victim, 1000);
    expect(applied?.shield).toBe(0);
    expect(applied?.health).toBe(90);
    expect(applied?.killed).toBe(false);
  });

  it('returns null for an already-eliminated victim, preventing double kills', () => {
    const victim = participant('victim', { x: 0, y: 0, z: 0 }).state;
    victim.alive = false;
    expect(applyHit(hit, victim, 1000)).toBeNull();
  });

  it('returns null while the victim has spawn protection', () => {
    const victim = participant('victim', { x: 0, y: 0, z: 0 }).state;
    victim.spawnProtectedUntilMs = 2000;
    expect(applyHit(hit, victim, 1000)).toBeNull();
  });

  it('reports a kill when the final hit lands', () => {
    const victim = participant('victim', { x: 0, y: 0, z: 0 }).state;
    victim.shield = 0;
    victim.health = 20;
    const applied = applyHit({ ...hit, damage: 25 }, victim, 1000);
    expect(applied?.killed).toBe(true);
    expect(applied?.damage).toBe(20);
  });
});

describe('PositionHistory', () => {
  it('interpolates between recorded samples', () => {
    const history = new PositionHistory();
    history.record(1000, { x: 0, y: 0, z: 0 }, true);
    history.record(1100, { x: 10, y: 0, z: 0 }, true);
    const sample = history.sampleAt(1050);
    expect(sample?.position.x).toBeCloseTo(5, 6);
  });

  it('clamps to the newest sample for future times', () => {
    const history = new PositionHistory();
    history.record(1000, { x: 1, y: 0, z: 0 }, true);
    expect(history.sampleAt(9_999)?.position.x).toBe(1);
  });

  it('returns null when empty', () => {
    expect(new PositionHistory().sampleAt(0)).toBeNull();
  });

  it('discards samples older than the retention window', () => {
    const history = new PositionHistory();
    for (let i = 0; i < 500; i++) {
      history.record(1000 + i * 50, { x: i, y: 0, z: 0 }, true);
    }
    // 1000 ms of retention at 50 ms spacing is ~21 samples.
    expect(history.size).toBeLessThanOrEqual(32);
  });

  it('caps the entry count even for a very high sample rate', () => {
    const history = new PositionHistory(16);
    for (let i = 0; i < 1000; i++) {
      history.record(1000 + i, { x: i, y: 0, z: 0 }, true);
    }
    expect(history.size).toBeLessThanOrEqual(16);
  });
});
