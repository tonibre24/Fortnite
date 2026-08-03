import { describe, expect, it } from 'vitest';
import { applyDamage, resolveHitscan } from './combat.js';
import { ColliderIndex } from './collision.js';
import { MAX_HEALTH, MAX_SHIELD, PLAYER_HEAD_HEIGHT } from './constants.js';

describe('applyDamage', () => {
  it('consumes shield before health', () => {
    const result = applyDamage({ health: MAX_HEALTH, shield: MAX_SHIELD }, 30);
    expect(result.shield).toBe(20);
    expect(result.health).toBe(100);
    expect(result.shieldDamage).toBe(30);
    expect(result.healthDamage).toBe(0);
    expect(result.killed).toBe(false);
  });

  it('carries overflow damage from shield into health', () => {
    const result = applyDamage({ health: 100, shield: 50 }, 80);
    expect(result.shield).toBe(0);
    expect(result.health).toBe(70);
    expect(result.shieldDamage).toBe(50);
    expect(result.healthDamage).toBe(30);
  });

  it('reports a kill when health reaches zero', () => {
    const result = applyDamage({ health: 12, shield: 0 }, 12);
    expect(result.health).toBe(0);
    expect(result.killed).toBe(true);
  });

  it('never over-reports applied damage on an overkill', () => {
    const result = applyDamage({ health: 10, shield: 5 }, 500);
    expect(result.appliedDamage).toBe(15);
    expect(result.health).toBe(0);
    expect(result.shield).toBe(0);
    expect(result.killed).toBe(true);
  });

  it('ignores negative damage', () => {
    const result = applyDamage({ health: 40, shield: 10 }, -25);
    expect(result.health).toBe(40);
    expect(result.shield).toBe(10);
    expect(result.appliedDamage).toBe(0);
  });

  it('takes the full 150 effective health to eliminate a fresh player', () => {
    let vitals = { health: MAX_HEALTH, shield: MAX_SHIELD };
    let ticks = 0;
    while (vitals.health > 0 && ticks < 100) {
      const result = applyDamage(vitals, 25);
      vitals = { health: result.health, shield: result.shield };
      ticks++;
    }
    expect(ticks).toBe(6);
  });
});

describe('resolveHitscan', () => {
  const emptyWorld = new ColliderIndex([]);
  const floor = new ColliderIndex([
    { id: 'wall', min: { x: -10, y: 0, z: 4 }, max: { x: 10, y: 6, z: 5 } },
  ]);

  it('hits a player body along the ray', () => {
    const outcome = resolveHitscan({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 50, emptyWorld, [
      { id: 'victim', position: { x: 0, y: 0, z: 10 } },
    ]);
    expect(outcome.hit?.targetId).toBe('victim');
    expect(outcome.hit?.headshot).toBe(false);
  });

  it('flags a headshot when the ray passes through the head sphere', () => {
    const outcome = resolveHitscan(
      { x: 0, y: PLAYER_HEAD_HEIGHT, z: 0 },
      { x: 0, y: 0, z: 1 },
      50,
      emptyWorld,
      [{ id: 'victim', position: { x: 0, y: 0, z: 10 } }],
    );
    expect(outcome.hit?.headshot).toBe(true);
  });

  it('is blocked by world geometry standing between shooter and target', () => {
    const outcome = resolveHitscan({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 50, floor, [
      { id: 'victim', position: { x: 0, y: 0, z: 10 } },
    ]);
    expect(outcome.hit).toBeNull();
    expect(outcome.worldNormal).not.toBeNull();
    expect(outcome.endPoint.z).toBeCloseTo(4, 4);
  });

  it('returns the nearest of two overlapping targets', () => {
    const outcome = resolveHitscan({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 50, emptyWorld, [
      { id: 'far', position: { x: 0, y: 0, z: 20 } },
      { id: 'near', position: { x: 0, y: 0, z: 8 } },
    ]);
    expect(outcome.hit?.targetId).toBe('near');
  });

  it('terminates at max range when nothing is struck', () => {
    const outcome = resolveHitscan({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 30, emptyWorld, []);
    expect(outcome.hit).toBeNull();
    expect(outcome.endPoint.z).toBeCloseTo(30, 6);
  });

  it('does not hit a target beyond the weapon range', () => {
    const outcome = resolveHitscan({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 5, emptyWorld, [
      { id: 'victim', position: { x: 0, y: 0, z: 40 } },
    ]);
    expect(outcome.hit).toBeNull();
  });
});
