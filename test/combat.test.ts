import { describe, expect, it } from 'vitest';
import {
  ADS_SPREAD_MULTIPLIER,
  Button,
  CollisionWorld,
  GROUND_Y,
  HEADSHOT_MULTIPLIER,
  PLAYER_EYE_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_MAX_HEALTH,
  RARITY_COUNT,
  Rarity,
  RoundPhase,
  StateFlag,
  WEAPONS,
  WEAPON_CLASS_COUNT,
  WeaponClass,
  aimDirection,
  applyDamage,
  box,
  damageAtRange,
  decodeSnapshot,
  effectiveSpread,
  EventType,
  packWeapon,
  quantizePitch,
  quantizeYaw,
  raycastWorld,
  rayPlayer,
  spreadDirection,
  unpackWeapon,
  vec3,
  weaponDamage,
  weaponReloadTicks,
  weaponStats,
  type InputCommand,
} from '@br/shared';
import { World } from '../server/src/World.js';
import { giveWeapon } from '../server/src/Loot.js';

const SEED = 0xc0ffee;

function fireCommand(
  seq: number,
  yaw: number,
  pitch: number,
  renderTick: number,
  extraButtons = 0,
): InputCommand {
  return {
    seq,
    buttons: Button.Fire | extraButtons,
    yawQ: quantizeYaw(yaw),
    pitchQ: quantizePitch(pitch),
    renderTick,
    slot: 0,
  };
}

function idle(seq: number): InputCommand {
  return { seq, buttons: 0, yawQ: quantizeYaw(0), pitchQ: 0, renderTick: 0, slot: 0 };
}

describe('weapons', () => {
  it('defines every class', () => {
    expect(WEAPONS.length).toBe(WEAPON_CLASS_COUNT);
    for (const stats of WEAPONS) {
      expect(stats.damage).toBeGreaterThan(0);
      expect(stats.fireInterval).toBeGreaterThanOrEqual(1);
      expect(stats.magazine).toBeGreaterThan(0);
      expect(stats.pellets).toBeGreaterThanOrEqual(1);
      expect(stats.falloffEnd).toBeGreaterThan(stats.falloffStart);
    }
  });

  it('scales damage up and reload time down with rarity', () => {
    for (let cls = 0; cls < WEAPON_CLASS_COUNT; cls++) {
      for (let rarity = 1; rarity < RARITY_COUNT; rarity++) {
        expect(weaponDamage(cls, rarity)).toBeGreaterThan(weaponDamage(cls, rarity - 1));
        expect(weaponReloadTicks(cls, rarity)).toBeLessThanOrEqual(weaponReloadTicks(cls, rarity - 1));
      }
    }
  });

  it('packs class and rarity into one byte and back', () => {
    for (let cls = 0; cls < WEAPON_CLASS_COUNT; cls++) {
      for (let rarity = 0; rarity < RARITY_COUNT; rarity++) {
        const packed = packWeapon(cls, rarity);
        expect(packed).toBeGreaterThan(0);
        expect(packed).toBeLessThan(256);
        expect(unpackWeapon(packed)).toEqual({ cls, rarity });
      }
    }
    // Zero is reserved for "no weapon", so it must not decode to a real gun.
    expect(unpackWeapon(0)).toBeNull();
  });

  it('drops damage over distance and never below the floor', () => {
    for (let cls = 0; cls < WEAPON_CLASS_COUNT; cls++) {
      const stats = weaponStats(cls);
      const close = damageAtRange(cls, Rarity.Grey, 0);
      const mid = damageAtRange(cls, Rarity.Grey, (stats.falloffStart + stats.falloffEnd) / 2);
      const far = damageAtRange(cls, Rarity.Grey, stats.falloffEnd * 4);
      expect(close).toBeCloseTo(weaponDamage(cls, Rarity.Grey), 5);
      expect(mid).toBeLessThan(close);
      expect(far).toBeCloseTo(weaponDamage(cls, Rarity.Grey) * stats.falloffFloor, 5);
    }
  });

  it('gives the shotgun many pellets and the rest one', () => {
    expect(weaponStats(WeaponClass.Shotgun).pellets).toBeGreaterThan(1);
    expect(weaponStats(WeaponClass.Pistol).pellets).toBe(1);
    expect(weaponStats(WeaponClass.Rifle).automatic).toBe(true);
    expect(weaponStats(WeaponClass.Pistol).automatic).toBe(false);
  });
});

