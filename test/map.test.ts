import { describe, expect, it } from 'vitest';
import {
  BUILDING_STOREY_HEIGHT,
  Button,
  GROUND_Y,
  MAP_HALF,
  MAX_PLAYERS,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  POI_COUNT,
  SPAWN_RING_RADIUS,
  STEP_HEIGHT,
  TICK_DT,
  createPlayerState,
  dequantizeYaw,
  generateMap,
  hashMap,
  isBlocked,
  quantizeYaw,
  stairwellSlot,
  stepMovement,
  terrainHeightAt,
  type Building,
  type GameMap,
  type Vec3,
} from '@br/shared';

const SEEDS = [1, 2, 0xbadc0de, 0x5eed1234];

/** Walks a player forward for a while and returns where they ended up. */
function walk(map: GameMap, from: Vec3, yaw: number, ticks: number, buttons = Button.Forward): Vec3 {
  const state = createPlayerState(1);
  state.pos.x = from.x;
  state.pos.y = from.y;
  state.pos.z = from.z;
  const yawQ = quantizeYaw(yaw);
  for (let i = 0; i < ticks; i++) {
    stepMovement(state, { seq: i + 1, buttons, yawQ, pitchQ: 0, renderTick: 0 }, map.world, TICK_DT);
  }
  return { ...state.pos };
}

function insideFootprint(building: Building, pos: Vec3): boolean {
  return (
    pos.x > building.minX && pos.x < building.maxX && pos.z > building.minZ && pos.z < building.maxZ
  );
}

/** Outward normal and the yaw that faces back through the door. */
function doorApproach(map: GameMap, b: Building): { start: Vec3; yaw: number } {
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const away = 6;
  const at = (x: number, z: number): Vec3 => ({
    x,
    // Stand on whatever the terrain is doing out here, not on the building's
    // own base height, which may be a hill tier above or below.
    y: Math.max(b.baseY, terrainHeightAt(map.hills, x, z)) + 0.05,
    z,
  });
  switch (b.doorSide) {
    case 0:
      // Door in the -Z wall: stand further out in -Z and walk towards +Z.
      return { start: at(cx, b.minZ - away), yaw: Math.PI };
    case 1:
      return { start: at(cx, b.maxZ + away), yaw: 0 };
    case 2:
      return { start: at(b.minX - away, cz), yaw: -Math.PI / 2 };
    default:
      return { start: at(b.maxX + away, cz), yaw: Math.PI / 2 };
  }
}

describe('map generation', () => {
  it('produces an identical map for the same seed', () => {
    const a = generateMap(0x1234);
    const b = generateMap(0x1234);
    expect(hashMap(a)).toBe(hashMap(b));
    expect(a.boxes).toEqual(b.boxes);
    expect(a.spawns).toEqual(b.spawns);
    expect(a.buildings).toEqual(b.buildings);
  });

  it('produces a different map for a different seed', () => {
    const hashes = SEEDS.map((seed) => hashMap(generateMap(seed)));
    expect(new Set(hashes).size).toBe(SEEDS.length);
  });

  it('is unaffected by generating other maps in between', () => {
    const first = hashMap(generateMap(7));
    generateMap(8);
    generateMap(9);
    expect(hashMap(generateMap(7))).toBe(first);
  });

  it('builds the advertised number of points of interest', () => {
    for (const seed of SEEDS) {
      const map = generateMap(seed);
      expect(map.pois.length).toBe(POI_COUNT);
      expect(map.buildings.length).toBeGreaterThanOrEqual(POI_COUNT * 2);
    }
  });

  it('encloses the play area', () => {
    const map = generateMap(1);
    for (const [x, z] of [
      [MAP_HALF + 1, 0],
      [-MAP_HALF - 1, 0],
      [0, MAP_HALF + 1],
      [0, -MAP_HALF - 1],
    ]) {
      expect(isBlocked({ x: x!, y: 1, z: z! }, PLAYER_RADIUS, PLAYER_HEIGHT, map.world)).toBe(true);
    }
  });

  it('keeps buildings inside the play area', () => {
    for (const seed of SEEDS) {
      for (const b of generateMap(seed).buildings) {
        expect(b.minX).toBeGreaterThan(-MAP_HALF);
        expect(b.maxX).toBeLessThan(MAP_HALF);
        expect(b.minZ).toBeGreaterThan(-MAP_HALF);
        expect(b.maxZ).toBeLessThan(MAP_HALF);
      }
    }
  });

  it('never overlaps two buildings', () => {
    for (const seed of SEEDS) {
      const buildings = generateMap(seed).buildings;
      for (let i = 0; i < buildings.length; i++) {
        for (let j = i + 1; j < buildings.length; j++) {
          const a = buildings[i]!;
          const b = buildings[j]!;
          const overlap = a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
          expect(overlap).toBe(false);
        }
      }
    }
  });
});

