import {
  CHEST_ITEMS_MAX,
  CHEST_ITEMS_MIN,
  CHEST_RARITY_WEIGHTS,
  CHEST_SCATTER,
  FLOOR_RARITY_WEIGHTS,
  INVENTORY_SLOTS,
  ItemKind,
  MEDKIT_HEAL,
  PICKUP_RANGE,
  Rng,
  SHIELD_POTION_GAIN,
  clampHealth,
  clampShield,
  emptyStack,
  f32,
  generateLootSpawns,
  isConsumableKind,
  isWeaponKind,
  kindOfWeaponClass,
  maxStack,
  rollItem,
  unpackWeapon,
  weaponStats,
  type GameMap,
  type ItemStack,
  type LootItem,
  type PlayerState,
} from '@br/shared';

/**
 * All the loose items in the world.
 *
 * Ids are handed out once and never reused within a round, so the snapshot
 * delta can treat "id present" and "id absent" as the whole story.
 */
export class LootField {
  readonly items = new Map<number, LootItem>();
  private nextId = 1;

  constructor(
    private readonly map: GameMap,
    private readonly rng: Rng,
  ) {
    for (const spawn of generateLootSpawns(map, rng)) {
      if (spawn.chest) {
        this.add(spawn.x, spawn.y, spawn.z, { kind: ItemKind.Chest, rarity: 0, count: 0 });
      } else {
        this.add(spawn.x, spawn.y, spawn.z, rollItem(rng, FLOOR_RARITY_WEIGHTS));
      }
    }
  }

  add(x: number, y: number, z: number, stack: ItemStack): LootItem | null {
    // Ids are a u16 on the wire; a round that somehow exhausts them stops
    // spawning rather than aliasing an existing item.
    if (this.nextId > 0xffff) return null;
    const item: LootItem = {
      id: this.nextId++,
      x: f32(x),
      y: f32(y),
      z: f32(z),
      kind: stack.kind,
      rarity: stack.rarity,
      count: stack.count,
    };
    this.items.set(item.id, item);
    return item;
  }

  remove(id: number): void {
    this.items.delete(id);
  }

  /** Closest item within reach of a position, or null. */
  nearest(x: number, y: number, z: number): LootItem | null {
    let best: LootItem | null = null;
    let bestDistSq = PICKUP_RANGE * PICKUP_RANGE;
    for (const item of this.items.values()) {
      const dx = item.x - x;
      const dy = item.y - y;
      const dz = item.z - z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq >= bestDistSq) continue;
      bestDistSq = distSq;
      best = item;
    }
    return best;
  }

  /** Bursts a chest into loose items around where it stood. */
  openChest(chest: LootItem): void {
    this.remove(chest.id);
    const count = this.rng.int(CHEST_ITEMS_MIN, CHEST_ITEMS_MAX);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + this.rng.next();
      this.add(
        chest.x + Math.cos(angle) * CHEST_SCATTER,
        chest.y,
        chest.z + Math.sin(angle) * CHEST_SCATTER,
        rollItem(this.rng, CHEST_RARITY_WEIGHTS),
      );
    }
  }

  /** Drops a stack at a position, nudged so it does not sit inside a wall. */
  drop(x: number, y: number, z: number, stack: ItemStack): void {
    if (stack.kind === ItemKind.None) return;
    this.add(x, y, z, stack);
  }

  get mapRef(): GameMap {
    return this.map;
  }
}

/** Where a pickup ended up, so the caller can report it. */
export const PickupResult = {
  None: 0,
  Stored: 1,
  Swapped: 2,
  OpenedChest: 3,
} as const;

/**
 * Tries to take whatever is in reach. Consumables stack, anything else goes
 * into the first free slot; with nothing free it swaps for what is in hand and
 * leaves that on the floor.
 */
