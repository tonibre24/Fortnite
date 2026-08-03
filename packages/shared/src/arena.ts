import { STEP_HEIGHT } from './constants.js';
import type { Vec3 } from './math.js';

/**
 * "Riftfront Yard" — an original compact free-for-all arena built entirely from
 * primitives, generated identically on the client (rendering + camera collision)
 * and the server (movement collision + hitscan occlusion).
 *
 * Every collider is an axis-aligned box. Ramps are authored as a sloped *visual*
 * over a staircase of AABB colliders whose rise stays under `STEP_HEIGHT`; that
 * keeps movement deterministic and free of slope-sliding artefacts while still
 * looking and playing like a ramp.
 */

export type MaterialKey =
  'ground' | 'wall' | 'structure' | 'platform' | 'accent' | 'accentAlt' | 'metal' | 'core';

export interface BoxCollider {
  id: string;
  min: Vec3;
  max: Vec3;
}

export interface ArenaVisual {
  id: string;
  /** Full extents (width, height, depth) before rotation. */
  size: Vec3;
  /** Centre of the box. */
  position: Vec3;
  /** Euler rotation in radians; only used by ramp visuals. */
  rotation: Vec3;
  material: MaterialKey;
}

export interface SpawnPoint {
  position: Vec3;
  yaw: number;
}

export interface ArenaBounds {
  min: Vec3;
  max: Vec3;
}

export interface ArenaDefinition {
  name: string;
  bounds: ArenaBounds;
  colliders: BoxCollider[];
  visuals: ArenaVisual[];
  spawnPoints: SpawnPoint[];
  /** Landmark labels used by the minimap-free orientation cues in the HUD. */
  landmarks: { name: string; position: Vec3 }[];
}

const HALF_EXTENT = 32;
const WALL_HEIGHT = 9;

interface BuilderState {
  colliders: BoxCollider[];
  visuals: ArenaVisual[];
}

function addBox(
  state: BuilderState,
  id: string,
  centre: Vec3,
  size: Vec3,
  material: MaterialKey,
  options: { collides?: boolean; visible?: boolean } = {},
): void {
  const { collides = true, visible = true } = options;
  if (collides) {
    state.colliders.push({
      id,
      min: { x: centre.x - size.x / 2, y: centre.y - size.y / 2, z: centre.z - size.z / 2 },
      max: { x: centre.x + size.x / 2, y: centre.y + size.y / 2, z: centre.z + size.z / 2 },
    });
  }
  if (visible) {
    state.visuals.push({
      id,
      size,
      position: centre,
      rotation: { x: 0, y: 0, z: 0 },
      material,
    });
  }
}

/**
 * Builds a walkable ramp: a sloped visual slab plus a staircase of colliders whose
 * individual rise never exceeds the controller's step height.
 */
function addRamp(
  state: BuilderState,
  id: string,
  options: {
    /** Centre of the ramp's bottom edge. */
    bottom: Vec3;
    /** Horizontal run of the ramp. */
    length: number;
    /** Width across the direction of travel. */
    width: number;
    /** Total rise from bottom to top. */
    height: number;
    axis: 'x' | 'z';
    /** +1 means the ramp rises towards increasing axis values. */
    sign: 1 | -1;
    material?: MaterialKey;
  },
): void {
  const { bottom, length, width, height, axis, sign, material = 'platform' } = options;
  const stepCount = Math.max(2, Math.ceil(height / (STEP_HEIGHT * 0.9)));
  const stepRun = length / stepCount;
  const stepRise = height / stepCount;

  for (let i = 0; i < stepCount; i++) {
    const top = bottom.y + stepRise * (i + 1);
    const nearOffset = stepRun * i;
    const farOffset = stepRun * (i + 1);
    const a = bottom[axis] + sign * nearOffset;
    const b = bottom[axis] + sign * farOffset;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);

    const min: Vec3 = { x: 0, y: bottom.y - 0.5, z: 0 };
    const max: Vec3 = { x: 0, y: top, z: 0 };
    if (axis === 'x') {
      min.x = lo;
      max.x = hi;
      min.z = bottom.z - width / 2;
      max.z = bottom.z + width / 2;
    } else {
      min.z = lo;
      max.z = hi;
      min.x = bottom.x - width / 2;
      max.x = bottom.x + width / 2;
    }
    state.colliders.push({ id: `${id}-step-${i}`, min, max });
  }

  // Sloped visual slab laid over the staircase.
  const slope = Math.atan2(height, length);
  const slabLength = Math.hypot(length, height);
  const thickness = 0.35;
  const centre: Vec3 = {
    x: axis === 'x' ? bottom.x + (sign * length) / 2 : bottom.x,
    y: bottom.y + height / 2,
    z: axis === 'z' ? bottom.z + (sign * length) / 2 : bottom.z,
  };

  state.visuals.push({
    id: `${id}-visual`,
    size:
      axis === 'x'
        ? { x: slabLength, y: thickness, z: width }
        : { x: width, y: thickness, z: slabLength },
    position: centre,
    rotation: axis === 'x' ? { x: 0, y: 0, z: -sign * slope } : { x: sign * slope, y: 0, z: 0 },
    material,
  });
}

