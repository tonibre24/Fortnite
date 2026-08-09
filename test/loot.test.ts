import { describe, expect, it } from 'vitest';
import {
  CHEST_RARITY_WEIGHTS,
  FLOOR_RARITY_WEIGHTS,
  INVENTORY_SLOTS,
  ItemKind,
  MEDKIT_STACK,
  MEDKIT_USE_TICKS,
  PICKUP_RANGE,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_SHIELD,
  RARITY_COUNT,
  Rarity,
  Rng,
  RoundPhase,
  SHIELD_POTION_GAIN,
  SHIELD_POTION_USE_TICKS,
  WeaponClass,
  createPlayerState,
  emptyStack,
  generateLootSpawns,
  generateMap,
  isConsumableKind,
  isWeaponKind,
  kindOfWeaponClass,
  maxStack,
  rollItem,
  rollRarity,
  unpackWeapon,
  weaponClassOf,
  weaponStats,
  type InputCommand,
} from '@br/shared';
import { LootField, PickupResult, consume, dropInventory, giveWeapon, tryPickup } from '../server/src/Loot.js';
import { World } from '../server/src/World.js';
import { Button } from '@br/shared';

const SEED = 0x10077;

function player(x = 0, y = 0, z = 0) {
  const state = createPlayerState(1);
  state.pos.x = x;
  state.pos.y = y;
  state.pos.z = z;
  return state;
}

function field(): LootField {
  const map = generateMap(SEED);
  return new LootField(map, new Rng(SEED));
}

function cmd(overrides: Partial<InputCommand> = {}): InputCommand {
  return { seq: 1, buttons: 0, yawQ: 0, pitchQ: 0, renderTick: 0, slot: 0, ...overrides };
}

describe('item definitions', () => {
  it('maps weapon kinds onto weapon classes both ways', () => {
    for (let cls = 0; cls < 4; cls++) {
      const kind = kindOfWeaponClass(cls);
      expect(isWeaponKind(kind)).toBe(true);
      expect(weaponClassOf(kind)).toBe(cls);
    }
    expect(isWeaponKind(ItemKind.None)).toBe(false);
    expect(isWeaponKind(ItemKind.Medkit)).toBe(false);
    expect(isConsumableKind(ItemKind.Medkit)).toBe(true);
    expect(isConsumableKind(ItemKind.ShieldPotion)).toBe(true);
    expect(isConsumableKind(ItemKind.Chest)).toBe(false);
  });

  it('only lets consumables stack', () => {
    expect(maxStack(ItemKind.Medkit)).toBe(MEDKIT_STACK);
    expect(maxStack(kindOfWeaponClass(WeaponClass.Rifle))).toBe(1);
  });

  it('rolls every rarity given enough tries, and only legal ones', () => {
    const rng = new Rng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const rarity = rollRarity(rng, FLOOR_RARITY_WEIGHTS);
      expect(rarity).toBeGreaterThanOrEqual(0);
      expect(rarity).toBeLessThan(RARITY_COUNT);
      seen.add(rarity);
    }
    expect(seen.size).toBe(RARITY_COUNT);
  });

  it('makes chests better than the floor on average', () => {
    const floor = averageRarity(FLOOR_RARITY_WEIGHTS);
    const chest = averageRarity(CHEST_RARITY_WEIGHTS);
    expect(chest).toBeGreaterThan(floor);
  });

  it('rolls weapons with a full magazine and consumables with a legal stack', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 500; i++) {
      const item = rollItem(rng, FLOOR_RARITY_WEIGHTS);
      if (isWeaponKind(item.kind)) {
        expect(item.count).toBe(weaponStats(weaponClassOf(item.kind)).magazine);
      } else {
        expect(isConsumableKind(item.kind)).toBe(true);
        expect(item.count).toBeGreaterThanOrEqual(1);
        expect(item.count).toBeLessThanOrEqual(maxStack(item.kind));
      }
    }
  });
});

