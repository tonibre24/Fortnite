import { COLLISION_CELL_SIZE, COLLISION_SKIN, MAP_HALF, MAX_RESOLVE_PASSES } from './constants.js';

/** An axis-aligned box. Every piece of world geometry is one of these. */
export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export const Axis = { X: 0, Y: 1, Z: 2 } as const;
export type AxisIndex = (typeof Axis)[keyof typeof Axis];

/**
 * Solid geometry indexed by a uniform XZ grid. Iteration order is fixed by the
 * grid layout and the input array order, so a query returns the same boxes in
 * the same order on client and server - which is what keeps collision
 * resolution bit-identical between them.
 */
export class CollisionWorld {
  readonly boxes: readonly Box[];
  private readonly cells: number[][];
  private readonly gridSize: number;
  private readonly origin: number;
  /** Per-box stamp used to de-duplicate boxes spanning several cells. */
  private readonly seen: Int32Array;
  private stamp = 0;

  constructor(boxes: readonly Box[]) {
    this.boxes = boxes;
    this.origin = -MAP_HALF;
    this.gridSize = Math.ceil((MAP_HALF * 2) / COLLISION_CELL_SIZE) + 1;
    this.cells = Array.from({ length: this.gridSize * this.gridSize }, () => []);
    this.seen = new Int32Array(boxes.length);

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      const x0 = this.cellIndex(box.minX);
      const x1 = this.cellIndex(box.maxX);
      const z0 = this.cellIndex(box.minZ);
      const z1 = this.cellIndex(box.maxZ);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          this.cells[cz * this.gridSize + cx]!.push(i);
        }
      }
    }
  }

  private cellIndex(coord: number): number {
    const i = Math.floor((coord - this.origin) / COLLISION_CELL_SIZE);
    return i < 0 ? 0 : i >= this.gridSize ? this.gridSize - 1 : i;
  }

  /** Appends indices of every box overlapping the given AABB to `out`. */
  query(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: number[],
  ): void {
    out.length = 0;
    this.stamp += 1;
    if (this.stamp === 0x7fffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    const x0 = this.cellIndex(minX);
    const x1 = this.cellIndex(maxX);
    const z0 = this.cellIndex(minZ);
    const z1 = this.cellIndex(maxZ);
    for (let cz = z0; cz <= z1; cz++) {
      const row = cz * this.gridSize;
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this.cells[row + cx]!;
        for (let k = 0; k < bucket.length; k++) {
          const index = bucket[k]!;
          if (this.seen[index] === stamp) continue;
          this.seen[index] = stamp;
          const box = this.boxes[index]!;
          if (
            box.maxX > minX &&
            box.minX < maxX &&
            box.maxY > minY &&
            box.minY < maxY &&
            box.maxZ > minZ &&
            box.minZ < maxZ
          ) {
            out.push(index);
          }
        }
      }
    }
    // The grid visits cells in a fixed order but a box straddling cells lands
    // wherever it was first seen; sorting makes the result order depend only on
    // the box list, never on the traversal.
    out.sort(numeric);
  }
}

function numeric(a: number, b: number): number {
  return a - b;
}

/** Mutable box used as scratch space so the hot path allocates nothing. */
const scratch: number[] = [];

/**
 * Moves an axis-aligned player box along one axis and pushes it back out of
 * anything it ended up inside. Returns true when a push-out happened, which the
 * caller uses to zero the corresponding velocity component.
 *
 * `pos` is the centre on X/Z and the *feet* on Y.
 */
export function sweepAxis(
  pos: { x: number; y: number; z: number },
  axis: AxisIndex,
  delta: number,
  radius: number,
  height: number,
  world: CollisionWorld,
): boolean {
  if (delta === 0) return false;

  if (axis === Axis.X) pos.x += delta;
  else if (axis === Axis.Y) pos.y += delta;
  else pos.z += delta;

  let hit = false;
  for (let pass = 0; pass < MAX_RESOLVE_PASSES; pass++) {
    const minX = pos.x - radius;
    const maxX = pos.x + radius;
    const minY = pos.y;
    const maxY = pos.y + height;
    const minZ = pos.z - radius;
    const maxZ = pos.z + radius;

    world.query(minX, minY, minZ, maxX, maxY, maxZ, scratch);
    if (scratch.length === 0) break;

    // Push back against the direction of travel by the deepest overlap.
    let deepest = 0;
    for (let i = 0; i < scratch.length; i++) {
      const box = world.boxes[scratch[i]!]!;
      let penetration: number;
      if (axis === Axis.X) penetration = delta > 0 ? maxX - box.minX : box.maxX - minX;
      else if (axis === Axis.Y) penetration = delta > 0 ? maxY - box.minY : box.maxY - minY;
      else penetration = delta > 0 ? maxZ - box.minZ : box.maxZ - minZ;
      if (penetration > deepest) deepest = penetration;
    }
    if (deepest <= 0) break;

    const push = (delta > 0 ? -1 : 1) * (deepest + COLLISION_SKIN);
    if (axis === Axis.X) pos.x += push;
    else if (axis === Axis.Y) pos.y += push;
    else pos.z += push;
    hit = true;
  }
  return hit;
}

/** True when the player box at `pos` overlaps any solid geometry. */
export function isBlocked(
  pos: { x: number; y: number; z: number },
  radius: number,
  height: number,
  world: CollisionWorld,
): boolean {
  world.query(
    pos.x - radius,
    pos.y,
    pos.z - radius,
    pos.x + radius,
    pos.y + height,
    pos.z + radius,
    scratch,
  );
  return scratch.length > 0;
}
