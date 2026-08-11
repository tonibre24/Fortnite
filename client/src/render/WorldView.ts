import * as THREE from 'three';
import {
  COLOR_TREE_CANOPY,
  DECOR_SEED_SALT,
  GROUND_TILES,
  MAP_HALF,
  PROP_TINT_JITTER,
  Rng,
  type GameMap,
  type MapBox,
} from '@br/shared';
import { buildCrossBillboardGeometry, buildFoliageTexture } from './Foliage.js';
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
  /** Owned separately from textureSets: not a full PBR set, just a leaf mask. */
  private canopyGeometry: THREE.BufferGeometry | null = null;
  private canopyTexture: THREE.CanvasTexture | null = null;

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
    const canopies: MapBox[] = [];
    let ground: MapBox | null = null;
    for (const box of map.boxes) {
      // Tree canopies are decoration-only boxes (map generation marks them
      // non-solid), so how they are drawn is entirely a client concern. Drawn
      // as boxes they are the single most artificial thing on screen: 320
      // green rectangles on sticks, with a four-corner silhouette no amount
      // of shading can rescue. They are re-drawn as crossed billboards below
      // instead. The box stays in map.boxes untouched - the seeded hash and
      // the collision world are not this file's to change.
      if (box.color === COLOR_TREE_CANOPY) {
        canopies.push(box);
        continue;
      }
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
      const textured = recipe !== undefined;
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
        if (textured) {
          // The albedo map already carries this surface's colour. Instance
          // colour multiplies that map, so feeding the box colour in again
          // renders the surface at colour-squared - which is why textured
          // ground sat far darker than the untextured hills sitting on it,
          // despite both being nominally the same green. Modulate around
          // white instead, so the variation still reads but the map's own
          // colour survives.
          setNeutralTint(tint, macro, rng);
        } else {
          setJitteredTint(
            tint,
            base,
            rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.1 + (macro - 0.5) * 0.05,
            rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.3 + (macro - 0.5) * 0.2,
            rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.55 + (macro - 0.5) * 0.4,
          );
        }
        mesh.setColorAt(i, tint);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    if (canopies.length > 0) this.treeCanopies(canopies, rng, anisotropy);
    if (ground !== null) this.tiledGround(ground, rng, textureFor(GROUND_RECIPE, ground.color));
    scene.add(this.group);
  }

  /**
   * Tree canopies as crossed alpha-cutout billboards instead of the boxes
   * map generation records them as.
   *
   * A canopy box is non-solid decoration, so nothing about collision, the
   * seeded map hash or the server's view of the world changes here - only
   * what the client puts on screen in the same place. The billboard is also
   * *cheaper* than the box it replaces (four triangles against twelve), so
   * the far better silhouette costs nothing: 320 trees go from 3,840
   * triangles to 1,280, in the same single draw call.
   */
  private treeCanopies(canopies: readonly MapBox[], rng: Rng, anisotropy: number): void {
    const geometry = buildCrossBillboardGeometry();
    // A busier lobe count than a shrub gets: at tree scale the outline is
    // read against open sky, where a smooth blob still looks stamped.
    const leafMap = buildFoliageTexture(rng, 128, 2.2);
    leafMap.anisotropy = anisotropy;
    const material = new THREE.MeshStandardMaterial({
      map: leafMap,
      // White base on purpose: the per-instance colour below carries the
      // green. Putting COLOR_TREE_CANOPY here too would multiply the two
      // together and render the crowns near-black - the same trap the
      // textured boxes above fell into.
      color: 0xffffff,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      roughness: 0.86,
      metalness: 0,
      // Deliberately NOT vertexColors: true. InstancedMesh.instanceColor
      // already defines USE_COLOR on its own, and setting the flag as well
      // makes the vertex shader run `vColor *= color` against a geometry
      // attribute this billboard does not have - an unbound attribute reads
      // as zero, which multiplies every crown to black.
    });
    this.setupCascadeMaterial(material);
    this.materials.push(material);
    this.canopyGeometry = geometry;
    this.canopyTexture = leafMap;

    const mesh = new THREE.InstancedMesh(geometry, material, canopies.length);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const axisY = new THREE.Vector3(0, 1, 0);
    const tint = new THREE.Color();
    const canopyBase = new THREE.Color(COLOR_TREE_CANOPY);

    for (let i = 0; i < canopies.length; i++) {
      const b = canopies[i]!;
      const width = b.maxX - b.minX;
      const height = b.maxY - b.minY;
      // Map generation makes the canopy box taller than it is wide, which is
      // the opposite of a real broadleaf crown - those are as wide as they
      // are tall or wider. Spread it well out and drop it slightly so the
      // foliage swallows the top of the trunk rather than balancing on it.
      scale.set(width * 2.6, height * 1.5, width * 2.6);
      position.set((b.minX + b.maxX) / 2, b.minY - height * 0.42, (b.minZ + b.maxZ) / 2);
      // A free yaw per tree, so 320 copies of one texture do not line up.
      quaternion.setFromAxisAngle(axisY, rng.range(0, Math.PI * 2));
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      // Real canopies vary far more than one flat green: age, species and
      // how much light each crown gets all show up as tone.
      // Derived from the map's own canopy colour rather than a hand-picked
      // HSL triple: instance colours are consumed as-is by the shader, so
      // building one from raw setHSL lands in a different colour space than
      // every other prop here (which comes from a COLOR_* hex through
      // THREE.Color) and renders far too bright. Same path as the trunks and
      // shrubs, so foliage matches the palette instead of floating above it.
      setJitteredTint(
        tint,
        canopyBase,
        rng.range(-0.03, 0.04),
        rng.range(-0.12, 0.12),
        rng.range(-0.22, 0.26),
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
        // Same reasoning as the textured boxes above: the grass albedo map
        // supplies the colour, so this only modulates it. The tile's own
        // `ground.color` is deliberately not mixed in here - that is exactly
        // the second multiply that was darkening it.
        setNeutralTint(tint, n, rng);
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
    this.canopyGeometry?.dispose();
    this.canopyTexture?.dispose();
    this.geometry.dispose();
  }
}

const scratchHSL = { h: 0, s: 0, l: 0 };

/**
 * Per-instance colour for an *untextured* surface, jittered around its own
 * base colour.
 *
 * The lightness offset is scaled to the base rather than added flat. A flat
 * offset is fine on a mid-tone wall but destroys a dark one: tree trunks sit
 * at lightness 0.26, the offset reaches 0.26, and any trunk drawing the low
 * end clamps to zero and renders pure black - visible as black poles among
 * the brown ones. Scaling keeps the variation proportional, so a dark colour
 * varies within its own range instead of falling off the bottom.
 */
function setJitteredTint(
  out: THREE.Color,
  base: THREE.Color,
  dh: number,
  ds: number,
  dl: number,
): void {
  base.getHSL(scratchHSL);
  const l = scratchHSL.l;
  const lit = l + dl * (dl < 0 ? l * 1.6 : 1 - l);
  out.setHSL(
    scratchHSL.h + dh,
    Math.min(1, Math.max(0, scratchHSL.s + ds)),
    Math.min(1, Math.max(0.03, lit)),
  );
}

/**
 * Per-instance colour for a *textured* surface.
 *
 * Instance colour multiplies the albedo map, so for a textured surface it is
 * a modulation term, not a colour: it has to average 1.0 or the material
 * renders darker than the map it was authored as. `noise` (0..1) drives a
 * broad brightness sweep plus a slight warm/cool shift, with a little
 * per-instance grain on top - enough variation to break up repetition without
 * shifting the surface off its intended colour.
 */
function setNeutralTint(out: THREE.Color, noise: number, rng: Rng): void {
  const shade = 1 + (noise - 0.5) * 0.30 + rng.range(-0.05, 0.05);
  const warm = (noise - 0.5) * 0.06;
  out.setRGB(shade * (1 + warm), shade, shade * (1 - warm));
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
