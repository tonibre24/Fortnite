import { type Box, CollisionWorld } from './collision.js';
import {
  BUILDING_DOOR_HEIGHT,
  BUILDING_DOOR_WIDTH,
  BUILDING_FLOOR_THICKNESS,
  BUILDING_GAP,
  BUILDING_MAX_SIZE,
  BUILDING_MAX_STOREYS,
  BUILDING_MIN_SIZE,
  BUILDING_PLACEMENT_ATTEMPTS,
  BUILDING_RAMP_CHANCE,
  BUILDING_STOREY_HEIGHT,
  BUILDING_WALL_THICKNESS,
  COLOR_BOUNDARY,
  COLOR_FLOOR,
  COLOR_GROUND,
  COLOR_HILL,
  COLOR_RAMP,
  COLOR_ROCK,
  COLOR_ROOF,
  COLOR_TREE_CANOPY,
  COLOR_TREE_TRUNK,
  COLOR_WALL,
  COLOR_WALL_ALT,
  GROUND_Y,
  HILL_COUNT,
  HILL_MAX_RADIUS,
  HILL_MAX_TIERS,
  HILL_MIN_RADIUS,
  HILL_MIN_TIERS,
  HILL_TIER_HEIGHT,
  MAP_HALF,
  MAP_WALL_HEIGHT,
  MAP_WALL_THICKNESS,
  MAX_PLAYERS,
  POI_GRID,
  POI_JITTER,
  POI_MAX_BUILDINGS,
  POI_MIN_BUILDINGS,
  POI_RADIUS,
  ROCK_COUNT,
  ROCK_MAX_SIZE,
  ROCK_MIN_SIZE,
  SCATTER_ATTEMPTS,
  SCATTER_POI_CLEARANCE,
  SPAWN_CLEARANCE_RADIUS,
  SPAWN_RING_RADIUS,
  STAIR_RISE,
  STAIR_RUN,
  STAIR_WIDTH,
  TREE_CANOPY_SCALE,
  TREE_COUNT,
  TREE_MAX_HEIGHT,
  TREE_MIN_HEIGHT,
  TREE_TRUNK_RADIUS,
} from './constants.js';
import { f32, quantizeYaw, type Vec3 } from './math.js';
import { Rng, hashNumbers } from './rng.js';

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

/** A stepped mound. Kept around after generation because it defines terrain height. */
export interface Hill {
  x: number;
  z: number;
  radius: number;
  tiers: number;
}

export interface Poi {
  x: number;
  z: number;
}

/** A placed building. Kept so later phases can put loot and chests indoors. */
export interface Building {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  baseY: number;
  storeys: number;
  /** 0 = -Z wall, 1 = +Z, 2 = -X, 3 = +X. */
  doorSide: number;
}

export interface GameMap {
  seed: number;
  boxes: MapBox[];
  /** Only the solid boxes, indexed for queries. */
  world: CollisionWorld;
  spawns: Spawn[];
  pois: Poi[];
  hills: Hill[];
  buildings: Building[];
}

/** Depth of the ground slab. Anything thinner risks tunnelling at high speed. */
const GROUND_THICKNESS = 2;

/**
 * How far from a POI centre scattered props must stay. A building centred at
 * the edge of POI_RADIUS still reaches half its own width further out.
 */
const SCATTER_CLEARANCE = POI_RADIUS + BUILDING_MAX_SIZE / 2 + SCATTER_POI_CLEARANCE;

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

/**
 * Where the internal stairwell sits: against a side wall rather than centred,
 * because the run tops out at the +Z wall and a centred slot would land in a
 * +Z doorway. It also moves off whichever side wall holds the door.
 */
export function stairwellSlot(
  f: { minX: number; maxX: number },
  doorSide: number,
): { minX: number; maxX: number } {
  const t = BUILDING_WALL_THICKNESS;
  if (doorSide === 3) {
    const minX = f.minX + t;
    return { minX, maxX: minX + STAIR_WIDTH };
  }
  const maxX = f.maxX - t;
  return { minX: maxX - STAIR_WIDTH, maxX };
}

/** Convenience constructor from a footprint centre, a base height and extents. */
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
 * Builds the world from a seed.
 *
 * Client and server both call this and must end up with byte-identical
 * geometry, so everything here is driven by one deterministic RNG consumed in a
 * fixed order - no time, no iteration over unordered collections, no floating
 * point that depends on anything but the seed. `hashMap` fingerprints the
 * result and the client checks it against the server's on join.
 */