function buildPerimeter(state: BuilderState): void {
  // Ground slab: a visible box whose top face sits exactly at y = 0.
  addBox(
    state,
    'ground',
    { x: 0, y: -1, z: 0 },
    { x: HALF_EXTENT * 2, y: 2, z: HALF_EXTENT * 2 },
    'ground',
  );

  const wallThickness = 1.5;
  const span = HALF_EXTENT * 2;
  const offset = HALF_EXTENT + wallThickness / 2;

  addBox(
    state,
    'wall-north',
    { x: 0, y: WALL_HEIGHT / 2, z: offset },
    { x: span + wallThickness * 2, y: WALL_HEIGHT, z: wallThickness },
    'wall',
  );
  addBox(
    state,
    'wall-south',
    { x: 0, y: WALL_HEIGHT / 2, z: -offset },
    { x: span + wallThickness * 2, y: WALL_HEIGHT, z: wallThickness },
    'wall',
  );
  addBox(
    state,
    'wall-east',
    { x: offset, y: WALL_HEIGHT / 2, z: 0 },
    { x: wallThickness, y: WALL_HEIGHT, z: span + wallThickness * 2 },
    'wall',
  );
  addBox(
    state,
    'wall-west',
    { x: -offset, y: WALL_HEIGHT / 2, z: 0 },
    { x: wallThickness, y: WALL_HEIGHT, z: span + wallThickness * 2 },
    'wall',
  );

  // Invisible ceiling stops players from reaching the tops of the outer walls.
  state.colliders.push({
    id: 'ceiling',
    min: { x: -HALF_EXTENT, y: WALL_HEIGHT, z: -HALF_EXTENT },
    max: { x: HALF_EXTENT, y: WALL_HEIGHT + 1, z: HALF_EXTENT },
  });
}

/** Central contested platform with ramp access on two sides. */
function buildCore(state: BuilderState): void {
  const platformTop = 3;
  addBox(
    state,
    'core-platform',
    { x: 0, y: platformTop / 2, z: 0 },
    { x: 15, y: platformTop, z: 15 },
    'platform',
  );

  addRamp(state, 'core-ramp-south', {
    bottom: { x: 0, y: 0, z: -14.5 },
    length: 7,
    width: 5.5,
    height: platformTop,
    axis: 'z',
    sign: 1,
  });
  addRamp(state, 'core-ramp-north', {
    bottom: { x: 0, y: 0, z: 14.5 },
    length: 7,
    width: 5.5,
    height: platformTop,
    axis: 'z',
    sign: -1,
  });

  // Cover on top of the platform so it is contested rather than dominant.
  const pillarPositions: [number, number][] = [
    [-4.5, -4.5],
    [4.5, -4.5],
    [-4.5, 4.5],
    [4.5, 4.5],
  ];
  pillarPositions.forEach(([x, z], index) => {
    addBox(
      state,
      `core-pillar-${index}`,
      { x, y: platformTop + 1.4, z },
      { x: 1.7, y: 2.8, z: 1.7 },
      'structure',
    );
  });

  // Landmark: the "rift core" obelisk at dead centre.
  addBox(
    state,
    'core-obelisk',
    { x: 0, y: platformTop + 1.6, z: 0 },
    { x: 2.2, y: 3.2, z: 2.2 },
    'core',
  );

  // Low side walls that let players crouch-free peek without full exposure.
  addBox(
    state,
    'core-side-east',
    { x: 7, y: platformTop + 0.6, z: 0 },
    { x: 1, y: 1.2, z: 11 },
    'structure',
  );
  addBox(
    state,
    'core-side-west',
    { x: -7, y: platformTop + 0.6, z: 0 },
    { x: 1, y: 1.2, z: 11 },
    'structure',
  );
}