describe('loot placement', () => {
  it('is deterministic for a seed', () => {
    const map = generateMap(SEED);
    const a = generateLootSpawns(map, new Rng(3));
    const b = generateLootSpawns(map, new Rng(3));
    expect(a).toEqual(b);
  });

  it('puts loot inside buildings', () => {
    const map = generateMap(SEED);
    const spawns = generateLootSpawns(map, new Rng(3));
    expect(spawns.length).toBeGreaterThan(map.buildings.length);
    for (const spawn of spawns) {
      const inside = map.buildings.some(
        (b) => spawn.x > b.minX && spawn.x < b.maxX && spawn.z > b.minZ && spawn.z < b.maxZ,
      );
      expect(inside).toBe(true);
    }
  });

  it('spawns both chests and loose items', () => {
    const spawns = generateLootSpawns(generateMap(SEED), new Rng(3));
    expect(spawns.some((s) => s.chest)).toBe(true);
    expect(spawns.some((s) => !s.chest)).toBe(true);
  });

  it('hands out ids that never repeat', () => {
    const loot = field();
    const ids = new Set<number>();
    for (const item of loot.items.values()) {
      expect(ids.has(item.id)).toBe(false);
      ids.add(item.id);
    }
    const added = loot.add(0, 0, 0, { kind: ItemKind.Medkit, rarity: 0, count: 1 })!;
    expect(ids.has(added.id)).toBe(false);
  });
});

describe('picking things up', () => {
  it('finds only what is within reach', () => {
    const loot = field();
    loot.items.clear();
    loot.add(0, 0, 0, { kind: ItemKind.Medkit, rarity: 0, count: 1 });
    expect(loot.nearest(0, 0, 0)).not.toBeNull();
    expect(loot.nearest(PICKUP_RANGE + 1, 0, 0)).toBeNull();
  });

  it('stores an item in the first free slot', () => {
    const loot = field();
    loot.items.clear();
    const state = player();
    giveWeapon(state, WeaponClass.Rifle, Rarity.Grey, 0);
    loot.add(0, 0, 0, { kind: kindOfWeaponClass(WeaponClass.Shotgun), rarity: Rarity.Gold, count: 6 });

    expect(tryPickup(loot, state)).toBe(PickupResult.Stored);
    expect(state.inventory[1]!.kind).toBe(kindOfWeaponClass(WeaponClass.Shotgun));
    expect(state.inventory[1]!.rarity).toBe(Rarity.Gold);
    expect(loot.items.size).toBe(0);
  });

  it('stacks consumables instead of using another slot', () => {
    const loot = field();
    loot.items.clear();
    const state = player();
    state.inventory[0] = { kind: ItemKind.Medkit, rarity: 0, count: 1 };
    loot.add(0, 0, 0, { kind: ItemKind.Medkit, rarity: 0, count: 1 });

    expect(tryPickup(loot, state)).toBe(PickupResult.Stored);
    expect(state.inventory[0]!.count).toBe(2);
    expect(state.inventory[1]!.kind).toBe(ItemKind.None);
  });

  it('swaps what is in hand when every slot is taken', () => {
    const loot = field();
    loot.items.clear();
    const state = player();
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      giveWeapon(state, WeaponClass.Pistol, Rarity.Grey, i);
    }
    state.slot = 2;
    loot.add(0, 0, 0, { kind: kindOfWeaponClass(WeaponClass.Rifle), rarity: Rarity.Purple, count: 25 });

    expect(tryPickup(loot, state)).toBe(PickupResult.Swapped);
    expect(state.inventory[2]!.kind).toBe(kindOfWeaponClass(WeaponClass.Rifle));
    // The old gun is on the floor, not destroyed.
    expect(loot.items.size).toBe(1);
    expect([...loot.items.values()][0]!.kind).toBe(kindOfWeaponClass(WeaponClass.Pistol));
  });

  it('bursts a chest into loose items and removes the chest', () => {
    const loot = field();
    loot.items.clear();
    const chest = loot.add(0, 0, 0, { kind: ItemKind.Chest, rarity: 0, count: 0 })!;
    const state = player();

    expect(tryPickup(loot, state)).toBe(PickupResult.OpenedChest);
    expect(loot.items.has(chest.id)).toBe(false);
    expect(loot.items.size).toBeGreaterThanOrEqual(2);
    for (const item of loot.items.values()) expect(item.kind).not.toBe(ItemKind.Chest);
  });

  it('does nothing when there is nothing in reach', () => {
    const loot = field();
    loot.items.clear();
    expect(tryPickup(loot, player(0, 0, 0))).toBe(PickupResult.None);
  });
});

