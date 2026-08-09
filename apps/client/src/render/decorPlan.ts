import {
  ColliderIndex,
  STEP_HEIGHT,
  getArena,
  hashSeed,
  mulberry32,
  type ArenaDefinition,
  type BoxCollider,
  type Vec3,
} from '@riftfront/shared';
import { DECOR } from './palette.js';

/**
 * The arena's decoration layout — as plain data, with no renderer in sight.
 *
 * ## Why this module exists
 *
 * Decoration is *additive and client-side only*. The colliders in the shared arena are
 * authoritative and are what the server simulates against, so nothing here may ever
 * change them, and nothing here may put a solid-looking object where a player can walk.
 * Keeping the layout as pure data means both of those properties are testable headlessly,
 * without WebGL — see `decorPlan.test.ts`, which walks every generated box against the
 * real collider set and the real player capsule.
 *
 * Everything is derived from one seed hashed from the arena's own name, so every client
 * generates a byte-identical layout without a single byte crossing the network.
 *
 * ## The clearance contract
 *
 * Every generated box declares how it is allowed to coexist with the collision world:
 *
 * | clearance   | rule                                                                |
 * | ----------- | ------------------------------------------------------------------- |
 * | `embedded`  | sits inside a collider, protruding at most `PROUD_TOLERANCE`         |
 * | `flush`     | a floor inlay no thicker than `FLUSH_THICKNESS`                      |
 * | `clutter`   | rests on a walkable surface, no taller than the controller's step    |
 * | `overhead`  | proven unreachable: no player, even mid-jump, can intersect it       |
 * | `outside`   | beyond the perimeter walls, where no player can go                   |
 *
 * `clutter` is the one deliberate compromise: a player's shins pass through a 40 cm
 * grass tuft. That is correct for vegetation and invisible for a kerb, and the height cap
 * is the controller's own `STEP_HEIGHT`, so no clutter can ever be mistaken for cover.
 */

// ---------------------------------------------------------------------------
// Contract limits (asserted by decorPlan.test.ts)
// ---------------------------------------------------------------------------

/** How far an `embedded` box may protrude from its host collider, in metres. */
export const PROUD_TOLERANCE = 0.06;
/** Maximum thickness of a `flush` floor inlay. */
export const FLUSH_THICKNESS = 0.08;
/** Maximum height of `clutter` above the surface it rests on. */
export const CLUTTER_HEIGHT = STEP_HEIGHT;
/** Half-extent of the outer wall ring; `outside` boxes must clear this. */
export const ARENA_OUTER_HALF_EXTENT = 33.5;
/**
 * Where the decorated arena floor ends and the outer terrain begins.
 *
 * Both grids are aligned to this line — the floor plane covers everything inside it and
 * the terrain punches exactly this square out — so the two surfaces meet at y = 0 with
 * no seam and no overlapping, z-fighting geometry.
 */
export const TERRAIN_INNER_HALF_EXTENT = 35;

export type Clearance = 'embedded' | 'flush' | 'clutter' | 'overhead' | 'outside';

export interface DecorBox {
  id: string;
  /** Centre of the box. */
  centre: Vec3;
  /** Full extents. */
  size: Vec3;
  colour: string;
  clearance: Clearance;
  /** For `embedded`: the collider this box is dressed onto. */
  hostColliderId?: string;
  /** For `flush` and `clutter`: the surface height the box rests on. */
  restingY?: number;
}

export type PropKind = 'grass' | 'pebble' | 'shrub' | 'rock' | 'tree' | 'fence' | 'shed';

/**
 * Nominal dimensions and base colour for each prop type, at scale 1.
 *
 * Shared between the plan and the renderer so the clearance test can reason about a
 * prop's real height without instantiating a mesh: `Props.ts` is required to build
 * geometry that fits inside `height`.
 */
