import {
  Button,
  EventType,
  MAX_LAG_COMP_TICKS,
  StateFlag,
  WEAPON_MAX_RANGE,
  aimDirection,
  applyDamage,
  damageAtRange,
  eyePosition,
  headshotDamage,
  raycastWorld,
  rayPlayer,
  spreadDirection,
  unpackWeapon,
  vec3,
  weaponReloadTicks,
  weaponStats,
  type InputCommand,
  type Vec3,
} from '@br/shared';
import type { World } from './World.js';
import type { ServerPlayer } from './ServerPlayer.js';

const eye = vec3();
const aim = vec3();
const pellet = vec3();
const rewound = vec3();

interface PelletHit {
  victim: ServerPlayer;
  damage: number;
  headshot: boolean;
}

/**
 * Resolves one player's weapon for one command: reload timers, the fire
 * cooldown, and - if they pulled the trigger - the hitscan itself.
 *
 * The shot is traced against the world as it looked to the shooter, not as it
 * looks now. Without that rewind, hitting a moving target would require leading
 * it by however much latency you happen to have, which is unplayable.
 */
export function resolveWeapon(world: World, player: ServerPlayer, cmd: InputCommand): void {
  const state = player.state;
  const weapon = unpackWeapon(state.weapon);

  if ((state.flags & StateFlag.Alive) === 0 || weapon === null) {
    state.reload = 0;
    return;
  }

  const stats = weaponStats(weapon.cls);

  if (state.reload > 0) {
    state.reload -= 1;
    if (state.reload === 0) state.ammo = stats.magazine;
  }
  if (player.fireCooldown > 0) player.fireCooldown -= 1;

  const wantsReload = (cmd.buttons & Button.Reload) !== 0;
  if (state.reload === 0 && (wantsReload || state.ammo === 0) && state.ammo < stats.magazine) {
    state.reload = weaponReloadTicks(weapon.cls, weapon.rarity);
    player.triggerHeld = false;
    return;
  }

  const firing = (cmd.buttons & Button.Fire) !== 0;
  // A semi-automatic needs the trigger released between shots.
  const mayFire = stats.automatic ? firing : firing && !player.triggerHeld;
  player.triggerHeld = firing;

  if (!mayFire || player.fireCooldown > 0 || state.reload > 0 || state.ammo === 0) return;

  state.ammo -= 1;
  player.fireCooldown = stats.fireInterval;
  fireShot(world, player, cmd, weapon.cls, weapon.rarity);
}

function fireShot(
  world: World,
  shooter: ServerPlayer,
  cmd: InputCommand,
  cls: number,
  rarity: number,
): void {
  const state = shooter.state;
  const stats = weaponStats(cls);

  eyePosition(state.pos, eye);
  aimDirection(cmd.yawQ, cmd.pitchQ, aim);

  world.pushEvent(
    {
      type: EventType.Shot,
      shooterId: shooter.id,
      seq: cmd.seq,
      weapon: state.weapon,
      x: eye.x,
      y: eye.y,
      z: eye.z,
      yawQ: cmd.yawQ,
      pitchQ: cmd.pitchQ,
    },
    0,
  );

  // Clamp the client's claimed viewpoint: honouring an arbitrary rewind would
  // let a client shoot at where people were minutes ago.
  const rewindTick = clamp(cmd.renderTick, world.tick - MAX_LAG_COMP_TICKS, world.tick);

  const hits = new Map<number, PelletHit>();
  for (let i = 0; i < stats.pellets; i++) {
    spreadDirection(aim, stats.spread, shooter.id, cmd.seq, i, pellet);
    const hit = tracePellet(world, shooter, rewindTick, pellet, cls, rarity);
    if (hit === null) continue;
    const existing = hits.get(hit.victim.id);
    if (existing === undefined) hits.set(hit.victim.id, hit);
    else {
      existing.damage += hit.damage;
      existing.headshot = existing.headshot || hit.headshot;
    }
  }

  for (const hit of hits.values()) applyHit(world, shooter, hit);
}

function tracePellet(
  world: World,
  shooter: ServerPlayer,
  rewindTick: number,
  dir: Vec3,
  cls: number,
  rarity: number,
): PelletHit | null {
  const invDx = 1 / (dir.x === 0 ? Number.MIN_VALUE : dir.x);
  const invDy = 1 / (dir.y === 0 ? Number.MIN_VALUE : dir.y);
  const invDz = 1 / (dir.z === 0 ? Number.MIN_VALUE : dir.z);

  // Geometry is static, so it needs no rewind - only players do.
  let nearest = raycastWorld(
    world.map.world,
    eye.x,
    eye.y,
    eye.z,
    dir.x,
    dir.y,
    dir.z,
    WEAPON_MAX_RANGE,
  );
  let victim: ServerPlayer | null = null;
  let headshot = false;

  for (const target of world.players.values()) {
    if (target === shooter) continue;
    if ((target.state.flags & StateFlag.Alive) === 0) continue;
    if (!world.positionAt(target.id, rewindTick, rewound)) continue;

    const hit = rayPlayer(eye.x, eye.y, eye.z, invDx, invDy, invDz, rewound, nearest);
    if (hit === null || hit.distance >= nearest) continue;
    nearest = hit.distance;
    victim = target;
    headshot = hit.headshot;
  }

  if (victim === null) return null;
  return {
    victim,
    damage: headshotDamage(damageAtRange(cls, rarity, nearest), headshot),
    headshot,
  };
}

function applyHit(world: World, shooter: ServerPlayer, hit: PelletHit): void {
  const victim = hit.victim;
  const state = victim.state;
  // Two players can resolve shots at the same victim in the same tick. The
  // second one must not score a hit marker on a corpse.
  if ((state.flags & StateFlag.Alive) === 0) return;
  // The lobby is a warm-up: guns work, but nobody can be knocked out of a
  // round that has not started. Without this a lobby fight can leave one
  // player standing and the round can never reach its minimum to begin.
  if (!world.round.live) return;

  const result = applyDamage(state.health, state.shield, hit.damage);
  state.health = result.health;
  state.shield = result.shield;

  world.pushEvent(
    {
      type: EventType.Hit,
      victimId: victim.id,
      damage: result.applied,
      headshot: hit.headshot,
      killed: result.killed,
    },
    shooter.id,
  );

  const dx = victim.state.pos.x - shooter.state.pos.x;
  const dz = victim.state.pos.z - shooter.state.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  world.pushEvent(
    {
      type: EventType.Damaged,
      attackerId: shooter.id,
      damage: result.applied,
      // Points from the victim back towards whoever shot them.
      dirX: -dx / len,
      dirZ: -dz / len,
    },
    victim.id,
  );

  if (result.killed) world.killPlayer(victim, shooter);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