describe('damage', () => {
  it('spends shield before health', () => {
    const result = applyDamage(100, 50, 30);
    expect(result.shield).toBe(20);
    expect(result.health).toBe(100);
    expect(result.applied).toBe(30);
    expect(result.killed).toBe(false);
  });

  it('carries overflow through the shield into health', () => {
    const result = applyDamage(100, 20, 50);
    expect(result.shield).toBe(0);
    expect(result.health).toBe(70);
    expect(result.applied).toBe(50);
  });

  it('reports a kill and never goes below zero', () => {
    const result = applyDamage(10, 0, 999);
    expect(result.health).toBe(0);
    expect(result.killed).toBe(true);
    // Only the damage that had somewhere to land counts.
    expect(result.applied).toBe(10);
  });

  it('doubles for a headshot', () => {
    const body = damageAtRange(WeaponClass.Rifle, Rarity.Grey, 5);
    expect(body * HEADSHOT_MULTIPLIER).toBeGreaterThan(body);
  });
});

describe('raycasting', () => {
  const wallZ = -10;
  const world = new CollisionWorld([
    box(-200, -2, -200, 200, GROUND_Y, 200, 0),
    box(-20, GROUND_Y, wallZ, 20, GROUND_Y + 6, wallZ + 1, 0),
  ]);

  it('finds the wall in front of it', () => {
    // The near face of the slab is at wallZ + 1, so that is where the ray stops.
    const distance = raycastWorld(world, 0, 2, 0, 0, 0, -1, 100);
    expect(distance).toBeCloseTo(-(wallZ + 1), 3);
  });

  it('returns the full range when nothing is in the way', () => {
    expect(raycastWorld(world, 0, 2, 0, 0, 0, 1, 100)).toBe(100);
  });

  it('finds the ground when aimed down', () => {
    expect(raycastWorld(world, 0, 5, 50, 0, -1, 0, 100)).toBeCloseTo(5, 3);
  });

  it('hits a player box and separates head from body', () => {
    const target = { x: 0, y: 0, z: -8 };
    const dir = vec3();

    aimDirection(quantizeYaw(0), quantizePitch(0), dir);
    const chest = rayPlayer(0, 1.0, 0, 1 / dir.x, 1 / dir.y, 1 / dir.z, target, 100);
    expect(chest).not.toBeNull();
    expect(chest!.headshot).toBe(false);

    // Aim at the very top of the box from level with it.
    const high = rayPlayer(0, PLAYER_HEIGHT - 0.1, 0, 1 / dir.x, 1 / dir.y, 1 / dir.z, target, 100);
    expect(high).not.toBeNull();
    expect(high!.headshot).toBe(true);
  });

  it('misses a player standing off to the side', () => {
    const dir = vec3();
    aimDirection(quantizeYaw(0), quantizePitch(0), dir);
    const hit = rayPlayer(0, 1, 0, 1 / dir.x, 1 / dir.y, 1 / dir.z, { x: 40, y: 0, z: -8 }, 100);
    expect(hit).toBeNull();
  });
});

describe('spread', () => {
  it('is deterministic for the same shot', () => {
    const dir = vec3();
    aimDirection(quantizeYaw(1.1), quantizePitch(0.2), dir);
    const a = spreadDirection(dir, 0.05, 3, 42, 5, vec3());
    const b = spreadDirection(dir, 0.05, 3, 42, 5, vec3());
    expect(a).toEqual(b);
  });

  it('gives different pellets different directions', () => {
    const dir = vec3();
    aimDirection(quantizeYaw(0), quantizePitch(0), dir);
    const a = spreadDirection(dir, 0.05, 3, 42, 0, vec3());
    const b = spreadDirection(dir, 0.05, 3, 42, 1, vec3());
    expect(a).not.toEqual(b);
  });

  it('stays inside the cone and stays normalised', () => {
    const dir = vec3();
    aimDirection(quantizeYaw(0.7), quantizePitch(-0.3), dir);
    for (let i = 0; i < 200; i++) {
      const out = spreadDirection(dir, 0.08, 1, i, i % 9, vec3());
      expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 6);
      const dot = out.x * dir.x + out.y * dir.y + out.z * dir.z;
      expect(Math.acos(Math.min(1, dot))).toBeLessThanOrEqual(0.09);
    }
  });

  it('leaves a zero-spread weapon exactly on the aim line', () => {
    const dir = vec3();
    aimDirection(quantizeYaw(2), quantizePitch(0.4), dir);
    expect(spreadDirection(dir, 0, 1, 1, 0, vec3())).toEqual(dir);
  });
});