export const PROP_SPECS: Record<PropKind, { height: number; colour: string }> = {
  grass: { height: 0.34, colour: DECOR.grass },
  pebble: { height: 0.3, colour: DECOR.rock },
  shrub: { height: 1.15, colour: DECOR.shrub },
  rock: { height: 1.5, colour: DECOR.rockAlt },
  tree: { height: 5.4, colour: DECOR.treeCanopy },
  fence: { height: 1.35, colour: DECOR.fence },
  shed: { height: 3.6, colour: DECOR.outbuildingWall },
};

export interface PropInstance {
  kind: PropKind;
  /** Base of the prop — its feet, not its centre. */
  position: Vec3;
  rotationY: number;
  scale: number;
  /** Per-instance colour multiplier, so a field of instances is not visibly tiled. */
  tint: { r: number; g: number; b: number };
  clearance: Clearance;
}

/** A flat-shaded grid: one colour and one quad per cell. */
export interface ColourGrid {
  /** World position of the (0,0) corner. */
  originX: number;
  originZ: number;
  cellSize: number;
  /** Cells per side. */
  cells: number;
  /** `(cells + 1)^2` corner heights, row-major over z then x. */
  heights: Float32Array;
  /** `cells * cells * 3` RGB values, row-major over z then x. */
  colours: Float32Array;
  /** `cells * cells` flags; 0 skips the cell entirely. */
  mask: Uint8Array;
}

export interface DecorPlan {
  seed: number;
  boxes: DecorBox[];
  props: PropInstance[];
  /** The arena floor, replacing the shared ground slab's visual. */
  ground: ColourGrid;
  /** Decorative landscape beyond the walls, which the fog dissolves. */
  terrain: ColourGrid;
  /** Arena visual ids the renderer must skip because this plan replaces them. */
  replacedVisualIds: string[];
}

// ---------------------------------------------------------------------------
// Deterministic noise
// ---------------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/** Smooth value noise on a unit lattice. */
function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smoothstep(x - ix);
  const fy = smoothstep(y - iy);

  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);

  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** Two octaves is plenty for a stylised look and keeps generation instant. */
function fbm(x: number, y: number, seed: number): number {
  return valueNoise(x, y, seed) * 0.65 + valueNoise(x * 2.7, y * 2.7, seed + 17) * 0.35;
}

// ---------------------------------------------------------------------------
// Colour helpers (kept renderer-free: plain RGB in 0..1)
// ---------------------------------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    r: ((value >> 16) & 0xff) / 255,
    g: ((value >> 8) & 0xff) / 255,
    b: (value & 0xff) / 255,
  };
}

/**
 * A small hue-and-value nudge expressed as a per-channel multiplier.
 *
 * `warm` rotates towards red, `cool` towards blue, and `value` lifts or drops the whole
 * thing. Multipliers rather than absolute colours so a single material keeps its identity
 * across a thousand instances while no two instances are quite the same.
 */
function tintMultiplier(warm: number, value: number): Rgb {
  return {
    r: value * (1 + warm * 0.12),
    g: value * (1 - Math.abs(warm) * 0.03),
    b: value * (1 - warm * 0.14),
  };
}

// ---------------------------------------------------------------------------
// Architectural dressing, derived from the shared colliders
// ---------------------------------------------------------------------------

interface WallDressing {
  colliderId: string;
  /** Number of evenly spaced windows along the wall's long axis. */
  windows: number;
  /** Vertical buttress ribs, for the long blank perimeter walls. */
  ribs: number;
  cornice: boolean;
  plinth: boolean;
}