describe('consumables', () => {
  it('heals with a medkit and spends one from the stack', () => {
    const state = player();
    state.health = 30;
    state.inventory[0] = { kind: ItemKind.Medkit, rarity: 0, count: 2 };

    expect(consume(state, 0)).toBe(true);
    expect(state.health).toBe(PLAYER_MAX_HEALTH);
    expect(state.inventory[0]!.count).toBe(1);
  });

  it('empties the slot when the last one is used', () => {
    const state = player();
    state.health = 10;
    state.inventory[0] = { kind: ItemKind.Medkit, rarity: 0, count: 1 };
    consume(state, 0);
    expect(state.inventory[0]!.kind).toBe(ItemKind.None);
  });

  it('adds shield without exceeding the cap', () => {
    const state = player();
    state.shield = PLAYER_MAX_SHIELD - 10;
    state.inventory[0] = { kind: ItemKind.ShieldPotion, rarity: 0, count: 1 };
    consume(state, 0);
    expect(state.shield).toBe(PLAYER_MAX_SHIELD);
  });

  it('refuses to waste one at full health or shield', () => {
    const state = player();
    state.health = PLAYER_MAX_HEALTH;
    state.inventory[0] = { kind: ItemKind.Medkit, rarity: 0, count: 1 };
    expect(consume(state, 0)).toBe(false);
    expect(state.inventory[0]!.count).toBe(1);

    state.shield = PLAYER_MAX_SHIELD;
    state.inventory[1] = { kind: ItemKind.ShieldPotion, rarity: 0, count: 1 };
    expect(consume(state, 1)).toBe(false);
  });

  it('will not consume a weapon or an empty slot', () => {
    const state = player();
    giveWeapon(state, WeaponClass.Rifle, Rarity.Grey, 0);
    state.inventory[1] = emptyStack();
    expect(consume(state, 0)).toBe(false);
    expect(consume(state, 1)).toBe(false);
  });
});

