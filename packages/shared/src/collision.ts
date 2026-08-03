import type { BoxCollider } from './arena.js';
import type { Vec3 } from './math.js';

/**
 * Axis-aligned collision primitives plus a uniform-grid broadphase.
 *
 * The grid keeps movement resolution and hitscan cheap enough to run for eight
 * players at 60 Hz on the server while remaining trivially deterministic.
 */

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export const aabbOverlaps = (a: AABB, b: AABB): boolean =>
  a.min.x < b.max.x &&
  a.max.x > b.min.x &&
  a.min.y < b.max.y &&
  a.max.y > b.min.y &&
  a.min.z < b.max.z &&
  a.max.z > b.min.z;

export interface RayHit {
  distance: number;
  point: Vec3;
  normal: Vec3;
  colliderId: string;
}

/** Slab-method ray/AABB intersection. Returns null when the ray misses. */
export function rayIntersectsAABB(
  origin: Vec3,
  direction: Vec3,
  box: AABB,
  maxDistance: number,
): { distance: number; normal: Vec3 } | null {
  let tMin = 0;
  let tMax = maxDistance;
  let normalAxis: 'x' | 'y' | 'z' = 'x';
  let normalSign = 1;

  const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
  for (const axis of axes) {
    const d = direction[axis];
    const o = origin[axis];
    const lo = box.min[axis];
    const hi = box.max[axis];

    if (Math.abs(d) < 1e-8) {
      if (o < lo || o > hi) return null;
      continue;
    }

    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    let sign = -1;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
      sign = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      normalAxis = axis;
      normalSign = sign;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }

  const normal: Vec3 = { x: 0, y: 0, z: 0 };
  normal[normalAxis] = normalSign;
  return { distance: tMin, normal };
}

/** Ray against a vertical capsule (body hitbox). */
export function rayIntersectsVerticalCapsule(
  origin: Vec3,
  direction: Vec3,
  base: Vec3,
  height: number,
  radius: number,
  maxDistance: number,
): number | null {
  const yBottom = base.y + radius;
  const yTop = base.y + height - radius;

  let best: number | null = null;
  const consider = (t: number): void => {
    if (t >= 0 && t <= maxDistance && (best === null || t < best)) best = t;
  };

  // Side surface: infinite cylinder clipped to the segment.
  const ox = origin.x - base.x;
  const oz = origin.z - base.z;
  const a = direction.x * direction.x + direction.z * direction.z;
  if (a > 1e-8) {
    const b = 2 * (ox * direction.x + oz * direction.z);
    const c = ox * ox + oz * oz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sqrtDisc = Math.sqrt(disc);
      for (const t of [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)]) {
        if (t < 0 || t > maxDistance) continue;
        const y = origin.y + direction.y * t;
        if (y >= yBottom && y <= yTop) consider(t);
      }
    }
  } else if (ox * ox + oz * oz <= radius * radius) {
    // Perfectly vertical ray inside the cylinder's footprint.
    if (Math.abs(direction.y) > 1e-8) {
      consider((yBottom - origin.y) / direction.y);
      consider((yTop - origin.y) / direction.y);
    }
  }

  // Hemispherical caps.
  for (const capY of [yBottom, yTop]) {
    const t = raySphere(origin, direction, { x: base.x, y: capY, z: base.z }, radius, maxDistance);
    if (t !== null) consider(t);
  }

  return best;
}

/** Ray/sphere intersection returning the nearest non-negative hit distance. */
export function raySphere(
  origin: Vec3,
  direction: Vec3,
  centre: Vec3,
  radius: number,
  maxDistance: number,
): number | null {
  const ox = origin.x - centre.x;
  const oy = origin.y - centre.y;
  const oz = origin.z - centre.z;
  const b = 2 * (ox * direction.x + oy * direction.y + oz * direction.z);
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b - sqrtDisc) / 2;
  const t2 = (-b + sqrtDisc) / 2;
  if (t1 >= 0 && t1 <= maxDistance) return t1;
  if (t2 >= 0 && t2 <= maxDistance) return t2;
  return null;
}

/** Uniform grid over the XZ plane; Y is not subdivided (the arena is wide and low). */
export class ColliderIndex {
  private readonly cellSize: number;
  private readonly cells = new Map<string, BoxCollider[]>();
  private readonly colliders: readonly BoxCollider[];

  constructor(colliders: readonly BoxCollider[], cellSize = 8) {
    this.cellSize = cellSize;
    this.colliders = colliders;
    for (const collider of colliders) {
      this.forEachCell(collider.min, collider.max, (key) => {
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(collider);
        else this.cells.set(key, [collider]);
      });
    }
  }

  get all(): readonly BoxCollider[] {
    return this.colliders;
  }

  private forEachCell(min: Vec3, max: Vec3, fn: (key: string) => void): void {
    const x0 = Math.floor(min.x / this.cellSize);
    const x1 = Math.floor(max.x / this.cellSize);
    const z0 = Math.floor(min.z / this.cellSize);
    const z1 = Math.floor(max.z / this.cellSize);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        fn(`${x}:${z}`);
      }
    }
  }

  /** Colliders whose cells overlap the query box. May contain duplicates-free extras. */
  query(min: Vec3, max: Vec3, out: BoxCollider[] = []): BoxCollider[] {
    out.length = 0;
    const seen = new Set<string>();
    this.forEachCell(min, max, (key) => {
      const bucket = this.cells.get(key);
      if (!bucket) return;
      for (const collider of bucket) {
        if (seen.has(collider.id)) continue;
        seen.add(collider.id);
        out.push(collider);
      }
    });
    return out;
  }

  /** Nearest world hit along a ray, or null when nothing is struck. */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): RayHit | null {
    const end = {
      x: origin.x + direction.x * maxDistance,
      y: origin.y + direction.y * maxDistance,
      z: origin.z + direction.z * maxDistance,
    };
    const candidates = this.query(
      { x: Math.min(origin.x, end.x), y: Math.min(origin.y, end.y), z: Math.min(origin.z, end.z) },
      { x: Math.max(origin.x, end.x), y: Math.max(origin.y, end.y), z: Math.max(origin.z, end.z) },
    );

    let best: RayHit | null = null;
    for (const collider of candidates) {
      const hit = rayIntersectsAABB(origin, direction, collider, maxDistance);
      if (!hit) continue;
      if (best === null || hit.distance < best.distance) {
        best = {
          distance: hit.distance,
          normal: hit.normal,
          colliderId: collider.id,
          point: {
            x: origin.x + direction.x * hit.distance,
            y: origin.y + direction.y * hit.distance,
            z: origin.z + direction.z * hit.distance,
          },
        };
      }
    }
    return best;
  }
}