export function generateMap(seed: number): GameMap {
  const rng = new Rng(seed);
  const boxes: MapBox[] = [];

  boxes.push(
    box(-MAP_HALF, GROUND_Y - GROUND_THICKNESS, -MAP_HALF, MAP_HALF, GROUND_Y, MAP_HALF, COLOR_GROUND),
  );
  addBoundaryWalls(boxes);

  const pois = placePois(rng);
  const hills = placeHills(rng, pois);
  for (const hill of hills) addHill(boxes, hill);

  const height = (x: number, z: number): number => terrainHeightAt(hills, x, z);

  const buildings: Building[] = [];
  for (const poi of pois) addPoiBuildings(boxes, buildings, rng, poi, height);
  addTrees(boxes, rng, pois, height);
  addRocks(boxes, rng, pois, height);

  const solid = boxes.filter((b) => b.solid);
  return {
    seed,
    boxes,
    world: new CollisionWorld(solid),
    spawns: buildSpawnRing(height),
    pois,
    hills,
    buildings,
  };
}

/**
 * Height of the walkable terrain at a point: the ground plus whichever hill
 * tier covers it. Placement uses this instead of a raycast so props sit on the
 * surface without needing the collision world to exist yet.
 */
export function terrainHeightAt(hills: readonly Hill[], x: number, z: number): number {
  let top = GROUND_Y;
  for (const hill of hills) {
    const dx = Math.abs(x - hill.x);
    const dz = Math.abs(z - hill.z);
    for (let tier = 0; tier < hill.tiers; tier++) {
      const half = hill.radius * (1 - tier / hill.tiers);
      if (dx <= half && dz <= half) {
        const tierTop = GROUND_Y + (tier + 1) * HILL_TIER_HEIGHT;
        if (tierTop > top) top = tierTop;
      }
    }
  }
  return top;
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

// ------------------------------------------------------------------ points of interest

function placePois(rng: Rng): Poi[] {
  const pois: Poi[] = [];
  const cell = (MAP_HALF * 2) / POI_GRID;
  const jitter = cell * POI_JITTER;
  const middle = (POI_GRID - 1) / 2;

  for (let gz = 0; gz < POI_GRID; gz++) {
    for (let gx = 0; gx < POI_GRID; gx++) {
      // The centre cell stays empty so the spawn ring is never inside a town.
      if (gx === middle && gz === middle) continue;
      pois.push({
        x: -MAP_HALF + cell * (gx + 0.5) + rng.range(-jitter, jitter),
        z: -MAP_HALF + cell * (gz + 0.5) + rng.range(-jitter, jitter),
      });
    }
  }
  return pois;
}

interface Footprint {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

function addPoiBuildings(
  boxes: MapBox[],
  buildings: Building[],
  rng: Rng,
  poi: Poi,
  height: (x: number, z: number) => number,
): void {
  const count = rng.int(POI_MIN_BUILDINGS, POI_MAX_BUILDINGS);
  const placed: Footprint[] = [];

  for (let i = 0; i < count; i++) {
    const width = rng.range(BUILDING_MIN_SIZE, BUILDING_MAX_SIZE);
    const depth = rng.range(BUILDING_MIN_SIZE, BUILDING_MAX_SIZE);
    const storeys = rng.int(1, BUILDING_MAX_STOREYS);
    const doorSide = rng.int(0, 3);
    // Only single-storey buildings get an outside stair. On a two-storey one
    // the run would be over ten units long and would happily march through a
    // neighbour's wall; those already have an internal stairwell anyway.
    const hasRamp = rng.bool(BUILDING_RAMP_CHANCE) && storeys === 1;
    const stairSide = doorSide ^ 1;
    const stairReach = hasRamp ? externalStairLength(storeys) : 0;

    // Attempts are drawn from the RNG whether or not they succeed, so the
    // stream stays in lockstep between client and server.
    let chosen: Footprint | null = null;
    let reserved: Footprint | null = null;
    for (let attempt = 0; attempt < BUILDING_PLACEMENT_ATTEMPTS; attempt++) {
      const cx = poi.x + rng.range(-POI_RADIUS, POI_RADIUS);
      const cz = poi.z + rng.range(-POI_RADIUS, POI_RADIUS);
      const footprint: Footprint = {
        minX: cx - width / 2,
        minZ: cz - depth / 2,
        maxX: cx + width / 2,
        maxZ: cz + depth / 2,
      };
      // Reserve the outside stair's ground too, or it lands in a neighbour.
      const claimed = expand(footprint, stairSide, stairReach);
      if (chosen !== null) continue;
      if (!insideMap(claimed)) continue;
      if (placed.some((other) => overlaps(claimed, other, BUILDING_GAP))) continue;
      chosen = footprint;
      reserved = claimed;
    }
    if (chosen === null || reserved === null) continue;

    placed.push(reserved);
    buildings.push(addBuilding(boxes, chosen, storeys, doorSide, hasRamp, height));
  }
}

/** Ground an external stair on `side` will occupy, beyond the footprint. */
function externalStairLength(storeys: number): number {
  const rise = storeys * BUILDING_STOREY_HEIGHT + BUILDING_FLOOR_THICKNESS;
  return Math.ceil(rise / STAIR_RISE) * STAIR_RUN;
}

function expand(f: Footprint, side: number, amount: number): Footprint {
  if (amount === 0) return f;
  switch (side) {
    case 0:
      return { ...f, minZ: f.minZ - amount };
    case 1:
      return { ...f, maxZ: f.maxZ + amount };
    case 2:
      return { ...f, minX: f.minX - amount };
    default:
      return { ...f, maxX: f.maxX + amount };
  }
}

function insideMap(f: Footprint): boolean {
  const limit = MAP_HALF - BUILDING_GAP;
  return f.minX > -limit && f.maxX < limit && f.minZ > -limit && f.maxZ < limit;
}

function overlaps(a: Footprint, b: Footprint, gap: number): boolean {
  return (
    a.minX - gap < b.maxX && a.maxX + gap > b.minX && a.minZ - gap < b.maxZ && a.maxZ + gap > b.minZ
  );
}

/**
 * One building: a slab floor, four walls per storey with a doorway at ground
 * level, an internal staircase to the upper floor, and a roof. The interior is
 * genuinely empty and reachable, which is the point of building them out of
 * walls rather than dropping a solid block.
 */
function addBuilding(
  boxes: MapBox[],
  f: Footprint,
  storeys: number,
  doorSide: number,
  hasRamp: boolean,
  height: (x: number, z: number) => number,
): Building {
  const t = BUILDING_WALL_THICKNESS;
  const baseY = height((f.minX + f.maxX) / 2, (f.minZ + f.maxZ) / 2);
  const wallColor = (f.minX + f.maxZ) % 2 < 1 ? COLOR_WALL : COLOR_WALL_ALT;

  // A pad under the whole footprint, so a building on a hillside still has a
  // flat floor to walk on.
  boxes.push(box(f.minX, baseY - BUILDING_FLOOR_THICKNESS, f.minZ, f.maxX, baseY, f.maxZ, COLOR_FLOOR));

  for (let storey = 0; storey < storeys; storey++) {
    const y = baseY + storey * BUILDING_STOREY_HEIGHT;
    const top = y + BUILDING_STOREY_HEIGHT;
    const ground = storey === 0;

    // -Z and +Z walls span the full width; -X and +X sit between them.
    addWall(boxes, f.minX, y, f.minZ, f.maxX, top, f.minZ + t, ground && doorSide === 0, 'x', wallColor);
    addWall(boxes, f.minX, y, f.maxZ - t, f.maxX, top, f.maxZ, ground && doorSide === 1, 'x', wallColor);
    addWall(boxes, f.minX, y, f.minZ + t, f.minX + t, top, f.maxZ - t, ground && doorSide === 2, 'z', wallColor);
    addWall(boxes, f.maxX - t, y, f.minZ + t, f.maxX, top, f.maxZ - t, ground && doorSide === 3, 'z', wallColor);

    if (storey + 1 < storeys) addStorey(boxes, f, y, top, doorSide);
  }

  const roofY = baseY + storeys * BUILDING_STOREY_HEIGHT;
  boxes.push(box(f.minX, roofY, f.minZ, f.maxX, roofY + BUILDING_FLOOR_THICKNESS, f.maxZ, COLOR_ROOF));

  // Put the outside stair on the far side from the door, or it would wall the
  // entrance in.
  if (hasRamp) addExternalStair(boxes, f, baseY, roofY + BUILDING_FLOOR_THICKNESS, doorSide ^ 1);

  return { ...f, baseY, storeys, doorSide };
}

/**
 * A wall, optionally with a doorway punched through it: two jambs and a lintel
 * above the opening.
 */
function addWall(
  boxes: MapBox[],
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  withDoor: boolean,
  span: 'x' | 'z',
  color: number,
): void {
  if (!withDoor) {
    boxes.push(box(minX, minY, minZ, maxX, maxY, maxZ, color));
    return;
  }

  const lo = span === 'x' ? minX : minZ;
  const hi = span === 'x' ? maxX : maxZ;
  const centre = (lo + hi) / 2;
  const doorLo = centre - BUILDING_DOOR_WIDTH / 2;
  const doorHi = centre + BUILDING_DOOR_WIDTH / 2;
  const lintelY = Math.min(maxY, minY + BUILDING_DOOR_HEIGHT);

  if (span === 'x') {
    boxes.push(box(minX, minY, minZ, doorLo, maxY, maxZ, color));
    boxes.push(box(doorHi, minY, minZ, maxX, maxY, maxZ, color));
    if (lintelY < maxY) boxes.push(box(doorLo, lintelY, minZ, doorHi, maxY, maxZ, color));
  } else {
    boxes.push(box(minX, minY, minZ, maxX, maxY, doorLo, color));
    boxes.push(box(minX, minY, doorHi, maxX, maxY, maxZ, color));
    if (lintelY < maxY) boxes.push(box(minX, lintelY, doorLo, maxX, maxY, doorHi, color));
  }
}

/**
 * An upper floor and the stairwell that reaches it.
 *
 * The stairs run along +Z against one wall and the floor above is cut away in a
 * slot just wide enough for them - a stairwell, not a trapdoor. That matters:
 * a straight run arrives at the far end of whatever hole it climbs through, so
 * if the hole spanned the room's full width there would be no floor to step
 * onto at the top. Here the player tops out level with the floor on either
 * side and walks sideways off the stairs.
 */
function addStorey(
  boxes: MapBox[],
  f: Footprint,
  baseY: number,
  floorY: number,
  doorSide: number,
): void {
  const t = BUILDING_WALL_THICKNESS;
  const steps = Math.ceil((floorY - baseY) / STAIR_RISE);
  const rise = (floorY - baseY) / steps;
  const run = steps * STAIR_RUN;

  const { minX: slotMinX, maxX: slotMaxX } = stairwellSlot(f, doorSide);
  const runMaxZ = f.maxZ - t;
  const runMinZ = Math.max(f.minZ + t, runMaxZ - run);
  const floorTop = floorY + BUILDING_FLOOR_THICKNESS;

  // Floor everywhere except the stairwell slot.
  boxes.push(box(f.minX, floorY, f.minZ, f.maxX, floorTop, runMinZ, COLOR_FLOOR));
  boxes.push(box(f.minX, floorY, runMinZ, slotMinX, floorTop, f.maxZ, COLOR_FLOOR));
  boxes.push(box(slotMaxX, floorY, runMinZ, f.maxX, floorTop, f.maxZ, COLOR_FLOOR));

  // Steps rising towards +Z, the lowest one open to the room below.
  for (let i = 0; i < steps; i++) {
    const minZ = runMinZ + i * STAIR_RUN;
    boxes.push(
      box(slotMinX, baseY, minZ, slotMaxX, baseY + (i + 1) * rise, minZ + STAIR_RUN, COLOR_RAMP),
    );
  }
}

/** Steps climbing the outside of one wall up to the roof. */
function addExternalStair(
  boxes: MapBox[],
  f: Footprint,
  baseY: number,
  roofY: number,
  side: number,
): void {
  const steps = Math.ceil((roofY - baseY) / STAIR_RISE);
  const rise = (roofY - baseY) / steps;
  const centreX = (f.minX + f.maxX) / 2;
  const centreZ = (f.minZ + f.maxZ) / 2;
  const half = STAIR_WIDTH / 2;

  for (let i = 0; i < steps; i++) {
    const top = baseY + (i + 1) * rise;
    const near = i * STAIR_RUN;
    const far = near + STAIR_RUN;
    switch (side) {
      case 0:
        boxes.push(box(centreX - half, baseY, f.minZ - far, centreX + half, top, f.minZ - near, COLOR_RAMP));
        break;
      case 1:
        boxes.push(box(centreX - half, baseY, f.maxZ + near, centreX + half, top, f.maxZ + far, COLOR_RAMP));
        break;
      case 2:
        boxes.push(box(f.minX - far, baseY, centreZ - half, f.minX - near, top, centreZ + half, COLOR_RAMP));
        break;
      default:
        boxes.push(box(f.maxX + near, baseY, centreZ - half, f.maxX + far, top, centreZ + half, COLOR_RAMP));
        break;
    }
  }
}

// -------------------------------------------------------------------------- terrain

function placeHills(rng: Rng, pois: readonly Poi[]): Hill[] {
  const hills: Hill[] = [];
  for (let i = 0; i < HILL_COUNT; i++) {
    const radius = rng.range(HILL_MIN_RADIUS, HILL_MAX_RADIUS);
    const tiers = rng.int(HILL_MIN_TIERS, HILL_MAX_TIERS);
    // Buildings reach POI_RADIUS from the centre, so a hill has to clear that
    // plus its own extent - otherwise a tier pokes up through someone's floor.
    const spot = findClearSpot(rng, pois, radius);
    if (spot === null) continue;
    hills.push({ x: spot.x, z: spot.z, radius, tiers });
  }
  return hills;
}

/** Nested tiers, each a step high, so a hill is cover you can also walk up. */
function addHill(boxes: MapBox[], hill: Hill): void {
  for (let tier = 0; tier < hill.tiers; tier++) {
    const half = hill.radius * (1 - tier / hill.tiers);
    boxes.push(
      box(
        hill.x - half,
        GROUND_Y,
        hill.z - half,
        hill.x + half,
        GROUND_Y + (tier + 1) * HILL_TIER_HEIGHT,
        hill.z + half,
        COLOR_HILL,
      ),
    );
  }
}

function addTrees(
  boxes: MapBox[],
  rng: Rng,
  pois: readonly Poi[],
  height: (x: number, z: number) => number,
): void {
  for (let i = 0; i < TREE_COUNT; i++) {
    const treeHeight = rng.range(TREE_MIN_HEIGHT, TREE_MAX_HEIGHT);
    const spot = findClearSpot(rng, pois, TREE_TRUNK_RADIUS * TREE_CANOPY_SCALE);
    if (spot === null) continue;

    const base = height(spot.x, spot.z);
    const trunk = TREE_TRUNK_RADIUS * 2;
    boxes.push(boxAt(spot.x, base, spot.z, trunk, treeHeight, trunk, COLOR_TREE_TRUNK));

    // Canopies are decoration only - you can walk under them, and blocking
    // movement on foliage would make the forest unplayable.
    const canopy = trunk * TREE_CANOPY_SCALE;
    const canopyHeight = treeHeight * 0.45;
    boxes.push(
      boxAt(spot.x, base + treeHeight * 0.62, spot.z, canopy, canopyHeight, canopy, COLOR_TREE_CANOPY, false),
    );
  }
}

function addRocks(
  boxes: MapBox[],
  rng: Rng,
  pois: readonly Poi[],
  height: (x: number, z: number) => number,
): void {
  for (let i = 0; i < ROCK_COUNT; i++) {
    const size = rng.range(ROCK_MIN_SIZE, ROCK_MAX_SIZE);
    const spot = findClearSpot(rng, pois, size);
    if (spot === null) continue;
    boxes.push(
      boxAt(spot.x, height(spot.x, spot.z), spot.z, size, size * rng.range(0.6, 1.2), size, COLOR_ROCK),
    );
  }
}

/**
 * A point clear of every POI's built-up area and of the spawn ring.
 *
 * The test is box against box rather than centre distance: a hill is a square
 * footprint and so is a town, and a circular check lets their corners overlap.
 * Always burns the same number of RNG draws whether or not it succeeds, so a
 * rejected attempt cannot desynchronise generation between machines.
 */
function findClearSpot(
  rng: Rng,
  pois: readonly Poi[],
  halfExtent: number,
): { x: number; z: number } | null {
  const limit = MAP_HALF - 4;
  const keepOut = SCATTER_CLEARANCE + halfExtent;
  let found: { x: number; z: number } | null = null;
  for (let attempt = 0; attempt < SCATTER_ATTEMPTS; attempt++) {
    const x = rng.range(-limit, limit);
    const z = rng.range(-limit, limit);
    if (found !== null) continue;
    if (Math.hypot(x, z) < SPAWN_CLEARANCE_RADIUS + halfExtent) continue;
    if (pois.some((poi) => Math.abs(x - poi.x) < keepOut && Math.abs(z - poi.z) < keepOut)) continue;
    found = { x, z };
  }
  return found;
}

// --------------------------------------------------------------------------- spawns

function buildSpawnRing(height: (x: number, z: number) => number): Spawn[] {
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
      pos: { x: f32(x), y: f32(height(x, z)), z: f32(z) },
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