const DRESSED_WALLS: WallDressing[] = [
  { colliderId: 'foundry-n', windows: 3, ribs: 0, cornice: true, plinth: true },
  { colliderId: 'foundry-e', windows: 2, ribs: 0, cornice: true, plinth: true },
  { colliderId: 'foundry-s-left', windows: 1, ribs: 0, cornice: true, plinth: true },
  { colliderId: 'foundry-s-right', windows: 1, ribs: 0, cornice: true, plinth: true },
  { colliderId: 'foundry-w-back', windows: 1, ribs: 0, cornice: true, plinth: true },
  { colliderId: 'foundry-w-front', windows: 0, ribs: 0, cornice: true, plinth: true },
  { colliderId: 'bunker-s', windows: 3, ribs: 0, cornice: true, plinth: true },
  { colliderId: 'bunker-e', windows: 2, ribs: 0, cornice: true, plinth: true },
  { colliderId: 'bunker-n-left', windows: 1, ribs: 0, cornice: true, plinth: true },
  { colliderId: 'bunker-n-right', windows: 1, ribs: 0, cornice: true, plinth: true },
  { colliderId: 'bunker-w-a', windows: 0, ribs: 0, cornice: true, plinth: true },
  { colliderId: 'bunker-w-b', windows: 0, ribs: 0, cornice: true, plinth: true },
  { colliderId: 'wall-north', windows: 0, ribs: 9, cornice: true, plinth: false },
  { colliderId: 'wall-south', windows: 0, ribs: 9, cornice: true, plinth: false },
  { colliderId: 'wall-east', windows: 0, ribs: 9, cornice: true, plinth: false },
  { colliderId: 'wall-west', windows: 0, ribs: 9, cornice: true, plinth: false },
];

/** Doorways, named by the two colliders that flank the gap. */
interface Doorway {
  id: string;
  left: string;
  right: string;
  /** Axis the two flanking walls are separated along. */
  axis: 'x' | 'z';
}

const DOORWAYS: Doorway[] = [
  { id: 'foundry-south', left: 'foundry-s-left', right: 'foundry-s-right', axis: 'x' },
  { id: 'foundry-west', left: 'foundry-w-front', right: 'foundry-w-back', axis: 'z' },
  { id: 'bunker-north', left: 'bunker-n-left', right: 'bunker-n-right', axis: 'x' },
  { id: 'bunker-west', left: 'bunker-w-b', right: 'bunker-w-a', axis: 'z' },
];

/** Interior floor slabs, in the void enclosed by each building's walls. */
const INTERIOR_FLOORS = [
  { id: 'foundry', minX: 9.35, maxX: 24.65, minZ: 9.85, maxZ: 22.15, y: 0 },
  { id: 'bunker', minX: 9.9, maxX: 24.1, minZ: -22.6, maxZ: -11.4, y: 0 },
];

const sizeOf = (collider: BoxCollider): Vec3 => ({
  x: collider.max.x - collider.min.x,
  y: collider.max.y - collider.min.y,
  z: collider.max.z - collider.min.z,
});

const centreOf = (collider: BoxCollider): Vec3 => ({
  x: (collider.min.x + collider.max.x) / 2,
  y: (collider.min.y + collider.max.y) / 2,
  z: (collider.min.z + collider.max.z) / 2,
});

/**
 * Dresses one wall collider: a cornice at the top, a plinth at the base, optional
 * buttress ribs, and windows spaced along the long axis.
 *
 * Every box is sized from the host collider and inset so it can only ever protrude by
 * `PROUD_TOLERANCE` on the wall's thin axis. Nothing here reads a hard-coded coordinate.
 */