/** North-east interior building with two rooms, doorways and an accessible roof. */
function buildFoundry(state: BuilderState): void {
  const originX = 17;
  const originZ = 16;
  const wallHeight = 4.5;
  const t = 0.6;
  const halfW = 8;
  const halfD = 6.5;

  const wall = (id: string, centre: Vec3, size: Vec3): void =>
    addBox(state, id, centre, size, 'structure');

  // South facade split by a central doorway (3 m wide).
  wall(
    'foundry-s-left',
    { x: originX - 5.5, y: wallHeight / 2, z: originZ - halfD },
    { x: 5, y: wallHeight, z: t },
  );
  wall(
    'foundry-s-right',
    { x: originX + 5.5, y: wallHeight / 2, z: originZ - halfD },
    { x: 5, y: wallHeight, z: t },
  );
  wall(
    'foundry-s-header',
    { x: originX, y: wallHeight - 0.5, z: originZ - halfD },
    { x: 6, y: 1, z: t },
  );

  // North facade is solid, west facade has a side entrance.
  wall(
    'foundry-n',
    { x: originX, y: wallHeight / 2, z: originZ + halfD },
    { x: halfW * 2, y: wallHeight, z: t },
  );
  wall(
    'foundry-w-back',
    { x: originX - halfW, y: wallHeight / 2, z: originZ + 3.75 },
    { x: t, y: wallHeight, z: 5.5 },
  );
  wall(
    'foundry-w-front',
    { x: originX - halfW, y: wallHeight / 2, z: originZ - 4.75 },
    { x: t, y: wallHeight, z: 3.5 },
  );
  wall(
    'foundry-w-header',
    { x: originX - halfW, y: wallHeight - 0.5, z: originZ - 0.5 },
    { x: t, y: 1, z: 8 },
  );
  wall(
    'foundry-e',
    { x: originX + halfW, y: wallHeight / 2, z: originZ },
    { x: t, y: wallHeight, z: halfD * 2 },
  );

  // Interior divider with an off-centre doorway.
  wall(
    'foundry-divider-a',
    { x: originX - 2, y: wallHeight / 2, z: originZ + 1.5 },
    { x: 12, y: wallHeight, z: t },
  );
  wall(
    'foundry-divider-b',
    { x: originX + 7, y: wallHeight / 2, z: originZ + 1.5 },
    { x: 2, y: wallHeight, z: t },
  );

  // Roof (walkable) and the external stairs that reach it.
  addBox(
    state,
    'foundry-roof',
    { x: originX, y: wallHeight + 0.25, z: originZ },
    { x: halfW * 2 + t, y: 0.5, z: halfD * 2 + t },
    'metal',
  );
  addRamp(state, 'foundry-stairs', {
    bottom: { x: originX + halfW + 4.5, y: 0, z: originZ - 3 },
    length: 9,
    width: 3.4,
    height: wallHeight + 0.5,
    axis: 'x',
    sign: -1,
    material: 'metal',
  });
  // Parapet so the roof offers cover rather than a clean firing line.
  addBox(
    state,
    'foundry-parapet-n',
    { x: originX, y: wallHeight + 1.1, z: originZ + halfD },
    { x: halfW * 2, y: 1.2, z: t },
    'accent',
  );
  addBox(
    state,
    'foundry-parapet-s',
    { x: originX, y: wallHeight + 1.1, z: originZ - halfD },
    { x: halfW * 2, y: 1.2, z: t },
    'accent',
  );

  // Interior cover.
  addBox(
    state,
    'foundry-crate-a',
    { x: originX - 4, y: 0.9, z: originZ - 3.5 },
    { x: 1.8, y: 1.8, z: 1.8 },
    'accentAlt',
  );
  addBox(
    state,
    'foundry-crate-b',
    { x: originX + 4, y: 0.75, z: originZ + 4 },
    { x: 2.4, y: 1.5, z: 2.4 },
    'accentAlt',
  );
}