describe('terrain', () => {
  it('agrees with the collision geometry about where the ground is', () => {
    const map = generateMap(11);
    for (const hill of map.hills) {
      const top = terrainHeightAt(map.hills, hill.x, hill.z);
      // Standing on the reported surface is legal; sunk a hair below it is not.
      expect(isBlocked({ x: hill.x, y: top, z: hill.z }, PLAYER_RADIUS, PLAYER_HEIGHT, map.world)).toBe(
        false,
      );
      expect(
        isBlocked({ x: hill.x, y: top - 0.1, z: hill.z }, PLAYER_RADIUS, PLAYER_HEIGHT, map.world),
      ).toBe(true);
    }
  });

  it('keeps every hill tier within one step of the next', () => {
    const map = generateMap(5);
    for (const hill of map.hills) {
      for (let tier = 0; tier < hill.tiers; tier++) {
        const half = hill.radius * (1 - tier / hill.tiers);
        const outside = terrainHeightAt(map.hills, hill.x + half + 0.01, hill.z);
        const inside = terrainHeightAt(map.hills, hill.x + half - 0.01, hill.z);
        expect(inside - outside).toBeLessThanOrEqual(STEP_HEIGHT);
      }
    }
  });

  it('lets a player walk up a hill instead of bouncing off it', () => {
    const map = generateMap(5);
    const hill = [...map.hills].sort((a, b) => b.tiers - a.tiers)[0]!;
    const start = { x: hill.x - hill.radius - 2, y: GROUND_Y, z: hill.z };
    const end = walk(map, start, -Math.PI / 2, 90, Button.Forward);
    expect(end.x).toBeGreaterThan(hill.x - 1);
    expect(end.y).toBeGreaterThan(GROUND_Y + 0.4);
  });
});