function dressWall(
  collider: BoxCollider,
  dressing: WallDressing,
  boxes: DecorBox[],
  random: () => number,
): void {
  const size = sizeOf(collider);
  const centre = centreOf(collider);
  const thin: 'x' | 'z' = size.x <= size.z ? 'x' : 'z';
  const long: 'x' | 'z' = thin === 'x' ? 'z' : 'x';
  const thickness = size[thin];
  const span = size[long];
  const proud = thickness + PROUD_TOLERANCE * 2;

  const band = (id: string, y: number, height: number, inset: number, colour: string): void => {
    const boxSize: Vec3 = { x: 0, y: height, z: 0 };
    boxSize[long] = Math.max(0.1, span - inset);
    boxSize[thin] = proud;
    boxes.push({
      id,
      centre: { x: centre.x, y, z: centre.z },
      size: boxSize,
      colour,
      clearance: 'embedded',
      hostColliderId: collider.id,
    });
  };

  if (dressing.cornice) {
    band(`${collider.id}-cornice`, collider.max.y - 0.16, 0.32, 0.02, DECOR.cornice);
  }
  if (dressing.plinth) {
    band(`${collider.id}-plinth`, collider.min.y + 0.14, 0.28, 0.02, DECOR.cornice);
  }

  for (let i = 0; i < dressing.ribs; i++) {
    const t = (i + 0.5) / dressing.ribs;
    const along = collider.min[long] + span * t;
    const ribSize: Vec3 = { x: 0, y: size.y - 0.5, z: 0 };
    ribSize[long] = 0.55;
    ribSize[thin] = proud;
    const ribCentre: Vec3 = { x: centre.x, y: centre.y - 0.15, z: centre.z };
    ribCentre[long] = along;
    boxes.push({
      id: `${collider.id}-rib-${i}`,
      centre: ribCentre,
      size: ribSize,
      colour: DECOR.cornice,
      clearance: 'embedded',
      hostColliderId: collider.id,
    });
  }

  if (dressing.windows <= 0) return;

  // Windows are only worth cutting where there is wall left after the trim.
  const usable = span - 1.2;
  if (usable <= 0) return;
  const glassWidth = Math.min(1.25, usable / dressing.windows - 0.5);
  if (glassWidth < 0.4) return;

  const glassHeight = Math.min(1.05, size.y * 0.34);
  const sillY = collider.min.y + size.y * 0.42;

  for (let i = 0; i < dressing.windows; i++) {
    const t = (i + 0.5) / dressing.windows;
    const along = collider.min[long] + 0.6 + usable * t;
    // A little seeded variation so a row of windows is not mechanically identical.
    const jitter = (random() - 0.5) * 0.12;

    const glassSize: Vec3 = { x: 0, y: glassHeight, z: 0 };
    glassSize[long] = glassWidth;
    glassSize[thin] = thickness + 0.02;
    const glassCentre: Vec3 = { x: centre.x, y: sillY + glassHeight / 2 + jitter, z: centre.z };
    glassCentre[long] = along;
    boxes.push({
      id: `${collider.id}-window-${i}`,
      centre: glassCentre,
      size: glassSize,
      colour: DECOR.windowGlass,
      clearance: 'embedded',
      hostColliderId: collider.id,
    });

    // Sill and lintel stand proud of the glass, which is what makes the opening read as
    // recessed without cutting a hole in geometry the server also owns.
    for (const [suffix, offset] of [
      ['sill', -glassHeight / 2 - 0.09],
      ['lintel', glassHeight / 2 + 0.09],
    ] as const) {
      const barSize: Vec3 = { x: 0, y: 0.18, z: 0 };
      barSize[long] = glassWidth + 0.3;
      barSize[thin] = proud;
      const barCentre: Vec3 = { x: centre.x, y: glassCentre.y + offset, z: centre.z };
      barCentre[long] = along;
      boxes.push({
        id: `${collider.id}-window-${i}-${suffix}`,
        centre: barCentre,
        size: barSize,
        colour: DECOR.windowFrame,
        clearance: 'embedded',
        hostColliderId: collider.id,
      });
    }
  }
}

