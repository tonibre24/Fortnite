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
import { GROUND_RECIPE, RECIPE_BY_COLOR } from './MaterialRecipes.js';
import { buildTextureSet, type MaterialRecipe, type TextureSet } from './ProceduralTexture.js';

/**
 * Every wall/roof box gets this repeat regardless of its own footprint:
 * BoxGeometry's default UVs are already 0..1 per face, so there is no
 * per-world-unit size to key a repeat off without a triplanar shader. The
 * brief allows "triplanar or world-space UVs" - this is the world-space-UV
 * side of that choice, at the cost of large and small boxes showing the
 * texture at the same frequency. See ASSET_CREDITS.md.
 */
const BOX_TEXTURE_REPEAT = 2.5;
/** Ground tiles are uniform size, so one texture per tile never stretches. */
const GROUND_TEXTURE_REPEAT = 1;

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
  private readonly textureSets: TextureSet[] = [];

  constructor(
    scene: THREE.Scene,
    map: GameMap,
    private readonly setupCascadeMaterial: (material: THREE.Material) => void,
    textureSize: number,
    anisotropy: number,
  ) {
    // Same salt as the decoration stream, drawn after it so the two never
    // interleave; both are reproducible from the map seed alone.
    const rng = new Rng((map.seed ^ DECOR_SEED_SALT ^ 0x1234) >>> 0);

    // One texture set per distinct recipe, not per box colour - COLOR_WALL and
    // COLOR_WALL_ALT both point at WALL_RECIPE and share a single set. Seeding
    // off the colour that first requests a recipe keeps this fully
    // deterministic from the map seed while giving each recipe its own noise
    // instead of every material echoing an identical pattern.
    const textureCache = new Map<MaterialRecipe, TextureSet>();
    const textureFor = (recipe: MaterialRecipe, salt: number): TextureSet => {
      let set = textureCache.get(recipe);
      if (set === undefined) {
        set = buildTextureSet(recipe, textureSize, (map.seed ^ salt) >>> 0, anisotropy);
        textureCache.set(recipe, set);
        this.textureSets.push(set);
      }
      return set;
    };

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
    // A wall built from one small tileable texture repeated across a big
    // footprint is what reads as an obviously repeating pattern at range.
    // Per-instance jitter alone does not hide that - neighbouring boxes still
    // land on independent random tints, which looks like static rather than
    // the weathering it is meant to suggest. Keying a second, much
    // lower-frequency noise off each box's own world position instead makes
    // neighbouring walls and roofs fall into the same warm or cool patch, the
    // same trick the ground tiles below already use over their grid.
    const macroNoise = valueNoise(rng);

    for (const [color, boxes] of byColor) {
      const recipe = RECIPE_BY_COLOR.get(color);
      const material =
        recipe === undefined
          ? new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.92, metalness: 0 })
          : texturedMaterial(textureFor(recipe, color), BOX_TEXTURE_REPEAT);
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
        const macro =
          macroNoise(b.minX * 0.018, b.minZ * 0.018) * 0.7 + macroNoise(b.minX * 0.005, b.minZ * 0.005) * 0.3;
        tint.copy(base).offsetHSL(
          rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.1 + (macro - 0.5) * 0.05,
          rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.3 + (macro - 0.5) * 0.2,
          rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.55 + (macro - 0.5) * 0.4,
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

    if (ground !== null) this.tiledGround(ground, rng, textureFor(GROUND_RECIPE, ground.color));
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
  private tiledGround(ground: MapBox, rng: Rng, textures: TextureSet): void {
    // Independent random per tile reads as a checkerboard - the eye locks onto
    // the grid immediately. Two octaves of value noise give neighbouring tiles
    // similar colours, so the variation becomes patches of ground instead.
    const noise = valueNoise(rng);
    const material = texturedMaterial(textures, GROUND_TEXTURE_REPEAT);
    this.setupCascadeMaterial(material);
    this.materials.push(material);
    const tiles = GROUND_TILES * GROUND_TILES;
    const mesh = new THREE.InstancedMesh(this.geometry, material, tiles);

    const width = (ground.maxX - ground.minX) / GROUND_TILES;
    const depth = (ground.maxZ - ground.minZ) / GROUND_TILES;
    const height = Math.max(ground.maxY - ground.minY, Number.EPSILON);
    const centreY = (ground.minY + ground.maxY) / 2;

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const axisY = new THREE.Vector3(0, 1, 0);
    const base = new THREE.Color(ground.color);
    const tint = new THREE.Color();

    let index = 0;
    for (let ix = 0; ix < GROUND_TILES; ix++) {
      for (let iz = 0; iz < GROUND_TILES; iz++) {
        // A hair of overlap, so neighbouring tiles never show a seam of sky
        // through a floating-point gap.
        scale.set(width * 1.002, height, depth * 1.002);
        position.set(
          ground.minX + (ix + 0.5) * width,
          centreY,
          ground.minZ + (iz + 0.5) * depth,
        );
        // Every tile samples the same texture, so a random quarter-turn per
        // instance is what stops the grid reading as one image repeated - the
        // tiles are square, so a 90 degree step never opens a seam.
        quaternion.setFromAxisAngle(axisY, (rng.int(0, 3) * Math.PI) / 2);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);
        // A third, much coarser octave than the other two - low enough
        // frequency to sweep across dozens of tiles in one patch - is the
        // actual "second, larger-scale noise layer" a seed-derived, evenly
        // repeated ground texture needs: the fine octaves alone still let the
        // same tile-sized pattern read as tiled once a player is far enough
        // back to see many tiles at once, because neighbouring tiles' tints
        // stay close together. This one breaks that up at a scale no single
        // glance covers.
        const n =
          noise(ix * 0.16, iz * 0.16) * 0.45 +
          noise(ix * 0.42, iz * 0.42) * 0.2 +
          noise(ix * 0.035, iz * 0.035) * 0.35;
        tint.copy(base).offsetHSL(
          (n - 0.5) * PROP_TINT_JITTER * 0.3,
          (n - 0.5) * PROP_TINT_JITTER * 0.9,
          (n - 0.5) * PROP_TINT_JITTER * 1.5,
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

  /** Every procedural texture this view built, for the perf overlay's memory estimate. */
  get textures(): THREE.Texture[] {
    const list: THREE.Texture[] = [];
    for (const set of this.textureSets) list.push(set.map, set.normalMap, set.roughnessMap);
    return list;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    for (const child of this.group.children) {
      if (child instanceof THREE.InstancedMesh) child.dispose();
    }
    for (const material of this.materials) material.dispose();
    for (const set of this.textureSets) set.dispose();
    this.geometry.dispose();
  }
}

/** Builds a MeshStandardMaterial from a generated texture set at a given UV repeat. */
function texturedMaterial(set: TextureSet, repeat: number): THREE.MeshStandardMaterial {
  set.map.repeat.set(repeat, repeat);
  set.normalMap.repeat.set(repeat, repeat);
  set.roughnessMap.repeat.set(repeat, repeat);
  return new THREE.MeshStandardMaterial({
    map: set.map,
    normalMap: set.normalMap,
    roughnessMap: set.roughnessMap,
    flatShading: true,
    // The roughness map already carries the real value per texel; leaving the
    // scalar at 1 makes it a pure multiplier identity instead of darkening
    // the map a second time.
    roughness: 1,
    metalness: 0,
  });
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