describe('buildings', () => {
  it('are hollow rather than solid blocks', () => {
    for (const seed of SEEDS) {
      const map = generateMap(seed);
      for (const b of map.buildings) {
        const centre = {
          x: (b.minX + b.maxX) / 2,
          y: b.baseY + 0.05,
          z: (b.minZ + b.maxZ) / 2,
        };
        expect(isBlocked(centre, PLAYER_RADIUS, PLAYER_HEIGHT, map.world)).toBe(false);
      }
    }
  });

  it('can be walked into through the door', () => {
    let entered = 0;
    let total = 0;
    for (const seed of SEEDS) {
      const map = generateMap(seed);
      for (const b of map.buildings) {
        total += 1;
        const { start, yaw } = doorApproach(map, b);
        const end = walk(map, start, yaw, 60);
        if (insideFootprint(b, end)) entered += 1;
      }
    }
    // A straight blind walk can be deflected by a tree or a neighbour's stair,
    // but the overwhelming majority of doors must actually work.
    expect(total).toBeGreaterThan(50);
    expect(entered / total).toBeGreaterThan(0.9);
  });

  it('lets a player climb to the upper floor of a two-storey building', () => {
    let climbed = 0;
    let total = 0;
    for (const seed of SEEDS) {
      const map = generateMap(seed);
      for (const b of map.buildings) {
        if (b.storeys < 2) continue;
        total += 1;
        // Stand in the room at the foot of the stairwell and climb towards +Z.
        const slot = stairwellSlot(b, b.doorSide);
        const start = {
          x: (slot.minX + slot.maxX) / 2,
          y: b.baseY + 0.05,
          z: b.minZ + 1.0,
        };
        const end = walk(map, start, Math.PI, 90);
        if (end.y > b.baseY + BUILDING_STOREY_HEIGHT - 0.5) climbed += 1;
      }
    }
    expect(total).toBeGreaterThan(5);
    expect(climbed / total).toBeGreaterThan(0.8);
  });

  it('leaves the doorway itself clear', () => {
    for (const seed of SEEDS) {
      const map = generateMap(seed);
      for (const b of map.buildings) {
        const cx = (b.minX + b.maxX) / 2;
        const cz = (b.minZ + b.maxZ) / 2;
        // A point standing in the gap in the wall must be walkable, which is
        // what proves the external stair went on the far side.
        const gap =
          b.doorSide === 0
            ? { x: cx, y: b.baseY + 0.05, z: b.minZ + 0.5 }
            : b.doorSide === 1
              ? { x: cx, y: b.baseY + 0.05, z: b.maxZ - 0.5 }
              : b.doorSide === 2
                ? { x: b.minX + 0.5, y: b.baseY + 0.05, z: cz }
                : { x: b.maxX - 0.5, y: b.baseY + 0.05, z: cz };
        expect(isBlocked(gap, PLAYER_RADIUS, PLAYER_HEIGHT, map.world)).toBe(false);
      }
    }
  });
});

describe('spawns', () => {
  it('gives every possible player a clear spot on the ground', () => {
    for (const seed of SEEDS) {
      const map = generateMap(seed);
      expect(map.spawns.length).toBe(MAX_PLAYERS);
      for (const spawn of map.spawns) {
        expect(isBlocked(spawn.pos, PLAYER_RADIUS, PLAYER_HEIGHT, map.world)).toBe(false);
        expect(Math.hypot(spawn.pos.x, spawn.pos.z)).toBeCloseTo(SPAWN_RING_RADIUS, 2);
        expect(spawn.pos.y).toBe(terrainHeightAt(map.hills, spawn.pos.x, spawn.pos.z));
      }
    }
  });

  it('points every spawn back towards the middle of the map', () => {
    for (const spawn of generateMap(3).spawns) {
      const yaw = dequantizeYaw(spawn.yawQ);
      const forwardX = -Math.sin(yaw);
      const forwardZ = -Math.cos(yaw);
      const toCentre = Math.hypot(spawn.pos.x, spawn.pos.z);
      const dot = (forwardX * -spawn.pos.x + forwardZ * -spawn.pos.z) / toCentre;
      expect(dot).toBeGreaterThan(0.999);
    }
  });

  it('does not leave a player stuck when dropped anywhere on the map', () => {
    const map = generateMap(77);
    let stuck = 0;
    const samples = 400;
    for (let i = 0; i < samples; i++) {
      // Deterministic lattice rather than random, so a failure reproduces.
      const x = -MAP_HALF + 5 + ((i * 37) % 490);
      const z = -MAP_HALF + 5 + ((i * 91) % 490);
      // Dropped from above, a player must settle onto a surface and be free to
      // walk off it rather than ending up embedded in geometry.
      const landed = walk(map, { x, y: 60, z }, 0, 140, 0);
      if (isBlocked(landed, PLAYER_RADIUS, PLAYER_HEIGHT, map.world)) stuck += 1;
    }
    expect(stuck).toBe(0);
  });
});