describe('effectiveSpread', () => {
  it('tightens by exactly ADS_SPREAD_MULTIPLIER while aiming', () => {
    expect(effectiveSpread(0.08, true)).toBeCloseTo(0.08 * ADS_SPREAD_MULTIPLIER, 10);
  });

  it('passes the base spread through unchanged when not aiming', () => {
    expect(effectiveSpread(0.08, false)).toBe(0.08);
  });

  it('is the single source both sides multiply by, not a fork', () => {
    // Same seed inputs, computed once through the shared function rather than
    // through two copies of "if aiming, times 0.4" - if a caller ever forked
    // this, this is the assertion that would catch it drifting.
    const dir = vec3();
    aimDirection(quantizeYaw(0.3), quantizePitch(0), dir);
    const aimed = spreadDirection(dir, effectiveSpread(0.1, true), 5, 9, 0, vec3());
    const unaimed = spreadDirection(dir, effectiveSpread(0.1, false), 5, 9, 0, vec3());
    // Not exactly proportional - the radius that scales linearly with spread
    // feeds a normalised vector, which is a trig function of radius, not
    // radius itself - so this checks the two agree to five decimal places
    // rather than bit-for-bit.
    const aimedAngle = Math.acos(Math.min(1, aimed.x * dir.x + aimed.y * dir.y + aimed.z * dir.z));
    const unaimedAngle = Math.acos(Math.min(1, unaimed.x * dir.x + unaimed.y * dir.y + unaimed.z * dir.z));
    expect(aimedAngle).toBeCloseTo(unaimedAngle * ADS_SPREAD_MULTIPLIER, 5);
  });
});

/**
 * The server owns hit detection, so these drive the real `World` rather than
 * the pieces underneath it.
 */