/** South-west stacked watchtower: two open decks connected by ramps. */
function buildWatchtower(state: BuilderState): void {
  const cx = -17;
  const cz = -17;

  addBox(state, 'tower-deck-1', { x: cx, y: 1.5, z: cz }, { x: 11, y: 3, z: 11 }, 'platform');
  addBox(state, 'tower-deck-2', { x: cx - 1, y: 6.15, z: cz - 1 }, { x: 7, y: 0.7, z: 7 }, 'metal');
  addBox(
    state,
    'tower-column',
    { x: cx - 1, y: 4.5, z: cz - 1 },
    { x: 2, y: 3.4, z: 2 },
    'structure',
  );

  addRamp(state, 'tower-ramp-low', {
    bottom: { x: cx + 9, y: 0, z: cz + 3 },
    length: 6.5,
    width: 3.6,
    height: 3,
    axis: 'x',
    sign: -1,
  });
  addRamp(state, 'tower-ramp-high', {
    bottom: { x: cx + 4.5, y: 3, z: cz - 4 },
    length: 6,
    width: 3.2,
    height: 3.5,
    axis: 'x',
    sign: -1,
    material: 'metal',
  });

  // Railings double as cover on the upper deck.
  addBox(state, 'tower-rail-n', { x: cx - 1, y: 7, z: cz + 2.2 }, { x: 7, y: 1, z: 0.4 }, 'accent');
  addBox(state, 'tower-rail-w', { x: cx - 4.2, y: 7, z: cz - 1 }, { x: 0.4, y: 1, z: 7 }, 'accent');
  addBox(
    state,
    'tower-cover-a',
    { x: cx - 3.5, y: 3.75, z: cz + 3.5 },
    { x: 2, y: 1.5, z: 2 },
    'accentAlt',
  );
}

/** North-west open crate yard. */
function buildCrateYard(state: BuilderState): void {
  const crates: [number, number, number, number][] = [
    // x, z, size, height
    [-20, 18, 2.6, 2.6],
    [-16.5, 20.5, 2.2, 4.2],
    [-13, 16, 3, 1.6],
    [-21, 12.5, 2.4, 3.2],
    [-24, 20, 3.4, 2.2],
    [-10.5, 21, 2, 2],
    [-17, 14, 2.2, 1.4],
  ];
  crates.forEach(([x, z, size, height], index) => {
    addBox(
      state,
      `crate-${index}`,
      { x, y: height / 2, z },
      { x: size, y: height, z: size },
      index % 2 === 0 ? 'accentAlt' : 'structure',
    );
  });

  // Container that can be climbed via the neighbouring crates.
  addBox(state, 'yard-container', { x: -24, y: 1.6, z: 13 }, { x: 5, y: 3.2, z: 9 }, 'accent');
}

/** South-east walled bunker with two entrances and interior cover. */
function buildBunker(state: BuilderState): void {
  const cx = 17;
  const cz = -17;
  const h = 3.2;
  const t = 0.7;

  addBox(
    state,
    'bunker-n-left',
    { x: cx - 4.5, y: h / 2, z: cz + 6 },
    { x: 6, y: h, z: t },
    'structure',
  );
  addBox(
    state,
    'bunker-n-right',
    { x: cx + 4.5, y: h / 2, z: cz + 6 },
    { x: 6, y: h, z: t },
    'structure',
  );
  addBox(state, 'bunker-s', { x: cx, y: h / 2, z: cz - 6 }, { x: 15, y: h, z: t }, 'structure');
  addBox(state, 'bunker-e', { x: cx + 7.5, y: h / 2, z: cz }, { x: t, y: h, z: 12 }, 'structure');
  addBox(
    state,
    'bunker-w-a',
    { x: cx - 7.5, y: h / 2, z: cz + 3.5 },
    { x: t, y: h, z: 5 },
    'structure',
  );
  addBox(
    state,
    'bunker-w-b',
    { x: cx - 7.5, y: h / 2, z: cz - 3.5 },
    { x: t, y: h, z: 5 },
    'structure',
  );

  addBox(
    state,
    'bunker-cover-a',
    { x: cx - 2, y: 0.8, z: cz - 1 },
    { x: 3, y: 1.6, z: 3 },
    'accentAlt',
  );
  addBox(
    state,
    'bunker-cover-b',
    { x: cx + 4, y: 1.1, z: cz + 2 },
    { x: 2.2, y: 2.2, z: 2.2 },
    'accent',
  );
  addBox(
    state,
    'bunker-step',
    { x: cx + 5.5, y: 1.6, z: cz - 4 },
    { x: 3.4, y: 3.2, z: 3 },
    'platform',
  );
}