describe('inventory in the running world', () => {
  function world(): { world: World; p: ReturnType<World['addPlayer']> } {
    const w = new World(SEED);
    const p = w.addPlayer(1, 'p');
    w.loot.items.clear();
    w.round.state.phase = RoundPhase.Playing;
    return { world: w, p };
  }

  it('switches the held slot from the command', () => {
    const { world: w, p } = world();
    giveWeapon(p.state, WeaponClass.Shotgun, Rarity.Blue, 3);
    p.enqueue([cmd({ seq: 1, slot: 3 })]);
    w.step();

    expect(p.state.slot).toBe(3);
    expect(unpackWeapon(p.state.weapon)).toEqual({ cls: WeaponClass.Shotgun, rarity: Rarity.Blue });
  });

  it('shows no weapon while holding an empty slot', () => {
    const { world: w, p } = world();
    p.enqueue([cmd({ seq: 1, slot: 4 })]);
    w.step();
    expect(p.state.weapon).toBe(0);
    expect(p.state.ammo).toBe(0);
  });

  it('picks up on a press of interact, not once per tick held', () => {
    const { world: w, p } = world();
    for (let i = 0; i < 3; i++) {
      w.loot.add(p.state.pos.x, p.state.pos.y, p.state.pos.z, {
        kind: ItemKind.Medkit,
        rarity: 0,
        count: 1,
      });
    }
    // Hold interact down for several ticks.
    for (let seq = 1; seq <= 5; seq++) {
      p.enqueue([cmd({ seq, buttons: Button.Interact })]);
      w.step();
    }
    expect(w.pickupCount).toBe(1);

    // Release and press again.
    p.enqueue([cmd({ seq: 6, buttons: 0 })]);
    w.step();
    p.enqueue([cmd({ seq: 7, buttons: Button.Interact })]);
    w.step();
    expect(w.pickupCount).toBe(2);
  });

  it('drinks a shield potion after holding fire long enough', () => {
    const { world: w, p } = world();
    p.state.inventory[1] = { kind: ItemKind.ShieldPotion, rarity: 0, count: 1 };
    p.state.shield = 0;

    for (let seq = 1; seq <= SHIELD_POTION_USE_TICKS + 2; seq++) {
      p.enqueue([cmd({ seq, buttons: Button.Fire, slot: 1 })]);
      w.step();
    }
    expect(p.state.shield).toBe(SHIELD_POTION_GAIN);
    expect(p.state.inventory[1]!.kind).toBe(ItemKind.None);
  });

  it('cancels a part-finished heal when the trigger is released', () => {
    const { world: w, p } = world();
    p.state.inventory[1] = { kind: ItemKind.Medkit, rarity: 0, count: 1 };
    p.state.health = 20;

    for (let seq = 1; seq <= MEDKIT_USE_TICKS - 5; seq++) {
      p.enqueue([cmd({ seq, buttons: Button.Fire, slot: 1 })]);
      w.step();
    }
    p.enqueue([cmd({ seq: 999, buttons: 0, slot: 1 })]);
    w.step();
    expect(p.state.health).toBe(20);
    expect(p.state.inventory[1]!.count).toBe(1);
  });

  it('keeps ammo per slot rather than sharing one pool', () => {
    const { world: w, p } = world();
    giveWeapon(p.state, WeaponClass.Rifle, Rarity.Grey, 0);
    giveWeapon(p.state, WeaponClass.Pistol, Rarity.Grey, 1);

    // Empty a few rounds out of the rifle.
    p.state.inventory[0]!.count = 7;
    p.enqueue([cmd({ seq: 1, slot: 0 })]);
    w.step();
    expect(p.state.ammo).toBe(7);

    p.enqueue([cmd({ seq: 2, slot: 1 })]);
    w.step();
    expect(p.state.ammo).toBe(weaponStats(WeaponClass.Pistol).magazine);

    p.enqueue([cmd({ seq: 3, slot: 0 })]);
    w.step();
    expect(p.state.ammo).toBe(7);
  });

  it('spills everything a player was carrying when they die', () => {
    const { world: w, p } = world();
    giveWeapon(p.state, WeaponClass.Rifle, Rarity.Purple, 0);
    p.state.inventory[1] = { kind: ItemKind.Medkit, rarity: 0, count: 2 };

    dropInventory(w.loot, p.state);
    expect(w.loot.items.size).toBe(2);
    expect(p.state.inventory.every((s) => s.kind === ItemKind.None)).toBe(true);
    expect(p.state.weapon).toBe(0);
  });

  it('drops a dead player loot into the world', () => {
    const w = new World(SEED);
    const victim = w.addPlayer(1, 'victim');
    const killer = w.addPlayer(2, 'killer');
    w.loot.items.clear();

    w.killPlayer(victim, killer);
    expect(w.loot.items.size).toBeGreaterThan(0);
  });
});

function averageRarity(weights: readonly number[]): number {
  let total = 0;
  let weighted = 0;
  for (let i = 0; i < weights.length; i++) {
    total += weights[i]!;
    weighted += weights[i]! * i;
  }
  return weighted / total;
}