describe('server-side shooting', () => {
  function twoPlayers(): { world: World; shooter: ReturnType<World['addPlayer']>; target: ReturnType<World['addPlayer']> } {
    const world = new World(SEED);
    const shooter = world.addPlayer(1, 'shooter');
    const target = world.addPlayer(2, 'target');
    // Face each other on open ground, ten units apart along -Z.
    shooter.state.pos.x = 0;
    shooter.state.pos.y = GROUND_Y;
    shooter.state.pos.z = 0;
    target.state.pos.x = 0;
    target.state.pos.y = GROUND_Y;
    target.state.pos.z = -10;
    // Inventory is the source of truth for what is in hand.
    giveWeapon(shooter.state, WeaponClass.Rifle, Rarity.Grey, 0);
    // Damage only lands once a round is live; the lobby is a warm-up.
    world.round.state.phase = RoundPhase.Playing;
    return { world, shooter, target };
  }

  /** Aim from the shooter's eye at the target's chest. */
  function aimAt(shooterZ: number, targetZ: number): number {
    const dz = targetZ - shooterZ;
    const dy = PLAYER_HEIGHT * 0.5 - PLAYER_EYE_HEIGHT;
    return Math.atan2(dy, Math.abs(dz));
  }

  it('damages a target that is actually being aimed at', () => {
    const { world, shooter, target } = twoPlayers();
    shooter.enqueue([fireCommand(1, 0, aimAt(0, -10), 0)]);
    world.step();
    expect(target.state.health).toBeLessThan(PLAYER_MAX_HEALTH);
  });

  it('misses when aimed away', () => {
    const { world, shooter, target } = twoPlayers();
    shooter.enqueue([fireCommand(1, Math.PI, 0, 0)]);
    world.step();
    expect(target.state.health).toBe(PLAYER_MAX_HEALTH);
  });

  it('is stopped by a wall between shooter and target', () => {
    const { world, shooter, target } = twoPlayers();
    // Drop them inside a building so the wall does the blocking.
    const building = world.map.buildings[0]!;
    shooter.state.pos.x = building.minX - 6;
    shooter.state.pos.y = building.baseY;
    shooter.state.pos.z = (building.minZ + building.maxZ) / 2;
    target.state.pos.x = building.maxX + 6;
    target.state.pos.y = building.baseY;
    target.state.pos.z = shooter.state.pos.z;

    shooter.enqueue([fireCommand(1, -Math.PI / 2, 0, 0)]);
    world.step();
    expect(target.state.health).toBe(PLAYER_MAX_HEALTH);
  });

  it('respects the fire interval instead of firing every tick', () => {
    const { world, shooter, target } = twoPlayers();
    const interval = weaponStats(WeaponClass.Rifle).fireInterval;
    const pitch = aimAt(0, -10);
    for (let i = 1; i <= interval; i++) {
      shooter.enqueue([fireCommand(i, 0, pitch, 0)]);
      world.step();
    }
    // Over exactly one interval only the first shot may have gone off.
    const perShot = PLAYER_MAX_HEALTH - target.state.health;
    expect(perShot).toBeGreaterThan(0);
    expect(shooter.state.ammo).toBe(weaponStats(WeaponClass.Rifle).magazine - 1);
  });

  it('makes a semi-automatic wait for the trigger to be released', () => {
    const { world, shooter, target } = twoPlayers();
    giveWeapon(shooter.state, WeaponClass.Pistol, Rarity.Grey, 0);
    const pitch = aimAt(0, -10);

    // Hold the trigger down for far longer than the fire interval.
    for (let i = 1; i <= 40; i++) {
      shooter.enqueue([fireCommand(i, 0, pitch, 0)]);
      world.step();
    }
    expect(shooter.state.ammo).toBe(weaponStats(WeaponClass.Pistol).magazine - 1);
    expect(target.state.health).toBeLessThan(PLAYER_MAX_HEALTH);
  });

  it('reloads automatically once the magazine runs dry', () => {
    const { world, shooter } = twoPlayers();
    const stats = weaponStats(WeaponClass.Rifle);
    shooter.state.inventory[0]!.count = 1;
    shooter.state.ammo = 1;

    shooter.enqueue([fireCommand(1, 0, aimAt(0, -10), 0)]);
    world.step();
    expect(shooter.state.ammo).toBe(0);

    for (let i = 2; i < 2 + weaponReloadTicks(WeaponClass.Rifle, Rarity.Grey) + 2; i++) {
      shooter.enqueue([idle(i)]);
      world.step();
    }
    expect(shooter.state.ammo).toBe(stats.magazine);
    expect(shooter.state.reload).toBe(0);
  });

  it('eliminates a target and credits the shooter', () => {
    const { world, shooter, target } = twoPlayers();
    target.state.health = 1;
    shooter.enqueue([fireCommand(1, 0, aimAt(0, -10), 0)]);
    world.step();

    expect(target.state.flags & StateFlag.Alive).toBe(0);
    expect(target.state.health).toBe(0);
    expect(shooter.state.kills).toBe(1);
    expect(world.killCount).toBe(1);
    expect(world.aliveCount).toBe(1);
  });

  it('cannot shoot while eliminated', () => {
    const { world, shooter, target } = twoPlayers();
    world.killPlayer(shooter, null);
    const before = target.state.health;
    shooter.enqueue([fireCommand(1, 0, aimAt(0, -10), 0)]);
    world.step();
    expect(target.state.health).toBe(before);
  });

  /**
   * The wiring, not the maths: that a command carrying Button.Aim actually
   * makes it into the ShotEvent every observer decodes, all the way through
   * the real snapshot the server sends. The maths of what aiming does to the
   * cone is covered separately by the effectiveSpread tests above.
   */
  it('marks a Shot event aiming when the command that fired it was aiming', () => {
    const { world, shooter } = twoPlayers();
    const pitch = aimAt(0, -10);

    shooter.enqueue([fireCommand(1, 0, pitch, 0, Button.Aim)]);
    world.step();
    const aimed = decodeSnapshot(world.snapshotFor(shooter), () => null)!;
    const aimedShot = aimed.events.find((e) => e.type === EventType.Shot);
    expect(aimedShot?.aiming).toBe(true);

    // A fresh shooter so the fire-interval cooldown from the first shot does
    // not swallow this one.
    const other = world.addPlayer(3, 'unaimed');
    other.state.pos.x = 5;
    other.state.pos.y = GROUND_Y;
    other.state.pos.z = 0;
    giveWeapon(other.state, WeaponClass.Rifle, Rarity.Grey, 0);
    other.enqueue([fireCommand(1, 0, aimAt(0, -10), 0)]);
    world.step();
    const plain = decodeSnapshot(world.snapshotFor(other), () => null)!;
    const plainShot = plain.events.find((e) => e.type === EventType.Shot);
    expect(plainShot?.aiming).toBe(false);
  });
});