/** Jamb pilasters on the wall ends that flank a doorway, plus a lintel over the gap. */
function dressDoorway(
  doorway: Doorway,
  colliders: Map<string, BoxCollider>,
  boxes: DecorBox[],
): void {
  const left = colliders.get(doorway.left);
  const right = colliders.get(doorway.right);
  if (!left || !right) return;

  const axis = doorway.axis;
  const thin: 'x' | 'z' = axis === 'x' ? 'z' : 'x';

  for (const [name, collider, towardsGap] of [
    ['left', left, 1],
    ['right', right, -1],
  ] as const) {
    const size = sizeOf(collider);
    const centre = centreOf(collider);
    // The jamb hugs the end of the wall nearest the opening, inset far enough that the
    // whole pilaster still lives inside the host collider's footprint.
    const end = towardsGap > 0 ? collider.max[axis] : collider.min[axis];
    const jambSize: Vec3 = { x: 0, y: size.y - 0.06, z: 0 };
    jambSize[axis] = 0.4;
    jambSize[thin] = size[thin] + PROUD_TOLERANCE * 2;
    const jambCentre: Vec3 = { x: centre.x, y: centre.y, z: centre.z };
    jambCentre[axis] = end - towardsGap * 0.2;

    boxes.push({
      id: `${doorway.id}-jamb-${name}`,
      centre: jambCentre,
      size: jambSize,
      colour: DECOR.doorFrame,
      clearance: 'embedded',
      hostColliderId: collider.id,
    });
  }
}

// ---------------------------------------------------------------------------
// Plan construction
// ---------------------------------------------------------------------------

const GROUND_HALF_EXTENT = TERRAIN_INNER_HALF_EXTENT;
const GROUND_CELL = 2.5;
const TERRAIN_HALF_EXTENT = 120;
const TERRAIN_CELL = 5;

function buildGround(seed: number): ColourGrid {
  const cells = (GROUND_HALF_EXTENT * 2) / GROUND_CELL;
  const grid: ColourGrid = {
    originX: -GROUND_HALF_EXTENT,
    originZ: -GROUND_HALF_EXTENT,
    cellSize: GROUND_CELL,
    cells,
    heights: new Float32Array((cells + 1) * (cells + 1)),
    colours: new Float32Array(cells * cells * 3),
    mask: new Uint8Array(cells * cells).fill(1),
  };

  const base = parseHex(DECOR.groundBase);
  const dry = parseHex(DECOR.groundDry);
  const worn = parseHex(DECOR.groundWorn);

  for (let cz = 0; cz < cells; cz++) {
    for (let cx = 0; cx < cells; cx++) {
      const worldX = grid.originX + (cx + 0.5) * GROUND_CELL;
      const worldZ = grid.originZ + (cz + 0.5) * GROUND_CELL;

      // Three fields, all pure functions of position and seed: patchy sun-bleaching, a
      // worn ring at the radius where fights concentrate, and a fine value break-up.
      // Noise rather than per-cell randomness, so the variation reads as ground cover
      // instead of television static.
      const dryness = fbm(worldX * 0.055, worldZ * 0.055, seed);
      const distanceToCore = Math.hypot(worldX, worldZ);
      const wear = Math.max(0, 1 - Math.abs(distanceToCore - 12) / 7) * 0.3;
      const shade = 0.9 + fbm(worldX * 0.21, worldZ * 0.21, seed + 233) * 0.22;

      const index = (cz * cells + cx) * 3;
      grid.colours[index] = mix3(base.r, dry.r, worn.r, dryness, wear) * shade;
      grid.colours[index + 1] = mix3(base.g, dry.g, worn.g, dryness, wear) * shade;
      grid.colours[index + 2] = mix3(base.b, dry.b, worn.b, dryness, wear) * shade;
    }
  }

  return grid;
}

function mix3(a: number, b: number, c: number, tb: number, tc: number): number {
  return (a + (b - a) * tb) * (1 - tc) + c * tc;
}

