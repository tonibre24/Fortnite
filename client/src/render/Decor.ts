import * as THREE from 'three';
import {
  COLOR_GRASS_A,
  COLOR_GRASS_B,
  COLOR_PEBBLE,
  COLOR_WALL,
  DECOR_FENCE_CHANCE,
  DECOR_GRASS_COUNT,
  DECOR_PEBBLE_COUNT,
  DECOR_SEED_SALT,
  GROUND_Y,
  MAP_HALF,
  PROP_TINT_JITTER,
  Rng,
  SPAWN_CLEARANCE_RADIUS,
  terrainHeightAt,
  type Building,
  type GameMap,
} from '@br/shared';

/**
 * Client-side scenery.
 *
 * Everything here is decoration and nothing here is a collider. The map in
 * shared/ is authoritative and is shared with the server, so this file may
 * never add to, remove from or reorder `map.boxes` - doing so would change the
 * seeded map hash that every client is checked against on join.
 *
 * What it may do is derive its own props from the same seed, on a separate RNG
 * stream salted away from map generation. Same seed in, same scenery out, on
 * every machine, with no extra bytes on the wire and no risk of the decoration
 * drifting the simulation.
 */

/** One instanced mesh per prop type: a draw call per type, not per prop. */
interface PropBatch {
  mesh: THREE.InstancedMesh;
  count: number;
}

export class Decor {
  private readonly group = new THREE.Group();
  private readonly batches: PropBatch[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(scene: THREE.Scene, map: GameMap) {
    // Salted so this stream can never be confused with the one that built the
    // map, however either is later extended.
    const rng = new Rng((map.seed ^ DECOR_SEED_SALT) >>> 0);

    this.grass(rng, map);
    this.pebbles(rng, map);
    this.fences(rng, map);

    scene.add(this.group);
  }

  /** Is this point inside a building footprint, where a prop would clip? */
  private static insideBuilding(buildings: readonly Building[], x: number, z: number): boolean {
    for (const b of buildings) {
      if (x > b.minX - 1 && x < b.maxX + 1 && z > b.minZ - 1 && z < b.maxZ + 1) return true;
    }
    return false;
  }

  /**
   * Adds a batch and returns it. Capacity is allocated once; nothing here ever
   * grows during a frame.
   */
  private batch(
    geometry: THREE.BufferGeometry,
    color: number,
    capacity: number,
    castShadow: boolean,
  ): PropBatch {
    const material = new THREE.MeshLambertMaterial({ color, flatShading: true });
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    // Scenery is spread over the whole map, so a single bounding sphere would
    // never cull; per-batch culling is left off and the instance count is what
    // bounds the cost.
    mesh.frustumCulled = false;
    mesh.count = 0;
    const result: PropBatch = { mesh, count: 0 };
    this.batches.push(result);
    this.geometries.push(geometry);
    this.materials.push(material);
    this.group.add(mesh);
    return result;
  }

  /** Places one instance with a slightly varied tint. */
  private place(
    batch: PropBatch,
    matrix: THREE.Matrix4,
    base: THREE.Color,
    tint: THREE.Color,
    rng: Rng,
  ): void {
    if (batch.count >= batch.mesh.instanceMatrix.count) return;
    batch.mesh.setMatrixAt(batch.count, matrix);
    // Jitter in HSL rather than RGB: shifting lightness and hue a little keeps
    // the palette, where jittering RGB channels drifts towards grey.
    tint.copy(base);
    tint.offsetHSL(
      rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.15,
      rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.4,
      rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER),
    );
    batch.mesh.setColorAt(batch.count, tint);
    batch.count += 1;
    batch.mesh.count = batch.count;
  }

  /**
   * Grass tufts: three crossed blades, so they read from any angle without a
   * texture and without alpha testing, which is expensive on tiled GPUs.
   */
  private grass(rng: Rng, map: GameMap): void {
    const blade = new THREE.ConeGeometry(0.16, 0.55, 3, 1);
    blade.translate(0, 0.275, 0);
    const batch = this.batch(blade, COLOR_GRASS_A, DECOR_GRASS_COUNT, false);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const axis = new THREE.Vector3(0, 1, 0);
    const base = new THREE.Color();
    const warm = new THREE.Color(COLOR_GRASS_A);
    const cool = new THREE.Color(COLOR_GRASS_B);
    const tint = new THREE.Color();

    for (let i = 0; i < DECOR_GRASS_COUNT; i++) {
      const x = rng.range(-MAP_HALF, MAP_HALF);
      const z = rng.range(-MAP_HALF, MAP_HALF);
      if (Math.hypot(x, z) < SPAWN_CLEARANCE_RADIUS) continue;
      if (Decor.insideBuilding(map.buildings, x, z)) continue;
      const y = terrainHeightAt(map.hills, x, z);

      quaternion.setFromAxisAngle(axis, rng.range(0, Math.PI * 2));
      const height = rng.range(0.7, 1.5);
      scale.set(rng.range(0.8, 1.3), height, rng.range(0.8, 1.3));
      position.set(x, y, z);
      matrix.compose(position, quaternion, scale);
      // Two greens mixed across the map so the ground is never one flat colour.
      base.copy(warm).lerp(cool, rng.range(0, 1));
      this.place(batch, matrix, base, tint, rng);
    }
  }

