import { describe, expect, it } from 'vitest';
import {
  MAP_HALF,
  MAX_PLAYERS,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SPAWN_RING_RADIUS,
  dequantizeYaw,
  generateMap,
  hashMap,
  isBlocked,
} from '@br/shared';

describe('map generation', () => {
  it('produces an identical map for the same seed', () => {
    const a = generateMap(0x1234);
    const b = generateMap(0x1234);
    expect(hashMap(a)).toBe(hashMap(b));
    expect(a.boxes).toEqual(b.boxes);
    expect(a.spawns).toEqual(b.spawns);
  });

  it('is stable across repeated calls interleaved with other generation', () => {
    const first = hashMap(generateMap(7));
    generateMap(8);
    generateMap(9);
    expect(hashMap(generateMap(7))).toBe(first);
  });

  it('encloses the play area', () => {
    const map = generateMap(1);
    // A box straddling each edge, well above the ground, must hit the wall.
    for (const [x, z] of [
      [MAP_HALF + 1, 0],
      [-MAP_HALF - 1, 0],
      [0, MAP_HALF + 1],
      [0, -MAP_HALF - 1],
    ]) {
      expect(isBlocked({ x: x!, y: 1, z: z! }, PLAYER_RADIUS, PLAYER_HEIGHT, map.world)).toBe(true);
    }
  });

  it('gives every possible player a spawn that is not inside geometry', () => {
    const map = generateMap(42);
    expect(map.spawns.length).toBe(MAX_PLAYERS);
    for (const spawn of map.spawns) {
      expect(isBlocked(spawn.pos, PLAYER_RADIUS, PLAYER_HEIGHT, map.world)).toBe(false);
      expect(Math.hypot(spawn.pos.x, spawn.pos.z)).toBeCloseTo(SPAWN_RING_RADIUS, 2);
    }
  });

  it('points every spawn back towards the middle of the map', () => {
    for (const spawn of generateMap(3).spawns) {
      const yaw = dequantizeYaw(spawn.yawQ);
      // Camera-space forward for a given yaw.
      const forwardX = -Math.sin(yaw);
      const forwardZ = -Math.cos(yaw);
      const toCentre = Math.hypot(spawn.pos.x, spawn.pos.z);
      const dot = (forwardX * -spawn.pos.x + forwardZ * -spawn.pos.z) / toCentre;
      expect(dot).toBeGreaterThan(0.999);
    }
  });
});