function buildTerrain(seed: number): ColourGrid {
  const cells = (TERRAIN_HALF_EXTENT * 2) / TERRAIN_CELL;
  const corners = cells + 1;
  const grid: ColourGrid = {
    originX: -TERRAIN_HALF_EXTENT,
    originZ: -TERRAIN_HALF_EXTENT,
    cellSize: TERRAIN_CELL,
    cells,
    heights: new Float32Array(corners * corners),
    colours: new Float32Array(cells * cells * 3),
    mask: new Uint8Array(cells * cells),
  };

  for (let i = 0; i < corners; i++) {
    for (let j = 0; j < corners; j++) {
      const worldX = grid.originX + j * TERRAIN_CELL;
      const worldZ = grid.originZ + i * TERRAIN_CELL;
      // Flat where it meets the arena, rising into hills further out, so the two
      // surfaces join at exactly y = 0 and the seam is invisible.
      const outside = Math.max(
        0,
        Math.max(Math.abs(worldX), Math.abs(worldZ)) - TERRAIN_INNER_HALF_EXTENT,
      );
      const ramp = Math.min(1, outside / 30);
      const hills = fbm(worldX * 0.018, worldZ * 0.018, seed + 91) - 0.35;
      grid.heights[i * corners + j] = ramp * ramp * hills * 34;
    }
  }

  const base = parseHex(DECOR.terrain);
  for (let cz = 0; cz < cells; cz++) {
    for (let cx = 0; cx < cells; cx++) {
      const minX = grid.originX + cx * TERRAIN_CELL;
      const minZ = grid.originZ + cz * TERRAIN_CELL;
      const maxX = minX + TERRAIN_CELL;
      const maxZ = minZ + TERRAIN_CELL;

      // Punch out the arena footprint; the decorated ground plane covers it.
      const insideArena =
        minX >= -TERRAIN_INNER_HALF_EXTENT &&
        maxX <= TERRAIN_INNER_HALF_EXTENT &&
        minZ >= -TERRAIN_INNER_HALF_EXTENT &&
        maxZ <= TERRAIN_INNER_HALF_EXTENT;
      if (insideArena) continue;

      grid.mask[cz * cells + cx] = 1;
      const shade = 0.82 + fbm((minX + 2.5) * 0.09, (minZ + 2.5) * 0.09, seed + 401) * 0.42;
      const index = (cz * cells + cx) * 3;
      grid.colours[index] = base.r * shade;
      grid.colours[index + 1] = base.g * shade;
      grid.colours[index + 2] = base.b * shade;
    }
  }

  return grid;
}

/** Bilinear height lookup into a terrain grid, used to seat outdoor props. */
export function sampleTerrainHeight(grid: ColourGrid, x: number, z: number): number {
  const corners = grid.cells + 1;
  const fx = (x - grid.originX) / grid.cellSize;
  const fz = (z - grid.originZ) / grid.cellSize;
  const ix = Math.max(0, Math.min(grid.cells - 1, Math.floor(fx)));
  const iz = Math.max(0, Math.min(grid.cells - 1, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - ix));
  const tz = Math.max(0, Math.min(1, fz - iz));

  const h00 = grid.heights[iz * corners + ix];
  const h10 = grid.heights[iz * corners + ix + 1];
  const h01 = grid.heights[(iz + 1) * corners + ix];
  const h11 = grid.heights[(iz + 1) * corners + ix + 1];
  return (h00 + (h10 - h00) * tx) * (1 - tz) + (h01 + (h11 - h01) * tx) * tz;
}

/** Vegetation and clutter inside the arena, kept out of the geometry and off the paths. */
function scatterInsideArena(
  index: ColliderIndex,
  random: () => number,
  props: PropInstance[],
): void {
  const attempts = 900;
  const probeMin: Vec3 = { x: 0, y: 0, z: 0 };
  const probeMax: Vec3 = { x: 0, y: 0, z: 0 };

  for (let i = 0; i < attempts; i++) {
    const x = (random() * 2 - 1) * 30.5;
    const z = (random() * 2 - 1) * 30.5;

    // Anything standing here would sprout out of a wall or a crate — skip it. The probe
    // is the prop's own footprint, not the player capsule: clutter is allowed to be
    // *next to* geometry, just not inside it.
    probeMin.x = x - 0.5;
    probeMin.z = z - 0.5;
    probeMin.y = 0.02;
    probeMax.x = x + 0.5;
    probeMax.z = z + 0.5;
    probeMax.y = CLUTTER_HEIGHT;
    if (index.query(probeMin, probeMax).some((collider) => overlaps(collider, probeMin, probeMax)))
      continue;

    const roll = random();
    const kind: PropKind = roll < 0.72 ? 'grass' : 'pebble';
    props.push({
      kind,
      position: { x, y: 0, z },
      rotationY: random() * Math.PI * 2,
      // Capped so `height * scale` can never exceed the controller's step height —
      // the clearance contract for `clutter`.
      scale: kind === 'grass' ? 0.75 + random() * 0.5 : 0.6 + random() * 0.7,
      tint: tintMultiplier(random() * 2 - 1, 0.86 + random() * 0.3),
      clearance: 'clutter',
    });
  }
}

