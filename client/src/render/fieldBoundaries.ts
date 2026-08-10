import { FIELD_GRID, HEDGE_CHANCE, MAP_HALF, SPAWN_CLEARANCE_RADIUS, hashNumbers, type GameMap } from '@br/shared';

/**
 * One placement point along a field boundary line. `angle` is the line's own
 * direction (0 = running along Z, PI/2 = running along X), for props that
 * need to orient along the boundary rather than face a fixed way.
 */
export interface FieldPoint {
  x: number;
  z: number;
  angle: number;
  isHedge: boolean;
}

/**
 * The map divided into a FIELD_GRID x FIELD_GRID patchwork by straight
 * interior lines, each one committed to either a hedge or a fence by a hash
 * of the map seed and the line's own index - stable regardless of how densely
 * a caller samples it, so Vegetation and FarmDressing can each call this at
 * their own spacing and still agree on which lines are which.
 *
 * Points inside a building footprint or the spawn clearance are dropped
 * rather than routed around, so a line simply has a gap there instead of
 * detouring through a wall.
 */
export function fieldBoundaryPoints(map: GameMap, spacing: number): FieldPoint[] {
  const points: FieldPoint[] = [];
  const cell = (MAP_HALF * 2) / FIELD_GRID;

  for (let i = 1; i < FIELD_GRID; i++) {
    const x = -MAP_HALF + i * cell;
    const vertical = (hashNumbers([map.seed, 0x1, i]) % 100) / 100 < HEDGE_CHANCE;
    for (let z = -MAP_HALF + spacing / 2; z < MAP_HALF; z += spacing) {
      if (blocked(map, x, z)) continue;
      points.push({ x, z, angle: 0, isHedge: vertical });
    }

    const z = -MAP_HALF + i * cell;
    const horizontal = (hashNumbers([map.seed, 0x2, i]) % 100) / 100 < HEDGE_CHANCE;
    for (let px = -MAP_HALF + spacing / 2; px < MAP_HALF; px += spacing) {
      if (blocked(map, px, z)) continue;
      points.push({ x: px, z, angle: Math.PI / 2, isHedge: horizontal });
    }
  }
  return points;
}

function blocked(map: GameMap, x: number, z: number): boolean {
  if (Math.hypot(x, z) < SPAWN_CLEARANCE_RADIUS) return true;
  for (const b of map.buildings) {
    if (x > b.minX - 2 && x < b.maxX + 2 && z > b.minZ - 2 && z < b.maxZ + 2) return true;
  }
  return false;
}