  /** Pebbles and ground litter, breaking up the flat slab underfoot. */
  private pebbles(rng: Rng, map: GameMap): void {
    // Eight triangles rather than the dodecahedron's thirty-six; at this size
    // the silhouette is all that reads anyway.
    const geometry = new THREE.OctahedronGeometry(0.26, 0);
    const batch = this.batch(geometry, COLOR_PEBBLE, DECOR_PEBBLE_COUNT, false);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler();
    const base = new THREE.Color(COLOR_PEBBLE);
    const tint = new THREE.Color();

    for (let i = 0; i < DECOR_PEBBLE_COUNT; i++) {
      const x = rng.range(-MAP_HALF, MAP_HALF);
      const z = rng.range(-MAP_HALF, MAP_HALF);
      if (Decor.insideBuilding(map.buildings, x, z)) continue;
      const y = terrainHeightAt(map.hills, x, z);

      euler.set(rng.range(0, Math.PI), rng.range(0, Math.PI), rng.range(0, Math.PI));
      quaternion.setFromEuler(euler);
      const size = rng.range(0.5, 1.6);
      scale.set(size, size * rng.range(0.5, 0.9), size);
      position.set(x, y + 0.05, z);
      matrix.compose(position, quaternion, scale);
      this.place(batch, matrix, base, tint, rng);
    }
  }

  /**
   * Fence posts and rails around some building plots. Two batches rather than
   * one shape, so posts and rails keep their own proportions while still
   * costing one draw call each.
   */
  private fences(rng: Rng, map: GameMap): void {
    const postGeometry = new THREE.BoxGeometry(0.16, 1.1, 0.16);
    postGeometry.translate(0, 0.55, 0);
    const railGeometry = new THREE.BoxGeometry(1, 0.1, 0.08);

    // Worst case: every building fenced, four sides, posts every two units.
    const perimeter = map.buildings.length * 4 * 12;
    const posts = this.batch(postGeometry, COLOR_WALL, Math.max(1, perimeter), true);
    const rails = this.batch(railGeometry, COLOR_WALL, Math.max(1, perimeter), true);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const axis = new THREE.Vector3(0, 1, 0);
    const base = new THREE.Color(COLOR_WALL);
    const tint = new THREE.Color();

    for (const b of map.buildings) {
      if (!rng.bool(DECOR_FENCE_CHANCE)) continue;
      // Set back from the wall so it never traps a player against the building.
      const pad = 2.2;
      const minX = b.minX - pad;
      const maxX = b.maxX + pad;
      const minZ = b.minZ - pad;
      const maxZ = b.maxZ + pad;
      const y = b.baseY;

      const runs: Array<[number, number, number, number]> = [
        [minX, minZ, maxX, minZ],
        [minX, maxZ, maxX, maxZ],
        [minX, minZ, minX, maxZ],
        [maxX, minZ, maxX, maxZ],
      ];
      // One side is left open, so a fenced plot still has a way in.
      const open = rng.int(0, 3);

      for (let side = 0; side < runs.length; side++) {
        if (side === open) continue;
        const [x0, z0, x1, z1] = runs[side]!;
        const dx = x1 - x0;
        const dz = z1 - z0;
        const length = Math.hypot(dx, dz);
        const segments = Math.max(1, Math.round(length / 2.2));
        const angle = Math.atan2(dx, dz);
        quaternion.setFromAxisAngle(axis, angle);

        for (let s = 0; s <= segments; s++) {
          const t = s / segments;
          position.set(x0 + dx * t, y, z0 + dz * t);
          matrix.compose(position, quaternion, scale);
          this.place(posts, matrix, base, tint, rng);
        }
        for (let s = 0; s < segments; s++) {
          const t = (s + 0.5) / segments;
          const railLength = length / segments;
          for (const height of [0.4, 0.85]) {
            position.set(x0 + dx * t, y + height, z0 + dz * t);
            scale.set(railLength, 1, 1);
            matrix.compose(position, quaternion, scale);
            this.place(rails, matrix, base, tint, rng);
            scale.set(1, 1, 1);
          }
        }
      }
    }
  }

  /** Instances actually placed, for the perf overlay and the benchmark. */
  get propCount(): number {
    let total = 0;
    for (const batch of this.batches) total += batch.count;
    return total;
  }

  get batchCount(): number {
    return this.batches.length;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    for (const batch of this.batches) batch.mesh.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.batches.length = 0;
  }
}

/** Ground tiling and per-box tint live with the world mesh, not here. */
export const DECOR_GROUND_Y = GROUND_Y;