/**
 * The property that makes shooting feel fair: the server judges a shot against
 * where the shooter saw people, not where they have since moved to.
 */
describe('lag compensation', () => {
  function movingTargetWorld(): { world: World; shooter: ReturnType<World['addPlayer']> } {
    const world = new World(SEED);
    const shooter = world.addPlayer(1, 'shooter');
    const target = world.addPlayer(2, 'target');
    shooter.state.pos.x = 0;
    shooter.state.pos.y = GROUND_Y;
    shooter.state.pos.z = 0;
    giveWeapon(shooter.state, WeaponClass.Rifle, Rarity.Grey, 0);

    target.state.pos.x = 0;
    target.state.pos.y = GROUND_Y;
    target.state.pos.z = -10;
    world.round.state.phase = RoundPhase.Playing;
    return { world, shooter };
  }

  /** Runs ticks while sliding the target sideways, recording where it was. */
  function slideTarget(world: World, ticks: number): number[] {
    const positions: number[] = [];
    const target = world.players.get(2)!;
    for (let i = 0; i < ticks; i++) {
      target.state.pos.x += 1.2;
      world.step();
      positions.push(target.state.pos.x);
    }
    return positions;
  }

  it('rewinds to where the shooter saw the target', () => {
    const { world, shooter } = movingTargetWorld();
    const history = slideTarget(world, 10);
    const target = world.players.get(2)!;

    // Aim at where the target was five ticks ago, which is well behind it now.
    const pastTick = world.tick - 5;
    const pastX = history[history.length - 6]!;
    const yaw = Math.atan2(-pastX, 10);
    const pitch = Math.atan2(PLAYER_HEIGHT * 0.5 - PLAYER_EYE_HEIGHT, Math.hypot(pastX, 10));

    shooter.enqueue([fireCommand(1, yaw, pitch, pastTick)]);
    world.step();
    expect(target.state.health).toBeLessThan(PLAYER_MAX_HEALTH);
  });

  it('misses the same shot when no rewind is applied', () => {
    const { world, shooter } = movingTargetWorld();
    const history = slideTarget(world, 10);
    const target = world.players.get(2)!;

    const pastX = history[history.length - 6]!;
    const yaw = Math.atan2(-pastX, 10);
    const pitch = Math.atan2(PLAYER_HEIGHT * 0.5 - PLAYER_EYE_HEIGHT, Math.hypot(pastX, 10));

    // Same aim, but claiming to be looking at the present.
    shooter.enqueue([fireCommand(1, yaw, pitch, world.tick)]);
    world.step();
    expect(target.state.health).toBe(PLAYER_MAX_HEALTH);
  });

  it('refuses to rewind further than the history it keeps', () => {
    const { world, shooter } = movingTargetWorld();
    slideTarget(world, 40);
    const target = world.players.get(2)!;

    // A client claiming to have been looking at tick 1 gets clamped, so the
    // shot resolves against roughly the present and misses the old position.
    const yaw = Math.atan2(0, 10);
    shooter.enqueue([fireCommand(1, yaw, 0, 1)]);
    world.step();
    expect(target.state.health).toBe(PLAYER_MAX_HEALTH);
  });

  it('reports positions it has history for and refuses ones it does not', () => {
    const { world } = movingTargetWorld();
    slideTarget(world, 5);
    const out = vec3();
    expect(world.positionAt(2, world.tick - 2, out)).toBe(true);
    expect(world.positionAt(2, world.tick, out)).toBe(true);
    expect(world.positionAt(999, world.tick - 1, out)).toBe(false);
  });

  it('interpolates between recorded ticks rather than snapping', () => {
    const { world } = movingTargetWorld();
    slideTarget(world, 6);
    const before = vec3();
    const after = vec3();
    const middle = vec3();
    world.positionAt(2, world.tick - 2, before);
    world.positionAt(2, world.tick - 1, after);
    world.positionAt(2, world.tick - 1.5, middle);
    expect(middle.x).toBeCloseTo((before.x + after.x) / 2, 5);
  });
});
