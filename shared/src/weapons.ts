import { TICK_RATE } from './constants.js';

/**
 * Weapon classes. The class decides how a gun behaves; the rarity scales how
 * hard it hits and how fast it reloads.
 */
export const WeaponClass = {
  Pistol: 0,
  Smg: 1,
  Rifle: 2,
  Shotgun: 3,
} as const;

export type WeaponClassId = (typeof WeaponClass)[keyof typeof WeaponClass];

export const WEAPON_CLASS_COUNT = 4;

export const Rarity = {
  Grey: 0,
  Green: 1,
  Blue: 2,
  Purple: 3,
  Gold: 4,
} as const;

export type RarityId = (typeof Rarity)[keyof typeof Rarity];

export const RARITY_COUNT = 5;

export const RARITY_NAMES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;

/** Loot is tinted by rarity, which is the only way to read one at a distance. */
export const RARITY_COLORS = [0x9aa0a6, 0x4caf50, 0x2f7fe0, 0x9b4dda, 0xe0a12f] as const;

/** Damage multiplier per rarity step. */
export const RARITY_DAMAGE = [1, 1.12, 1.26, 1.42, 1.6] as const;
/** Reload time multiplier per rarity step - higher rarity reloads faster. */
export const RARITY_RELOAD = [1, 0.92, 0.85, 0.78, 0.7] as const;

export interface WeaponStats {
  readonly name: string;
  /** Base damage per bullet before rarity scaling and the headshot bonus. */
  readonly damage: number;
  /** Ticks between shots. */
  readonly fireInterval: number;
  readonly automatic: boolean;
  readonly magazine: number;
  /** Base reload time in ticks before rarity scaling. */
  readonly reloadTicks: number;
  readonly pellets: number;
  /** Cone half-angle in radians at the moment of firing. */
  readonly spread: number;
  /** Distance at which damage starts dropping off. */
  readonly falloffStart: number;
  /** Distance at which damage has decayed to `falloffFloor` of its value. */
  readonly falloffEnd: number;
  readonly falloffFloor: number;
}

const seconds = (s: number): number => Math.max(1, Math.round(s * TICK_RATE));

/**
 * One entry per class. Numbers are chosen so the classes trade off rather than
 * dominate: the pistol is accurate and weak, the SMG sprays, the rifle is the
 * all-rounder, and the shotgun deletes people in a doorway and nothing at all
 * beyond one.
 */
export const WEAPONS: readonly WeaponStats[] = [
  {
    name: 'pistol',
    damage: 26,
    fireInterval: seconds(0.25),
    automatic: false,
    magazine: 12,
    reloadTicks: seconds(1.4),
    pellets: 1,
    spread: 0.006,
    falloffStart: 40,
    falloffEnd: 110,
    falloffFloor: 0.5,
  },
  {
    name: 'smg',
    damage: 15,
    fireInterval: seconds(0.1),
    automatic: true,
    magazine: 30,
    reloadTicks: seconds(2.0),
    pellets: 1,
    spread: 0.032,
    falloffStart: 25,
    falloffEnd: 70,
    falloffFloor: 0.4,
  },
  {
    name: 'rifle',
    damage: 31,
    fireInterval: seconds(0.15),
    automatic: true,
    magazine: 25,
    reloadTicks: seconds(2.3),
    pellets: 1,
    spread: 0.014,
    falloffStart: 70,
    falloffEnd: 180,
    falloffFloor: 0.65,
  },
  {
    name: 'shotgun',
    damage: 11,
    fireInterval: seconds(0.85),
    automatic: false,
    magazine: 6,
    reloadTicks: seconds(3.0),
    pellets: 9,
    spread: 0.075,
    falloffStart: 8,
    falloffEnd: 32,
    falloffFloor: 0.1,
  },
];

export function weaponStats(cls: number): WeaponStats {
  return WEAPONS[cls] ?? WEAPONS[WeaponClass.Pistol]!;
}

export function weaponDamage(cls: number, rarity: number): number {
  return weaponStats(cls).damage * (RARITY_DAMAGE[rarity] ?? 1);
}

export function weaponReloadTicks(cls: number, rarity: number): number {
  return Math.max(1, Math.round(weaponStats(cls).reloadTicks * (RARITY_RELOAD[rarity] ?? 1)));
}

/**
 * A weapon is one byte on the wire: class in the low nibble, rarity in the
 * high one. Zero means "empty handed", so ids are stored offset by one.
 */
export function packWeapon(cls: number, rarity: number): number {
  return ((cls & 0x0f) | ((rarity & 0x0f) << 4)) + 1;
}

export function unpackWeapon(packed: number): { cls: number; rarity: number } | null {
  if (packed === 0) return null;
  const v = packed - 1;
  return { cls: v & 0x0f, rarity: (v >> 4) & 0x0f };
}

export function weaponLabel(packed: number): string {
  const w = unpackWeapon(packed);
  if (w === null) return 'unarmed';
  return `${RARITY_NAMES[w.rarity] ?? '?'} ${weaponStats(w.cls).name}`;
}

/** Linear falloff between the two range markers, flat outside them. */
export function damageAtRange(cls: number, rarity: number, distance: number): number {
  const stats = weaponStats(cls);
  const base = weaponDamage(cls, rarity);
  if (distance <= stats.falloffStart) return base;
  if (distance >= stats.falloffEnd) return base * stats.falloffFloor;
  const t = (distance - stats.falloffStart) / (stats.falloffEnd - stats.falloffStart);
  return base * (1 + (stats.falloffFloor - 1) * t);
}
