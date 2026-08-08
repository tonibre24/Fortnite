import { type Box, CollisionWorld } from './collision.js';
import {
  COLOR_BOUNDARY,
  COLOR_GROUND,
  GROUND_Y,
  MAP_HALF,
  MAP_WALL_HEIGHT,
  MAP_WALL_THICKNESS,
  MAX_PLAYERS,
  SPAWN_RING_RADIUS,
} from './constants.js';
import { hashNumbers } from './rng.js';
import { f32, quantizeYaw, type Vec3 } from './math.js';

/** A box with the extra bits the renderer needs. Non-solid boxes are decoration. */
export interface MapBox extends Box {
  color: number;
  solid: boolean;
}

/** A start position plus the direction to face, already quantized for the wire. */
export interface Spawn {
  pos: Vec3;
  yawQ: number;
}

export interface GameMap {
  seed: number;
  boxes: MapBox[];
  /** Only the solid boxes, indexed for queries. */
  world: CollisionWorld;
  spawns: Spawn[];
}

/** Depth of the ground slab. Anything thinner risks tunnelling at high speed. */
const GROUND_THICKNESS = 2;

export function box(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  color: number,
  solid = true,
): MapBox {
  return { minX, minY, minZ, maxX, maxY, maxZ, color, solid };
}

/** Convenience constructor from a centre and full extents. */
export function boxAt(
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  color: number,
  solid = true,
): MapBox {
  const hx = sx / 2;
  const hz = sz / 2;
  return box(cx - hx, cy, cz - hz, cx + hx, cy + sy, cz + hz, color, solid);
}

/**
 * Builds the world from a seed. Client and server both call this and must end
 * up with byte-identical geometry - see `hashMap`, which the client checks
 * against the server's value on join.
 */
export function generateMap(seed: number): GameMap {
  const boxes: MapBox[] = [];

  boxes.push(
    box(-MAP_HALF, GROUND_Y - GROUND_THICKNESS, -MAP_HALF, MAP_HALF, GROUND_Y, MAP_HALF, COLOR_GROUND),
  );
  addBoundaryWalls(boxes);

  const solid = boxes.filter((b) => b.solid);
  return {
    seed,
    boxes,
    world: new CollisionWorld(solid),
    spawns: buildSpawnRing(),
  };
}

function addBoundaryWalls(boxes: MapBox[]): void {
  const t = MAP_WALL_THICKNESS;
  const top = GROUND_Y + MAP_WALL_HEIGHT;
  // North / south run the full width; east / west sit between them.
  boxes.push(box(-MAP_HALF - t, GROUND_Y, -MAP_HALF - t, MAP_HALF + t, top, -MAP_HALF, COLOR_BOUNDARY));
  boxes.push(box(-MAP_HALF - t, GROUND_Y, MAP_HALF, MAP_HALF + t, top, MAP_HALF + t, COLOR_BOUNDARY));
  boxes.push(box(-MAP_HALF - t, GROUND_Y, -MAP_HALF, -MAP_HALF, top, MAP_HALF, COLOR_BOUNDARY));
  boxes.push(box(MAP_HALF, GROUND_Y, -MAP_HALF, MAP_HALF + t, top, MAP_HALF, COLOR_BOUNDARY));
}

function buildSpawnRing(): Spawn[] {
  const spawns: Spawn[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const angle = (i / MAX_PLAYERS) * Math.PI * 2;
    const x = Math.cos(angle) * SPAWN_RING_RADIUS;
    const z = Math.sin(angle) * SPAWN_RING_RADIUS;
    // Positions are rounded to float32 like every other simulation value: a
    // spawn that is not exactly representable on the wire would make the
    // client's first prediction start from a different number than the
    // server's, showing up as a one-ULP correction on the first reconciliation.
    spawns.push({
      pos: { x: f32(x), y: f32(GROUND_Y), z: f32(z) },
      // Face the middle of the map rather than the boundary behind you. Forward
      // is (-sin(yaw), 0, -cos(yaw)), so yaw = atan2(x, z) points back at the
      // origin from anywhere on the ring.
      yawQ: quantizeYaw(Math.atan2(x, z)),
    });
  }
  return spawns;
}

/** Fingerprint of the generated geometry, used to prove client/server agreement. */
export function hashMap(map: GameMap): number {
  const values: number[] = [map.boxes.length];
  for (const b of map.boxes) {
    values.push(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, b.color, b.solid ? 1 : 0);
  }
  return hashNumbers(values);
}