function overlaps(collider: BoxCollider, min: Vec3, max: Vec3): boolean {
  return (
    collider.min.x < max.x &&
    collider.max.x > min.x &&
    collider.min.y < max.y &&
    collider.max.y > min.y &&
    collider.min.z < max.z &&
    collider.max.z > min.z
  );
}

/** The landscape beyond the walls: trees, boulders, shrubs, fence lines and sheds. */
function scatterOutside(terrain: ColourGrid, random: () => number, props: PropInstance[]): void {
  const place = (kind: PropKind, count: number, minRadius: number, maxRadius: number): void => {
    for (let i = 0; i < count; i++) {
      const angle = random() * Math.PI * 2;
      const radius = minRadius + (maxRadius - minRadius) * Math.sqrt(random());
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      // Square arena, round scatter: skip anything that lands back on the walls.
      if (Math.abs(x) < ARENA_OUTER_HALF_EXTENT + 1 && Math.abs(z) < ARENA_OUTER_HALF_EXTENT + 1) {
        continue;
      }

      props.push({
        kind,
        position: { x, y: sampleTerrainHeight(terrain, x, z), z },
        rotationY: random() * Math.PI * 2,
        scale: 0.7 + random() * 0.8,
        tint: tintMultiplier(random() * 2 - 1, 0.85 + random() * 0.32),
        clearance: 'outside',
      });
    }
  };

  place('tree', 190, 38, 108);
  place('shrub', 210, 36, 104);
  place('rock', 150, 36, 110);
  place('shed', 16, 44, 84);

  // Fence lines: a seeded start point and a heading, then posts along it. Lines read as
  // deliberate land division, which is what stops the outfield looking like noise.
  for (let line = 0; line < 9; line++) {
    const angle = random() * Math.PI * 2;
    const radius = 42 + random() * 45;
    const heading = random() * Math.PI * 2;
    const sections = 6 + Math.floor(random() * 10);
    const startX = Math.cos(angle) * radius;
    const startZ = Math.sin(angle) * radius;

    for (let i = 0; i < sections; i++) {
      const x = startX + Math.cos(heading) * i * 2.4;
      const z = startZ + Math.sin(heading) * i * 2.4;
      if (Math.abs(x) < ARENA_OUTER_HALF_EXTENT + 2 && Math.abs(z) < ARENA_OUTER_HALF_EXTENT + 2) {
        continue;
      }
      if (Math.hypot(x, z) > TERRAIN_HALF_EXTENT - 8) break;

      props.push({
        kind: 'fence',
        position: { x, y: sampleTerrainHeight(terrain, x, z), z },
        rotationY: heading,
        scale: 1,
        tint: tintMultiplier(random() * 2 - 1, 0.9 + random() * 0.22),
        clearance: 'outside',
      });
    }
  }
}

/**
 * Builds the whole decoration plan.
 *
 * Deterministic for a given arena: the seed is hashed from the arena's name and a layout
 * version, so two clients running the same build always produce the same world, and
 * bumping `decor-v` is the only way to change it.
 */