/** Mid-field blockers that break the long straight sightlines across the arena. */
function buildSightlineBreakers(state: BuilderState): void {
  addBox(state, 'breaker-n', { x: -2, y: 2, z: 23 }, { x: 10, y: 4, z: 1.6 }, 'accent');
  addBox(state, 'breaker-s', { x: 3, y: 2, z: -23 }, { x: 10, y: 4, z: 1.6 }, 'accent');
  addBox(state, 'breaker-e', { x: 24, y: 2, z: 2 }, { x: 1.6, y: 4, z: 10 }, 'accent');
  addBox(state, 'breaker-w', { x: -24, y: 2, z: -3 }, { x: 1.6, y: 4, z: 10 }, 'accent');

  addBox(state, 'low-cover-a', { x: 10, y: 0.7, z: 8 }, { x: 4, y: 1.4, z: 1.4 }, 'structure');
  addBox(state, 'low-cover-b', { x: -10, y: 0.7, z: -8 }, { x: 4, y: 1.4, z: 1.4 }, 'structure');
  addBox(state, 'low-cover-c', { x: -9, y: 0.7, z: 9 }, { x: 1.4, y: 1.4, z: 5 }, 'structure');
  addBox(state, 'low-cover-d', { x: 9, y: 0.7, z: -9 }, { x: 1.4, y: 1.4, z: 5 }, 'structure');
  addBox(state, 'pillar-nw', { x: -13, y: 2.5, z: 5 }, { x: 1.6, y: 5, z: 1.6 }, 'metal');
  addBox(state, 'pillar-se', { x: 13, y: 2.5, z: -5 }, { x: 1.6, y: 5, z: 1.6 }, 'metal');
}

const SPAWN_POINTS: SpawnPoint[] = [
  { position: { x: -26, y: 0.1, z: -4 }, yaw: Math.PI / 2 },
  { position: { x: 26, y: 0.1, z: 4 }, yaw: -Math.PI / 2 },
  { position: { x: -4, y: 0.1, z: 26 }, yaw: Math.PI },
  { position: { x: 4, y: 0.1, z: -26 }, yaw: 0 },
  { position: { x: -22, y: 0.1, z: 24 }, yaw: (Math.PI * 3) / 4 },
  // Clear of the Foundry's north facade (its wall spans z 22.2-22.8).
  { position: { x: 26, y: 0.1, z: 26 }, yaw: (-Math.PI * 3) / 4 },
  // On the watchtower's lower deck, clear of the column and its cover block.
  { position: { x: -21, y: 3.05, z: -18 }, yaw: Math.atan2(21, 18) },
  // Outside the bunker's south-east corner walls.
  { position: { x: 28, y: 0.1, z: -26 }, yaw: Math.atan2(-28, 26) },
  // On the core platform, south of the obelisk and facing the south ramp.
  { position: { x: 0, y: 3.05, z: -3 }, yaw: Math.PI },
  { position: { x: 17, y: 0.1, z: 12 }, yaw: (-Math.PI * 5) / 6 },
];

let cachedArena: ArenaDefinition | null = null;

/** Builds (and memoises) the arena definition. Safe to call from anywhere. */
export function getArena(): ArenaDefinition {
  if (cachedArena) return cachedArena;

  const state: BuilderState = { colliders: [], visuals: [] };
  buildPerimeter(state);
  buildCore(state);
  buildFoundry(state);
  buildWatchtower(state);
  buildCrateYard(state);
  buildBunker(state);
  buildSightlineBreakers(state);

  cachedArena = {
    name: 'Riftfront Yard',
    bounds: {
      min: { x: -HALF_EXTENT, y: -4, z: -HALF_EXTENT },
      max: { x: HALF_EXTENT, y: WALL_HEIGHT, z: HALF_EXTENT },
    },
    colliders: state.colliders,
    visuals: state.visuals,
    spawnPoints: SPAWN_POINTS,
    landmarks: [
      { name: 'Rift Core', position: { x: 0, y: 3, z: 0 } },
      { name: 'Foundry', position: { x: 17, y: 0, z: 16 } },
      { name: 'Watchtower', position: { x: -17, y: 0, z: -17 } },
      { name: 'Crate Yard', position: { x: -18, y: 0, z: 18 } },
      { name: 'Bunker', position: { x: 17, y: 0, z: -17 } },
    ],
  };

  return cachedArena;
}

/** Test hook: forces the next `getArena()` call to rebuild from scratch. */
export function resetArenaCache(): void {
  cachedArena = null;
}
