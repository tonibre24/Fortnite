import { mulberry32, hashSeed, normalizeVec3, crossVec3, type Vec3 } from './math.js';

/**
 * Data-driven weapon description. Gameplay code must never hard-code these numbers;
 * everything reads from the registry below so client, server and tests agree.
 */
export interface WeaponDefinition {
  id: string;
  displayName: string;
  /** Damage per bullet (assault rifle) or per pellet (shotgun) at point blank. */
  damage: number;
  headshotMultiplier: number;
  roundsPerMinute: number;
  magazineSize: number;
  reserveAmmo: number;
  reloadDurationMs: number;
  /** Maximum hitscan travel distance in metres. */
  range: number;
  /** Cone half-angle in radians while hip firing. */
  spreadHipFire: number;
  /** Cone half-angle in radians while aiming down sight. */
  spreadAiming: number;
  recoilVertical: number;
  recoilHorizontal: number;
  automatic: boolean;
  /** Hitscan projectiles emitted per trigger pull. */
  pelletCount: number;
  /** Distance at which damage falloff begins. */
  falloffStart: number;
  /** Distance at which damage reaches `falloffMinMultiplier`. */
  falloffEnd: number;
  falloffMinMultiplier: number;
}

export const WEAPON_IDS = ['rifle', 'shotgun'] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];

const RIFLE: WeaponDefinition = {
  id: 'rifle',
  displayName: 'RF-9 Vector',
  damage: 19,
  headshotMultiplier: 1.85,
  roundsPerMinute: 540,
  magazineSize: 30,
  reserveAmmo: 180,
  reloadDurationMs: 2100,
  range: 120,
  spreadHipFire: 0.045,
  spreadAiming: 0.008,
  recoilVertical: 0.014,
  recoilHorizontal: 0.006,
  automatic: true,
  pelletCount: 1,
  falloffStart: 32,
  falloffEnd: 90,
  falloffMinMultiplier: 0.6,
};

const SHOTGUN: WeaponDefinition = {
  id: 'shotgun',
  displayName: 'CB-2 Breaker',
  damage: 12,
  headshotMultiplier: 1.5,
  roundsPerMinute: 78,
  magazineSize: 6,
  reserveAmmo: 36,
  reloadDurationMs: 2600,
  range: 45,
  spreadHipFire: 0.105,
  spreadAiming: 0.062,
  recoilVertical: 0.055,
  recoilHorizontal: 0.02,
  automatic: false,
  pelletCount: 9,
  falloffStart: 7,
  falloffEnd: 24,
  falloffMinMultiplier: 0.18,
};

export const WEAPONS: Readonly<Record<WeaponId, WeaponDefinition>> = Object.freeze({
  rifle: Object.freeze(RIFLE),
  shotgun: Object.freeze(SHOTGUN),
});

export const DEFAULT_WEAPON_ID: WeaponId = 'rifle';

export const isWeaponId = (value: unknown): value is WeaponId =>
  typeof value === 'string' && (WEAPON_IDS as readonly string[]).includes(value);

export function getWeapon(id: string): WeaponDefinition {
  if (!isWeaponId(id)) {
    throw new Error(`Unknown weapon id: ${String(id)}`);
  }
  return WEAPONS[id];
}

/** Minimum milliseconds between two shots for a weapon. */
export const fireIntervalMs = (weapon: WeaponDefinition): number => 60000 / weapon.roundsPerMinute;

/**
 * Distance-based damage multiplier. Linear between `falloffStart` and `falloffEnd`,
 * which keeps the shotgun readable: lethal up close, weak at range.
 */
export function damageFalloffMultiplier(weapon: WeaponDefinition, distance: number): number {
  if (distance <= weapon.falloffStart) return 1;
  if (distance >= weapon.falloffEnd) return weapon.falloffMinMultiplier;
  const span = weapon.falloffEnd - weapon.falloffStart;
  const t = span <= 0 ? 1 : (distance - weapon.falloffStart) / span;
  return 1 + (weapon.falloffMinMultiplier - 1) * t;
}

/** Damage a single hit deals, before shield/health split. */
export function computeHitDamage(
  weapon: WeaponDefinition,
  distance: number,
  headshot: boolean,
): number {
  const base = weapon.damage * damageFalloffMultiplier(weapon, distance);
  const withHeadshot = headshot ? base * weapon.headshotMultiplier : base;
  // Rounded so client-side damage numbers exactly match the server's arithmetic.
  return Math.max(1, Math.round(withHeadshot));
}

/**
 * Deterministic spread. Client and server derive the same pellet directions from
 * `(shooterId, shotSequence)`, so the client can draw accurate tracers immediately
 * while the server independently resolves the identical rays.
 */
export function computeShotDirections(
  weapon: WeaponDefinition,
  aimDirection: Vec3,
  aiming: boolean,
  shooterId: string,
  shotSequence: number,
): Vec3[] {
  const forward = normalizeVec3(aimDirection);
  if (forward.x === 0 && forward.y === 0 && forward.z === 0) {
    return [];
  }

  // Build an orthonormal basis around the aim direction.
  const reference: Vec3 = Math.abs(forward.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const right = normalizeVec3(crossVec3(reference, forward));
  const up = crossVec3(forward, right);

  const maxSpread = aiming ? weapon.spreadAiming : weapon.spreadHipFire;
  const random = mulberry32(hashSeed(shooterId, shotSequence, weapon.id));
  const directions: Vec3[] = [];

  for (let i = 0; i < weapon.pelletCount; i++) {
    // sqrt() keeps the sample density uniform across the cone's disc.
    const radius = Math.sqrt(random()) * maxSpread;
    const angle = random() * Math.PI * 2;
    const offsetX = Math.cos(angle) * radius;
    const offsetY = Math.sin(angle) * radius;
    directions.push(
      normalizeVec3({
        x: forward.x + right.x * offsetX + up.x * offsetY,
        y: forward.y + right.y * offsetX + up.y * offsetY,
        z: forward.z + right.z * offsetX + up.z * offsetY,
      }),
    );
  }

  return directions;
}