export function buildDecorPlan(arena: ArenaDefinition = getArena()): DecorPlan {
  const seed = hashSeed(arena.name, 'decor-v1');
  const random = mulberry32(seed);
  const index = new ColliderIndex(arena.colliders);

  const byId = new Map<string, BoxCollider>();
  for (const collider of arena.colliders) byId.set(collider.id, collider);

  const boxes: DecorBox[] = [];
  const props: PropInstance[] = [];

  for (const dressing of DRESSED_WALLS) {
    const collider = byId.get(dressing.colliderId);
    if (collider) dressWall(collider, dressing, boxes, random);
  }
  for (const doorway of DOORWAYS) {
    dressDoorway(doorway, byId, boxes);
  }

  for (const floor of INTERIOR_FLOORS) {
    boxes.push({
      id: `${floor.id}-interior-floor`,
      centre: {
        x: (floor.minX + floor.maxX) / 2,
        y: floor.y + FLUSH_THICKNESS / 2,
        z: (floor.minZ + floor.maxZ) / 2,
      },
      size: {
        x: floor.maxX - floor.minX,
        y: FLUSH_THICKNESS,
        z: floor.maxZ - floor.minZ,
      },
      colour: DECOR.interiorFloor,
      clearance: 'flush',
      restingY: floor.y,
    });
  }

  addRoofDetail(byId, boxes, random);
  addPerimeterCoping(byId, boxes);

  const ground = buildGround(seed);
  const terrain = buildTerrain(seed);

  scatterInsideArena(index, random, props);
  scatterOutside(terrain, random, props);

  return {
    seed,
    boxes,
    props,
    ground,
    terrain,
    // The plan draws its own decorated floor in place of the shared ground slab's visual.
    replacedVisualIds: ['ground'],
  };
}

/** Inlaid panels and low vents on the Foundry's walkable roof. */
function addRoofDetail(
  byId: Map<string, BoxCollider>,
  boxes: DecorBox[],
  random: () => number,
): void {
  const roof = byId.get('foundry-roof');
  if (!roof) return;

  const top = roof.max.y;
  const centre = centreOf(roof);
  const size = sizeOf(roof);

  boxes.push({
    id: 'foundry-roof-inlay',
    centre: { x: centre.x, y: top + FLUSH_THICKNESS / 2, z: centre.z },
    size: { x: size.x - 2.2, y: FLUSH_THICKNESS, z: size.z - 2.2 },
    colour: DECOR.cornice,
    clearance: 'flush',
    restingY: top,
  });

  for (let i = 0; i < 3; i++) {
    const height = 0.28 + random() * 0.14;
    boxes.push({
      id: `foundry-roof-vent-${i}`,
      centre: {
        x: centre.x + (random() - 0.5) * (size.x - 4),
        y: top + height / 2,
        z: centre.z + (random() - 0.5) * (size.z - 4),
      },
      size: { x: 0.9 + random() * 0.5, y: height, z: 0.9 + random() * 0.5 },
      colour: DECOR.windowFrame,
      clearance: 'clutter',
      restingY: top,
    });
  }
}

/**
 * A coping band along the tops of the perimeter walls.
 *
 * Classified `overhead` rather than `embedded`: it sits *on* the walls rather than in
 * them, so the test proves no player can reach it instead of taking it on trust. The
 * arena's invisible ceiling collider is what makes that true.
 */
function addPerimeterCoping(byId: Map<string, BoxCollider>, boxes: DecorBox[]): void {
  for (const id of ['wall-north', 'wall-south', 'wall-east', 'wall-west']) {
    const collider = byId.get(id);
    if (!collider) continue;
    const size = sizeOf(collider);
    const centre = centreOf(collider);
    boxes.push({
      id: `${id}-coping`,
      centre: { x: centre.x, y: collider.max.y + 0.19, z: centre.z },
      size: { x: size.x + 0.5, y: 0.38, z: size.z + 0.5 },
      colour: DECOR.cornice,
      clearance: 'overhead',
    });
  }
}
