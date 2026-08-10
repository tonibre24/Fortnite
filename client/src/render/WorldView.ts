import * as THREE from 'three';
import {
  DECOR_SEED_SALT,
  GROUND_TILES,
  MAP_HALF,
  PROP_TINT_JITTER,
  Rng,
  type GameMap,
  type MapBox,
} from '@br/shared';

/**
 * Draws the map.
 *
 * Boxes are grouped by colour into one InstancedMesh each, so a few thousand
 * primitives cost a handful of draw calls rather than a few thousand. Every
 * instance gets a slightly jittered tint on top of its colour: identical boxes
 * repeated across a map is what makes procedural geometry read as tiled, and
 * per-instance colour costs nothing extra to draw.
 *
 * Nothing here changes `map.boxes`. The collision data is the server's, and the
 * seeded hash every client is checked against is computed from it.
 */
export class WorldView {
  private readonly group = new THREE.Group();
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly materials: THREE.Material[] = [];

  constructor(
    scene: THREE.Scene,
    map: GameMap,
    private readonly setupCascadeMaterial: (material: THREE.Material) => void,
  ) {
    // Same salt as the decoration stream, drawn after it so the two never
    // interleave; both are reproducible from the map seed alone.
    const rng = new Rng((map.seed ^ DECOR_SEED_SALT ^ 0x1234) >>> 0);

    const byColor = new Map<number, MapBox[]>();
    let ground: MapBox | null = null;
    for (const box of map.boxes) {
      // The ground slab covers essentially the whole map; nothing else comes
      // close, so its footprint identifies it without map generation having to
      // label it.
      if (ground === null && box.maxX - box.minX > MAP_HALF && box.maxZ - box.minZ > MAP_HALF) {
        ground = box;
        continue;
      }
      const bucket = byColor.get(box.color);
      if (bucket === undefined) byColor.set(box.color, [box]);
      else bucket.push(box);
    }

    const matrix = new THREE.Matrix4();
    const base = new THREE.Color();
    const tint = new THREE.Color();

    for (const [color, boxes] of byColor) {
      const material = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.92, metalness: 0 });
      this.setupCascadeMaterial(material);
      this.materials.push(material);
      const mesh = new THREE.InstancedMesh(this.geometry, material, boxes.length);
      base.setHex(color);
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!;
        matrix.makeScale(
          Math.max(b.maxX - b.minX, Number.EPSILON),
          Math.max(b.maxY - b.minY, Number.EPSILON),
          Math.max(b.maxZ - b.minZ, Number.EPSILON),
        );
        matrix.setPosition((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
        mesh.setMatrixAt(i, matrix);
        tint.copy(base).offsetHSL(
          rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.1,
          rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.3,
          rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.55,
        );
        mesh.setColorAt(i, tint);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    if (ground !== null) this.tiledGround(ground, rng);
    scene.add(this.group);
  }

  /**
   * The ground as a grid of tinted tiles rather than one box.
   *
   * A single slab is one flat colour across a quarter of a million square
   * units, which is the thing that most makes the map look untextured. Tiling
   * it costs one extra draw call and gives the eye something to judge distance
   * and motion against. The collider is untouched - this is only how it is
   * drawn.
   */
  private tiledGround(ground: MapBox, rng: Rng): void {
    // Independent random per tile reads as a checkerboard - the eye locks onto
    // the grid immediately. Two octaves of value noise give neighbouring tiles
    // similar colours, so the variation becomes patches of ground instead.
    const noise = valueNoise(rng);
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.96, metalness: 0 });
    this.setupCascadeMaterial(material);
    this.materials.push(material);
    const tiles = GROUND_TILES * GROUND_TILES;
    const mesh = new THREE.InstancedMesh(this.geometry, material, tiles);

    const width = (ground.maxX - ground.minX) / GROUND_TILES;
    const depth = (ground.maxZ - ground.minZ) / GROUND_TILES;
    const height = Math.max(ground.maxY - ground.minY, Number.EPSILON);
    const centreY = (ground.minY + ground.maxY) / 2;

    const matrix = new THREE.Matrix4();
    const base = new THREE.Color(ground.color);
    const tint = new THREE.Color();

    let index = 0;
    for (let ix = 0; ix < GROUND_TILES; ix++) {
      for (let iz = 0; iz < GROUND_TILES; iz++) {
        // A hair of overlap, so neighbouring tiles never show a seam of sky
        // through a floating-point gap.
        matrix.makeScale(width * 1.002, height, depth * 1.002);
        matrix.setPosition(
          ground.minX + (ix + 0.5) * width,
          centreY,
          ground.minZ + (iz + 0.5) * depth,
        );
        mesh.setMatrixAt(index, matrix);
        const n = noise(ix * 0.16, iz * 0.16) * 0.65 + noise(ix * 0.42, iz * 0.42) * 0.35;
        tint.copy(base).offsetHSL(
          (n - 0.5) * PROP_TINT_JITTER * 0.22,
          (n - 0.5) * PROP_TINT_JITTER * 0.7,
          (n - 0.5) * PROP_TINT_JITTER * 1.1,
        );
        mesh.setColorAt(index, tint);
        index += 1;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    // The ground casts nothing useful and casting from it doubles its cost in
    // the shadow pass for no visible gain.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    for (const child of this.group.children) {
      if (child instanceof THREE.InstancedMesh) child.dispose();
    }
    for (const material of this.materials) material.dispose();
    this.geometry.dispose();
  }
}

/**
 * Seeded 2D value noise in [0,1], bilinearly interpolated off a lattice.
 *
 * Deliberately tiny: this only needs enough spatial coherence to stop tinting
 * from looking like a checkerboard, and it runs once when the map is built.
 */
function valueNoise(rng: Rng): (x: number, y: number) => number {
  const size = 64;
  const lattice = new Float32Array(size * size);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.range(0, 1);
  const at = (x: number, y: number): number =>
    lattice[(((y % size) + size) % size) * size + (((x % size) + size) % size)]!;

  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    // Smoothstep the fraction, or the lattice shows up as diamond creases.
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
    const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
    return top * (1 - sy) + bottom * sy;
  };
}
