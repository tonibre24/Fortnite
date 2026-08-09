import {
  CHEST_CHANCE,
  CONSUMABLE_CHANCE,
  FLOOR_LOOT_MAX,
  FLOOR_LOOT_MIN,
  INVENTORY_SLOTS,
  MEDKIT_STACK,
  SHIELD_POTION_STACK,
} from './constants.js';
import { f32 } from './math.js';
import type { Building, GameMap } from './map.js';
import type { Rng } from './rng.js';
import { RARITY_COLORS, WEAPON_CLASS_COUNT, weaponStats } from './weapons.js';

/**
 * Everything that can sit on the floor or in a pocket. Weapon kinds line up
 * with weapon classes offset by one, so that zero can mean "nothing".
 */
export const ItemKind = {
  None: 0,
  Pistol: 1,
  Smg: 2,
  Rifle: 3,
  Shotgun: 4,
  Medkit: 5,
  ShieldPotion: 6,
  Chest: 7,
} as const;

export const ITEM_NAMES = [
  '',
  'pistol',
  'smg',
  'rifle',
  'shotgun',
  'medkit',
  'shield potion',
  'chest',
] as const;

export function isWeaponKind(kind: number): boolean {
  return kind >= ItemKind.Pistol && kind <= ItemKind.Shotgun;
}

export function isConsumableKind(kind: number): boolean {
  return kind === ItemKind.Medkit || kind === ItemKind.ShieldPotion;
}

export function weaponClassOf(kind: number): number {
  return kind - ItemKind.Pistol;
}

export function kindOfWeaponClass(cls: number): number {
  return cls + ItemKind.Pistol;
}

export function maxStack(kind: number): number {
  if (kind === ItemKind.Medkit) return MEDKIT_STACK;
  if (kind === ItemKind.ShieldPotion) return SHIELD_POTION_STACK;
  return 1;
}

/** One inventory slot, or one thing lying on the ground. */
export interface ItemStack {
  kind: number;
  rarity: number;
  /** Rounds in the magazine for a weapon, or how many are stacked for a consumable. */
  count: number;
}

export function emptyStack(): ItemStack {
  return { kind: ItemKind.None, rarity: 0, count: 0 };
}

export function isEmpty(stack: ItemStack): boolean {
  return stack.kind === ItemKind.None;
}

export function copyStack(out: ItemStack, src: ItemStack): ItemStack {
  out.kind = src.kind;
  out.rarity = src.rarity;
  out.count = src.count;
  return out;
}

export function cloneStack(src: ItemStack): ItemStack {
  return { kind: src.kind, rarity: src.rarity, count: src.count };
}

export function createInventory(): ItemStack[] {
  return Array.from({ length: INVENTORY_SLOTS }, emptyStack);
}

export function itemLabel(stack: ItemStack): string {
  if (isEmpty(stack)) return '';
  return ITEM_NAMES[stack.kind] ?? '?';
}

export function itemColor(stack: ItemStack): number {
  return RARITY_COLORS[stack.rarity] ?? RARITY_COLORS[0];
}

/** Picks a rarity from a weight table. */
export function rollRarity(rng: Rng, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let roll = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i]!;
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

/** Rolls one item, either a gun of some rarity or a consumable. */
export function rollItem(rng: Rng, weights: readonly number[]): ItemStack {
  if (rng.bool(CONSUMABLE_CHANCE)) {
    const kind = rng.bool() ? ItemKind.Medkit : ItemKind.ShieldPotion;
    return { kind, rarity: 0, count: rng.int(1, maxStack(kind)) };
  }
  const cls = rng.int(0, WEAPON_CLASS_COUNT - 1);
  const rarity = rollRarity(rng, weights);
  return { kind: kindOfWeaponClass(cls), rarity, count: weaponStats(cls).magazine };
}

export interface LootSpawn {
  x: number;
  y: number;
  z: number;
  /** True when this spot holds a chest rather than a loose item. */
  chest: boolean;
}

/**
 * Where loot can appear: scattered across each building's floor, plus a chest
 * in some of them. Derived from the map so both sides could agree on it, though
 * only the server actually instantiates items.
 */
export function generateLootSpawns(map: GameMap, rng: Rng): LootSpawn[] {
  const spawns: LootSpawn[] = [];
  for (const building of map.buildings) {
    const count = rng.int(FLOOR_LOOT_MIN, FLOOR_LOOT_MAX);
    for (let i = 0; i < count; i++) {
      spawns.push({ ...interiorPoint(rng, building), chest: false });
    }
    if (rng.bool(CHEST_CHANCE)) {
      spawns.push({ ...interiorPoint(rng, building), chest: true });
    }
  }
  return spawns;
}

function interiorPoint(rng: Rng, b: Building): { x: number; y: number; z: number } {
  const inset = 1.2;
  return {
    x: f32(rng.range(b.minX + inset, b.maxX - inset)),
    y: f32(b.baseY),
    z: f32(rng.range(b.minZ + inset, b.maxZ - inset)),
  };
}
