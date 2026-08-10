import * as THREE from 'three';
import {
  BUILDING_DOOR_HEIGHT,
  BUILDING_DOOR_WIDTH,
  BUILDING_MAX_STOREYS,
  BUILDING_STOREY_HEIGHT,
  COLOR_GLASS,
  COLOR_GRASS_A,
  COLOR_GRASS_B,
  COLOR_PEBBLE,
  COLOR_TRIM,
  COLOR_WALL,
  EAVE_OVERHANG,
  EAVE_THICKNESS,
  WINDOW_FRAME,
  WINDOW_HEIGHT,
  WINDOW_SILL,
  WINDOW_SPACING,
  WINDOW_WIDTH,
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

  constructor(
    scene: THREE.Scene,
    map: GameMap,
    private readonly setupCascadeMaterial: (material: THREE.Material) => void,
    /** Fraction of the seeded background clutter actually placed, from the active quality tier. */
    density = 1,
  ) {
    // Salted so this stream can never be confused with the one that built the
    // map, however either is later extended.
    const rng = new Rng((map.seed ^ DECOR_SEED_SALT) >>> 0);

    this.grass(rng, map, density);
    this.pebbles(rng, map, density);
    this.fences(rng, map);
    this.buildingTrim(rng, map);

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
    roughness = 0.9,
    metalness = 0,
  ): PropBatch {
    const material = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness, metalness });
    this.setupCascadeMaterial(material);
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
  private grass(rng: Rng, map: GameMap, density: number): void {
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

    const grassCount = Math.round(DECOR_GRASS_COUNT * density);
    for (let i = 0; i < grassCount; i++) {
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
  private pebbles(rng: Rng, map: GameMap, density: number): void {
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

    const pebbleCount = Math.round(DECOR_PEBBLE_COUNT * density);
    for (let i = 0; i < pebbleCount; i++) {
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

  /**
   * Windows, door frames and eaves.
   *
   * The windows are glass panels sitting flush against the wall, not openings.
   * A wall is a collider the server also has, and cutting a hole through one to
   * make it look better would change the seeded map hash - so these are glazed
   * windows rather than gaps. They read correctly and they do not lie about
   * where a bullet can go, because nothing here is passable either way.
   */
  private buildingTrim(rng: Rng, map: GameMap): void {
    const panel = new THREE.BoxGeometry(1, 1, 0.08);
    const bar = new THREE.BoxGeometry(1, 1, 1);
    const slab = new THREE.BoxGeometry(1, 1, 1);

    // Four walls, up to two storeys, a handful of windows per wall.
    const perBuilding = 4 * BUILDING_MAX_STOREYS * 6;
    // Smooth and a little reflective, so a window actually reads as glass
    // against the surrounding matte wall and trim.
    const glass = this.batch(panel, COLOR_GLASS, map.buildings.length * perBuilding + 1, false, 0.18, 0.05);
    const frames = this.batch(bar, COLOR_TRIM, map.buildings.length * perBuilding * 4 + 8, false);
    const eaves = this.batch(slab, COLOR_TRIM, map.buildings.length * BUILDING_MAX_STOREYS + 1, true);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const axis = new THREE.Vector3(0, 1, 0);
    const glassBase = new THREE.Color(COLOR_GLASS);
    const trimBase = new THREE.Color(COLOR_TRIM);
    const tint = new THREE.Color();

    for (const b of map.buildings) {
      const width = b.maxX - b.minX;
      const depth = b.maxZ - b.minZ;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;

      // Eaves: a thin overhanging slab capping the walls, which is what most
      // reads as "this building has a roof" from ground level.
      const top = b.baseY + b.storeys * BUILDING_STOREY_HEIGHT;
      scale.set(width + EAVE_OVERHANG * 2, EAVE_THICKNESS, depth + EAVE_OVERHANG * 2);
      position.set(cx, top + EAVE_THICKNESS / 2, cz);
      quaternion.identity();
      matrix.compose(position, quaternion, scale);
      this.place(eaves, matrix, trimBase, tint, rng);

      // 0 = -Z wall, 1 = +Z, 2 = -X, 3 = +X, matching Building.doorSide.
      const walls: Array<{ nx: number; nz: number; span: number; angle: number }> = [
        { nx: 0, nz: -1, span: width, angle: 0 },
        { nx: 0, nz: 1, span: width, angle: Math.PI },
        { nx: -1, nz: 0, span: depth, angle: -Math.PI / 2 },
        { nx: 1, nz: 0, span: depth, angle: Math.PI / 2 },
      ];

      for (let side = 0; side < walls.length; side++) {
        const wall = walls[side]!;
        const count = Math.max(1, Math.floor((wall.span - 2) / WINDOW_SPACING));
        quaternion.setFromAxisAngle(axis, wall.angle);
        // Just proud of the wall face, so it never z-fights with the collider.
        const outX = wall.nx * (wall.nx === 0 ? depth / 2 : width / 2) + wall.nx * 0.06;
        const outZ = wall.nz * (wall.nz === 0 ? width / 2 : depth / 2) + wall.nz * 0.06;

        for (let storey = 0; storey < b.storeys; storey++) {
          const sillY = b.baseY + storey * BUILDING_STOREY_HEIGHT + WINDOW_SILL;
          for (let i = 0; i < count; i++) {
            const along = ((i + 0.5) / count - 0.5) * wall.span;
            // The doorway occupies the middle of its wall on the ground floor.
            if (side === b.doorSide && storey === 0 && Math.abs(along) < BUILDING_DOOR_WIDTH) continue;

            const ox = wall.nx === 0 ? along : 0;
            const oz = wall.nz === 0 ? along : 0;
            const x = cx + ox + outX;
            const z = cz + oz + outZ;
            const y = sillY + WINDOW_HEIGHT / 2;

            scale.set(WINDOW_WIDTH, WINDOW_HEIGHT, 1);
            position.set(x, y, z);
            matrix.compose(position, quaternion, scale);
            this.place(glass, matrix, glassBase, tint, rng);

            // Four bars around the glass. Cheap, and it is the frame that makes
            // a flat panel read as a window rather than a stain on the wall.
            const edges: Array<[number, number, number, number]> = [
              [0, WINDOW_HEIGHT / 2, WINDOW_WIDTH + WINDOW_FRAME * 2, WINDOW_FRAME],
              [0, -WINDOW_HEIGHT / 2, WINDOW_WIDTH + WINDOW_FRAME * 2, WINDOW_FRAME],
              [-WINDOW_WIDTH / 2, 0, WINDOW_FRAME, WINDOW_HEIGHT],
              [WINDOW_WIDTH / 2, 0, WINDOW_FRAME, WINDOW_HEIGHT],
            ];
            for (const [dx, dy, sw, sh] of edges) {
              scale.set(sw, sh, 0.1);
              position.set(x + (wall.nx === 0 ? dx : 0), y + dy, z + (wall.nz === 0 ? dx : 0));
              matrix.compose(position, quaternion, scale);
              this.place(frames, matrix, trimBase, tint, rng);
            }
          }
        }

        // Door frame: two jambs and a lintel around the opening in the wall.
        if (side !== b.doorSide) continue;
        const doorX = cx + outX;
        const doorZ = cz + outZ;
        const jambs: Array<[number, number, number, number]> = [
          [-BUILDING_DOOR_WIDTH / 2, BUILDING_DOOR_HEIGHT / 2, WINDOW_FRAME * 1.4, BUILDING_DOOR_HEIGHT],
          [BUILDING_DOOR_WIDTH / 2, BUILDING_DOOR_HEIGHT / 2, WINDOW_FRAME * 1.4, BUILDING_DOOR_HEIGHT],
          [0, BUILDING_DOOR_HEIGHT, BUILDING_DOOR_WIDTH + WINDOW_FRAME * 2.8, WINDOW_FRAME * 1.4],
        ];
        for (const [dx, dy, sw, sh] of jambs) {
          scale.set(sw, sh, 0.12);
          position.set(
            doorX + (wall.nx === 0 ? dx : 0),
            b.baseY + dy,
            doorZ + (wall.nz === 0 ? dx : 0),
          );
          matrix.compose(position, quaternion, scale);
          this.place(frames, matrix, trimBase, tint, rng);
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
