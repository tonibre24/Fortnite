import { describe, expect, it } from 'vitest';
import {
  WEAPONS,
  computeHitDamage,
  computeShotDirections,
  damageFalloffMultiplier,
  fireIntervalMs,
  getWeapon,
  isWeaponId,
} from './weapons.js';
import { dotVec3, lengthVec3 } from './math.js';

describe('weapon definitions', () => {
  it('exposes exactly the two vertical-slice weapons', () => {
    expect(Object.keys(WEAPONS).sort()).toEqual(['rifle', 'shotgun']);
    expect(isWeaponId('rifle')).toBe(true);
    expect(isWeaponId('rocket')).toBe(false);
  });

  it('throws on unknown weapon ids rather than returning a default', () => {
    expect(() => getWeapon('rocket')).toThrow(/Unknown weapon id/);
  });
});

describe('fireIntervalMs', () => {
  it('derives the shot interval from rounds per minute', () => {
    expect(fireIntervalMs(WEAPONS.rifle)).toBeCloseTo(60000 / 540, 6);
    expect(fireIntervalMs(WEAPONS.shotgun)).toBeCloseTo(60000 / 78, 6);
  });

  it('gives the rifle a faster cadence than the shotgun', () => {
    expect(fireIntervalMs(WEAPONS.rifle)).toBeLessThan(fireIntervalMs(WEAPONS.shotgun));
  });
});

describe('damageFalloffMultiplier', () => {
  const shotgun = WEAPONS.shotgun;

  it('is full damage inside the falloff start distance', () => {
    expect(damageFalloffMultiplier(shotgun, 0)).toBe(1);
    expect(damageFalloffMultiplier(shotgun, shotgun.falloffStart)).toBe(1);
  });

  it('reaches the floor multiplier at and beyond the falloff end', () => {
    expect(damageFalloffMultiplier(shotgun, shotgun.falloffEnd)).toBeCloseTo(
      shotgun.falloffMinMultiplier,
      6,
    );
    expect(damageFalloffMultiplier(shotgun, shotgun.falloffEnd + 50)).toBeCloseTo(
      shotgun.falloffMinMultiplier,
      6,
    );
  });

  it('decreases monotonically across the falloff band', () => {
    const mid = (shotgun.falloffStart + shotgun.falloffEnd) / 2;
    const near = damageFalloffMultiplier(shotgun, shotgun.falloffStart + 1);
    const middle = damageFalloffMultiplier(shotgun, mid);
    const far = damageFalloffMultiplier(shotgun, shotgun.falloffEnd - 1);
    expect(near).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(far);
  });
});

describe('computeHitDamage', () => {
  it('applies the headshot multiplier', () => {
    const body = computeHitDamage(WEAPONS.rifle, 0, false);
    const head = computeHitDamage(WEAPONS.rifle, 0, true);
    expect(body).toBe(19);
    expect(head).toBe(Math.round(19 * WEAPONS.rifle.headshotMultiplier));
    expect(head).toBeGreaterThan(body);
  });

  it('combines falloff and the headshot multiplier', () => {
    const distance = WEAPONS.shotgun.falloffEnd;
    const expected = Math.round(
      WEAPONS.shotgun.damage *
        WEAPONS.shotgun.falloffMinMultiplier *
        WEAPONS.shotgun.headshotMultiplier,
    );
    expect(computeHitDamage(WEAPONS.shotgun, distance, true)).toBe(Math.max(1, expected));
  });

  it('never deals less than one damage', () => {
    expect(computeHitDamage(WEAPONS.shotgun, 10_000, false)).toBeGreaterThanOrEqual(1);
  });

  it('kills an unshielded target in the documented number of rifle body shots', () => {
    const perShot = computeHitDamage(WEAPONS.rifle, 5, false);
    expect(Math.ceil(150 / perShot)).toBe(8);
  });
});

describe('computeShotDirections', () => {
  const forward = { x: 0, y: 0, z: 1 };

  it('emits one ray for the rifle and one per pellet for the shotgun', () => {
    expect(computeShotDirections(WEAPONS.rifle, forward, false, 'abc', 1)).toHaveLength(1);
    expect(computeShotDirections(WEAPONS.shotgun, forward, false, 'abc', 1)).toHaveLength(
      WEAPONS.shotgun.pelletCount,
    );
  });

  it('is deterministic for the same shooter and shot sequence', () => {
    const a = computeShotDirections(WEAPONS.shotgun, forward, false, 'player-1', 7);
    const b = computeShotDirections(WEAPONS.shotgun, forward, false, 'player-1', 7);
    expect(a).toEqual(b);
  });

  it('differs between shot sequences and between shooters', () => {
    const first = computeShotDirections(WEAPONS.shotgun, forward, false, 'player-1', 7);
    const nextShot = computeShotDirections(WEAPONS.shotgun, forward, false, 'player-1', 8);
    const otherPlayer = computeShotDirections(WEAPONS.shotgun, forward, false, 'player-2', 7);
    expect(first).not.toEqual(nextShot);
    expect(first).not.toEqual(otherPlayer);
  });

  it('returns unit vectors inside the configured cone', () => {
    const directions = computeShotDirections(WEAPONS.shotgun, forward, false, 'p', 3);
    for (const direction of directions) {
      expect(lengthVec3(direction)).toBeCloseTo(1, 6);
      const angle = Math.acos(Math.min(1, dotVec3(direction, forward)));
      expect(angle).toBeLessThanOrEqual(WEAPONS.shotgun.spreadHipFire + 1e-6);
    }
  });

  it('tightens the cone while aiming', () => {
    const maxAngle = (aiming: boolean): number => {
      const directions = computeShotDirections(WEAPONS.rifle, forward, aiming, 'p', 11);
      return Math.max(...directions.map((d) => Math.acos(Math.min(1, dotVec3(d, forward)))));
    };
    expect(maxAngle(true)).toBeLessThan(maxAngle(false));
  });

  it('returns no rays for a degenerate aim direction', () => {
    expect(computeShotDirections(WEAPONS.rifle, { x: 0, y: 0, z: 0 }, false, 'p', 1)).toEqual([]);
  });
});