export function tryPickup(loot: LootField, state: PlayerState): number {
  const item = loot.nearest(state.pos.x, state.pos.y, state.pos.z);
  if (item === null) return PickupResult.None;

  if (item.kind === ItemKind.Chest) {
    loot.openChest(item);
    return PickupResult.OpenedChest;
  }

  const incoming: ItemStack = { kind: item.kind, rarity: item.rarity, count: item.count };

  if (isConsumableKind(incoming.kind)) {
    for (const slot of state.inventory) {
      if (slot.kind !== incoming.kind || slot.count >= maxStack(slot.kind)) continue;
      const room = maxStack(slot.kind) - slot.count;
      const moved = Math.min(room, incoming.count);
      slot.count += moved;
      incoming.count -= moved;
      if (incoming.count === 0) {
        loot.remove(item.id);
        return PickupResult.Stored;
      }
    }
  }

  const free = state.inventory.findIndex((slot) => slot.kind === ItemKind.None);
  if (free >= 0) {
    state.inventory[free] = incoming;
    loot.remove(item.id);
    return PickupResult.Stored;
  }

  // Nothing free: trade what is in hand for what is on the floor.
  const held = state.inventory[state.slot]!;
  loot.remove(item.id);
  loot.drop(state.pos.x, state.pos.y, state.pos.z, held);
  state.inventory[state.slot] = incoming;
  return PickupResult.Swapped;
}

/** Applies a finished consumable and clears the slot when it runs out. */
export function consume(state: PlayerState, slotIndex: number): boolean {
  const slot = state.inventory[slotIndex];
  if (slot === undefined || !isConsumableKind(slot.kind) || slot.count <= 0) return false;

  if (slot.kind === ItemKind.Medkit) {
    if (state.health >= 100) return false;
    state.health = clampHealth(state.health + MEDKIT_HEAL);
  } else {
    if (state.shield >= 100) return false;
    state.shield = clampShield(state.shield + SHIELD_POTION_GAIN);
  }

  slot.count -= 1;
  if (slot.count <= 0) state.inventory[slotIndex] = emptyStack();
  return true;
}

/**
 * Mirrors the held slot into the replicated weapon and ammo fields, which is
 * what combat and every other client read.
 */
export function syncHeldWeapon(state: PlayerState): void {
  if (state.slot < 0 || state.slot >= INVENTORY_SLOTS) state.slot = 0;
  const slot = state.inventory[state.slot]!;
  if (!isWeaponKind(slot.kind)) {
    state.weapon = 0;
    state.ammo = 0;
    return;
  }
  const cls = slot.kind - ItemKind.Pistol;
  state.weapon = packWeaponByte(cls, slot.rarity);
  state.ammo = Math.min(slot.count, weaponStats(cls).magazine);
}

/** Writes ammo spent or reloaded back into the slot that owns it. */
export function syncAmmoToSlot(state: PlayerState): void {
  const slot = state.inventory[state.slot];
  if (slot === undefined || !isWeaponKind(slot.kind)) return;
  slot.count = state.ammo;
}

function packWeaponByte(cls: number, rarity: number): number {
  return ((cls & 0x0f) | ((rarity & 0x0f) << 4)) + 1;
}

/** Everything a player was carrying, scattered where they fell. */
export function dropInventory(loot: LootField, state: PlayerState): void {
  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    if (slot.kind === ItemKind.None) continue;
    const angle = (i / state.inventory.length) * Math.PI * 2;
    loot.drop(
      state.pos.x + Math.cos(angle) * CHEST_SCATTER,
      state.pos.y,
      state.pos.z + Math.sin(angle) * CHEST_SCATTER,
      slot,
    );
    state.inventory[i] = emptyStack();
  }
  state.weapon = 0;
  state.ammo = 0;
}

/** Reserved so a starter weapon can be granted without going through loot. */
export function giveWeapon(state: PlayerState, cls: number, rarity: number, slotIndex: number): void {
  state.inventory[slotIndex] = {
    kind: kindOfWeaponClass(cls),
    rarity,
    count: weaponStats(cls).magazine,
  };
  if (unpackWeapon(state.weapon) === null) state.slot = slotIndex;
  syncHeldWeapon(state);
}
