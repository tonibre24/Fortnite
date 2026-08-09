import { type Box, rayBox } from './collision.js';
import {
  HEAD_HEIGHT,
  HEADSHOT_MULTIPLIER,
  PLAYER_EYE_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_SHIELD,
} from './constants.js';
import { dequantizePitch, dequantizeYaw, type Vec3 } from './math.js';
import { Rng } from './rng.js';
import { weaponStats } from './weapons.js';

/** Where a shot leaves the shooter. */
export function eyePosition(pos: Vec3, out: Vec3): Vec3 {
  out.x = pos.x;
  out.y = pos.y + PLAYER_EYE_HEIGHT;
  out.z = pos.z;
  return out;
}

/** Unit aim vector for a look direction. Matches the movement convention. */
export function aimDirection(yawQ: number, pitchQ: number, out: Vec3): Vec3 {
  const yaw = dequantizeYaw(yawQ);
  const pitch = dequantizePitch(pitchQ);
  const cosPitch = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cosPitch;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cosPitch;
  return out;
}

/**
 * Deterministic per-pellet spread. Seeded from the shooter, the command and the
 * pellet index, so the same shot produces the same cone anywhere it is
 * evaluated - which is what lets a client draw tracers that match what the
 * server resolved.
 */
export function spreadDirection(
  dir: Vec3,
  spread: number,
  shooterId: number,
  seq: number,
  pellet: number,
  out: Vec3,
): Vec3 {
  if (spread <= 0) {
    out.x = dir.x;
    out.y = dir.y;
    out.z = dir.z;
    return out;
  }
  const rng = new Rng((shooterId * 0x9e3779b1) ^ (seq * 0x85ebca6b) ^ (pellet * 0xc2b2ae35));
  const angle = rng.next() * Math.PI * 2;
  // Square-rooting keeps the distribution even across the disc instead of
  // clustering pellets at the centre.
  const radius = Math.sqrt(rng.next()) * spread;

  // Build any two axes perpendicular to the aim direction.
  const upX = Math.abs(dir.y) > 0.99 ? 1 : 0;
  const upY = Math.abs(dir.y) > 0.99 ? 0 : 1;
  let rx = upY * dir.z - 0 * dir.y;
  let ry = 0 * dir.x - upX * dir.z;
  let rz = upX * dir.y - upY * dir.x;
  const rLen = Math.hypot(rx, ry, rz) || 1;
  rx /= rLen;
  ry /= rLen;
  rz /= rLen;
  const ux = ry * dir.z - rz * dir.y;
  const uy = rz * dir.x - rx * dir.z;
  const uz = rx * dir.y - ry * dir.x;

  const ox = Math.cos(angle) * radius;
  const oy = Math.sin(angle) * radius;
  out.x = dir.x + rx * ox + ux * oy;
  out.y = dir.y + ry * ox + uy * oy;
  out.z = dir.z + rz * ox + uz * oy;
  const len = Math.hypot(out.x, out.y, out.z) || 1;
  out.x /= len;
  out.y /= len;
  out.z /= len;
  return out;
}

/** Full-body hitbox for a player standing at `pos` (feet). */
export function bodyBox(pos: Vec3, out: Box): Box {
  out.minX = pos.x - PLAYER_RADIUS;
  out.minY = pos.y;
  out.minZ = pos.z - PLAYER_RADIUS;
  out.maxX = pos.x + PLAYER_RADIUS;
  out.maxY = pos.y + PLAYER_HEIGHT;
  out.maxZ = pos.z + PLAYER_RADIUS;
  return out;
}

/** The top slice of the body, worth extra damage. */
export function headBox(pos: Vec3, out: Box): Box {
  out.minX = pos.x - PLAYER_RADIUS;
  out.minY = pos.y + PLAYER_HEIGHT - HEAD_HEIGHT;
  out.minZ = pos.z - PLAYER_RADIUS;
  out.maxX = pos.x + PLAYER_RADIUS;
  out.maxY = pos.y + PLAYER_HEIGHT;
  out.maxZ = pos.z + PLAYER_RADIUS;
  return out;
}

const scratchBox: Box = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

export interface PlayerRayHit {
  distance: number;
  headshot: boolean;
}

/** Ray against one player's hitboxes. Returns null when it misses. */
export function rayPlayer(
  ox: number,
  oy: number,
  oz: number,
  invDx: number,
  invDy: number,
  invDz: number,
  pos: Vec3,
  maxDist: number,
): PlayerRayHit | null {
  bodyBox(pos, scratchBox);
  const body = rayBox(ox, oy, oz, invDx, invDy, invDz, scratchBox, maxDist);
  if (body < 0) return null;
  headBox(pos, scratchBox);
  const head = rayBox(ox, oy, oz, invDx, invDy, invDz, scratchBox, maxDist);
  return { distance: body, headshot: head >= 0 };
}

export function headshotDamage(damage: number, headshot: boolean): number {
  return headshot ? damage * HEADSHOT_MULTIPLIER : damage;
}

export interface DamageResult {
  health: number;
  shield: number;
  /** Damage actually absorbed, which is less than requested against a corpse. */
  applied: number;
  killed: boolean;
}

/** Shield soaks damage first, then health. */
export function applyDamage(health: number, shield: number, amount: number): DamageResult {
  const before = health + shield;
  let remaining = Math.max(0, Math.round(amount));
  let nextShield = shield;
  let nextHealth = health;

  const absorbed = Math.min(nextShield, remaining);
  nextShield -= absorbed;
  remaining -= absorbed;
  nextHealth = Math.max(0, nextHealth - remaining);

  return {
    health: nextHealth,
    shield: nextShield,
    applied: before - (nextHealth + nextShield),
    killed: nextHealth <= 0,
  };
}

export function clampHealth(value: number): number {
  return Math.max(0, Math.min(PLAYER_MAX_HEALTH, Math.round(value)));
}

export function clampShield(value: number): number {
  return Math.max(0, Math.min(PLAYER_MAX_SHIELD, Math.round(value)));
}

/** Total ticks a shot occupies, used by both the server and the HUD. */
export function fireIntervalTicks(cls: number): number {
  return weaponStats(cls).fireInterval;
}
