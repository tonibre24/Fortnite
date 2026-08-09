import { describe, expect, it } from 'vitest';
import {
  ColliderIndex,
  GRAVITY,
  arenaCollisionHash,
  JUMP_VELOCITY,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  STEP_HEIGHT,
  getArena,
  playerAABB,
  type BoxCollider,
  type Vec3,
} from '@riftfront/shared';
import {
  ARENA_OUTER_HALF_EXTENT,
  CLUTTER_HEIGHT,
  TERRAIN_INNER_HALF_EXTENT,
  FLUSH_THICKNESS,
  PROP_SPECS,
  PROUD_TOLERANCE,
  buildDecorPlan,
  sampleTerrainHeight,
  type DecorBox,
} from './decorPlan.js';

/**
 * The decoration contract, enforced mechanically.
 *
 * Two properties matter and neither is safe to take on trust:
 *
 *  1. **The plan is deterministic.** Two clients must generate the same world, and the
 *     plan must never touch the shared arena — the server simulates against that.
 *  2. **No decoration lies about collision.** A player must never be able to walk through
 *     something that looks solid, or be blocked by something that is not there. Rather
 *     than eyeballing it, the reachability test below reconstructs where a player can
 *     actually stand (and how high they can jump from there) and proves that nothing
 *     classified `overhead` intersects that volume.
 *
 * These tests import no rendering code, so they run headless with the rest of the suite.
 */

const arena = getArena();
const index = new ColliderIndex(arena.colliders);
const plan = buildDecorPlan(arena);

/** Peak of a jump from a standing start: v^2 / 2g. */
const JUMP_APEX = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY);
/** Everything a player's body can occupy above a surface they can stand on. */
const REACH_ABOVE_FLOOR = JUMP_APEX + PLAYER_HEIGHT;

interface Box {
  min: Vec3;
  max: Vec3;
}

function boxOf(decor: DecorBox): Box {
  return {
    min: {
      x: decor.centre.x - decor.size.x / 2,
      y: decor.centre.y - decor.size.y / 2,
      z: decor.centre.z - decor.size.z / 2,
    },
    max: {
      x: decor.centre.x + decor.size.x / 2,
      y: decor.centre.y + decor.size.y / 2,
      z: decor.centre.z + decor.size.z / 2,
    },
  };
}

function intersects(a: Box, b: Box): boolean {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y &&
    a.min.z < b.max.z &&
    a.max.z > b.min.z
  );
}

/**
 * Every height a player can stand at over one XZ point.
 *
 * A surface counts as standable when some collider's top face sits under the player's
 * footprint and the body placed on it is clear of everything else. "Clear" starts a step
 * height above the surface, mirroring the controller, which walks up anything shorter
 * than `STEP_HEIGHT` — without that, no staircase in the arena would register as
 * standable, because the capsule always clips the next tread.
 */
function standableHeights(x: number, z: number): number[] {
  const footMin: Vec3 = { x: x - PLAYER_RADIUS, y: -5, z: z - PLAYER_RADIUS };
  const footMax: Vec3 = { x: x + PLAYER_RADIUS, y: 30, z: z + PLAYER_RADIUS };
  const candidates = index.query(footMin, footMax);

  const tops = new Set<number>();
  for (const collider of candidates) {
    if (
      collider.max.x <= footMin.x ||
      collider.min.x >= footMax.x ||
      collider.max.z <= footMin.z ||
      collider.min.z >= footMax.z
    ) {
      continue;
    }
    tops.add(collider.max.y);
  }

  const standable: number[] = [];
  for (const top of tops) {
    const body = playerAABB({ x, y: top, z });
    body.min.y = top + STEP_HEIGHT;
    const blocking = index
      .query(body.min, body.max)
      .some((collider: BoxCollider) => intersects(body, collider));
    if (!blocking) standable.push(top);
  }
  return standable.sort((a, b) => a - b);
}

/**
 * Where a player can actually *get to*.
 *
 * Enumerating standable surfaces is not enough on its own: the tops of the perimeter
 * walls are perfectly standable in isolation, but the arena's invisible ceiling means no
 * player can ever climb onto one. So the reachable set is flood-filled outwards from the
 * spawn points, stepping between adjacent surfaces only where a player could climb (up to
 * a jump apex plus a step) or fall (any distance).
 *
 * The fill is deliberately optimistic — it ignores head clearance while jumping and lets
 * players cross any gap one cell wide — because over-reporting reachable space can only
 * make the decoration contract stricter.
 */
const REACH_CELL = 0.6;
const REACH_MIN = -34;
const REACH_CELLS = Math.ceil((34 - REACH_MIN) / REACH_CELL) + 1;
/** How far up a player can move between neighbouring surfaces. */
const CLIMB_LIMIT = JUMP_APEX + STEP_HEIGHT;

const cellCentre = (i: number): number => REACH_MIN + i * REACH_CELL;
const cellIndex = (world: number): number => Math.round((world - REACH_MIN) / REACH_CELL);

const heightCache = new Map<number, number[]>();
function heightsAt(ix: number, iz: number): number[] {
  const key = iz * REACH_CELLS + ix;
  let cached = heightCache.get(key);
  if (cached === undefined) {
    cached = standableHeights(cellCentre(ix), cellCentre(iz));
    heightCache.set(key, cached);
  }
  return cached;
}

/** `${cellKey}:${heightIndex}` for every surface a player can reach. */
const reachable = new Set<string>();

function floodFillReachable(): void {
  const queue: [number, number, number][] = [];
  const push = (ix: number, iz: number, heightIdx: number): void => {
    if (ix < 0 || iz < 0 || ix >= REACH_CELLS || iz >= REACH_CELLS) return;
    const key = `${iz * REACH_CELLS + ix}:${heightIdx}`;
    if (reachable.has(key)) return;
    reachable.add(key);
    queue.push([ix, iz, heightIdx]);
  };

  // Seed from the spawn points, the only places the server ever puts a player.
  for (const spawn of arena.spawnPoints) {
    const ix = cellIndex(spawn.position.x);
    const iz = cellIndex(spawn.position.z);
    const heights = heightsAt(ix, iz);
    let best = -1;
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] <= spawn.position.y + 0.5) best = i;
    }
    if (best >= 0) push(ix, iz, best);
  }

  const neighbours: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (queue.length > 0) {
    const [ix, iz, heightIdx] = queue.pop()!;
    const height = heightsAt(ix, iz)[heightIdx];
    for (const [dx, dz] of neighbours) {
      const nx = ix + dx;
      const nz = iz + dz;
      if (nx < 0 || nz < 0 || nx >= REACH_CELLS || nz >= REACH_CELLS) continue;
      const candidates = heightsAt(nx, nz);
      for (let i = 0; i < candidates.length; i++) {
        if (candidates[i] - height <= CLIMB_LIMIT) push(nx, nz, i);
      }
    }
  }
}

floodFillReachable();

/** True when a player could put any part of their body inside `box`. */
function playerCanReach(box: Box): boolean {
  const fromX = Math.max(0, cellIndex(box.min.x - PLAYER_RADIUS) - 1);
  const toX = Math.min(REACH_CELLS - 1, cellIndex(box.max.x + PLAYER_RADIUS) + 1);
  const fromZ = Math.max(0, cellIndex(box.min.z - PLAYER_RADIUS) - 1);
  const toZ = Math.min(REACH_CELLS - 1, cellIndex(box.max.z + PLAYER_RADIUS) + 1);

  for (let ix = fromX; ix <= toX; ix++) {
    for (let iz = fromZ; iz <= toZ; iz++) {
      const heights = heightsAt(ix, iz);
      for (let i = 0; i < heights.length; i++) {
        if (!reachable.has(`${iz * REACH_CELLS + ix}:${i}`)) continue;
        const floor = heights[i];
        if (floor >= box.max.y || floor + REACH_ABOVE_FLOOR <= box.min.y) continue;

        const capsule = playerAABB({ x: cellCentre(ix), y: floor, z: cellCentre(iz) });
        if (
          capsule.min.x < box.max.x &&
          capsule.max.x > box.min.x &&
          capsule.min.z < box.max.z &&
          capsule.max.z > box.min.z
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

describe('decoration plan', () => {
  it('is deterministic for a given arena', () => {
    const again = buildDecorPlan(arena);
    expect(again.seed).toBe(plan.seed);
    expect(again.boxes.length).toBe(plan.boxes.length);
    expect(again.props.length).toBe(plan.props.length);
    expect(JSON.stringify(again.boxes)).toBe(JSON.stringify(plan.boxes));
    expect(JSON.stringify(again.props)).toBe(JSON.stringify(plan.props));
    expect(Array.from(again.ground.colours)).toEqual(Array.from(plan.ground.colours));
    expect(Array.from(again.terrain.heights)).toEqual(Array.from(plan.terrain.heights));
  });

  it('never mutates the shared arena', () => {
    const before = arena.colliders.length;
    const visualsBefore = arena.visuals.length;
    buildDecorPlan(arena);
    expect(arena.colliders.length).toBe(before);
    expect(arena.visuals.length).toBe(visualsBefore);
  });

  // The constraint that matters most: decoration is additive and client-side, so the
  // collision fingerprint the server simulates against must be untouched by all of it.
  it('leaves the collision fingerprint untouched', () => {
    const before = arenaCollisionHash(arena);
    buildDecorPlan(arena);
    expect(arenaCollisionHash(arena)).toBe(before);
  });

  it('produces enough detail to be worth having', () => {
    expect(plan.boxes.length).toBeGreaterThan(60);
    expect(plan.props.length).toBeGreaterThan(400);
    expect(new Set(plan.props.map((prop) => prop.kind)).size).toBeGreaterThanOrEqual(6);
  });

  it('gives every decoration box a unique id', () => {
    const ids = new Set(plan.boxes.map((box) => box.id));
    expect(ids.size).toBe(plan.boxes.length);
  });
});

describe('clearance contract', () => {
  const byId = new Map<string, BoxCollider>(
    arena.colliders.map((collider) => [collider.id, collider]),
  );

  it('keeps embedded trim inside its host collider', () => {
    const embedded = plan.boxes.filter((box) => box.clearance === 'embedded');
    expect(embedded.length).toBeGreaterThan(40);

    for (const decor of embedded) {
      const host = decor.hostColliderId ? byId.get(decor.hostColliderId) : undefined;
      expect(host, `${decor.id} names a collider that does not exist`).toBeDefined();
      if (!host) continue;

      const box = boxOf(decor);
      for (const axis of ['x', 'y', 'z'] as const) {
        const overLow = host.min[axis] - box.min[axis];
        const overHigh = box.max[axis] - host.max[axis];
        expect(
          Math.max(overLow, overHigh),
          `${decor.id} protrudes from ${host.id} on ${axis}`,
        ).toBeLessThanOrEqual(PROUD_TOLERANCE + 1e-6);
      }
    }
  });

  it('keeps floor inlays flush', () => {
    for (const decor of plan.boxes.filter((box) => box.clearance === 'flush')) {
      expect(decor.size.y, `${decor.id} is too thick to be flush`).toBeLessThanOrEqual(
        FLUSH_THICKNESS + 1e-6,
      );
      const box = boxOf(decor);
      expect(box.min.y, `${decor.id} floats above its surface`).toBeCloseTo(decor.restingY ?? 0, 5);
    }
  });

  it('keeps clutter under the controller step height', () => {
    for (const decor of plan.boxes.filter((box) => box.clearance === 'clutter')) {
      const box = boxOf(decor);
      const resting = decor.restingY ?? 0;
      expect(box.min.y, `${decor.id} floats above its surface`).toBeCloseTo(resting, 5);
      expect(
        box.max.y - resting,
        `${decor.id} is tall enough to be mistaken for cover`,
      ).toBeLessThanOrEqual(CLUTTER_HEIGHT + 1e-6);
    }
  });

  it('keeps outside decoration beyond the perimeter walls', () => {
    for (const decor of plan.boxes.filter((box) => box.clearance === 'outside')) {
      const box = boxOf(decor);
      const clear =
        box.min.x >= ARENA_OUTER_HALF_EXTENT ||
        box.max.x <= -ARENA_OUTER_HALF_EXTENT ||
        box.min.z >= ARENA_OUTER_HALF_EXTENT ||
        box.max.z <= -ARENA_OUTER_HALF_EXTENT;
      expect(clear, `${decor.id} reaches inside the arena`).toBe(true);
    }
  });

  it('proves no player can reach overhead decoration', () => {
    const overhead = plan.boxes.filter((box) => box.clearance === 'overhead');
    expect(overhead.length).toBeGreaterThan(0);

    for (const decor of overhead) {
      expect(playerCanReach(boxOf(decor)), `${decor.id} is reachable by a player`).toBe(false);
    }
  });

  // The reachability model is only trustworthy if it says "yes" to places a player
  // demonstrably stands, so both directions are pinned here.
  it('reachability model finds the open arena floor', () => {
    expect(playerCanReach({ min: { x: -1, y: 0.5, z: -20 }, max: { x: 1, y: 1.5, z: -18 } })).toBe(
      true,
    );
  });

  it('reachability model finds the raised core platform', () => {
    // Reached by the two ramps, so the fill has to traverse a staircase to get here.
    expect(playerCanReach({ min: { x: -2, y: 3.2, z: -2 }, max: { x: 2, y: 4, z: 2 } })).toBe(true);
  });

  it('reachability model finds the watchtower upper deck', () => {
    expect(
      playerCanReach({ min: { x: -20, y: 6.7, z: -20 }, max: { x: -17, y: 7.4, z: -17 } }),
    ).toBe(true);
  });

  it('reachability model rejects the space above the arena ceiling', () => {
    expect(playerCanReach({ min: { x: -2, y: 11, z: -2 }, max: { x: 2, y: 12, z: 2 } })).toBe(
      false,
    );
  });
});

describe('props', () => {
  it('keeps arena clutter within the step height and inside the walls', () => {
    const clutter = plan.props.filter((prop) => prop.clearance === 'clutter');
    expect(clutter.length).toBeGreaterThan(100);

    for (const prop of clutter) {
      const height = PROP_SPECS[prop.kind].height * prop.scale;
      expect(height, `${prop.kind} clutter is too tall`).toBeLessThanOrEqual(CLUTTER_HEIGHT + 1e-6);
      expect(Math.abs(prop.position.x)).toBeLessThan(32);
      expect(Math.abs(prop.position.z)).toBeLessThan(32);
    }
  });

  it('never grows clutter out of solid geometry', () => {
    for (const prop of plan.props.filter((entry) => entry.clearance === 'clutter')) {
      const height = PROP_SPECS[prop.kind].height * prop.scale;
      const footprint: Box = {
        min: { x: prop.position.x - 0.3, y: prop.position.y + 0.03, z: prop.position.z - 0.3 },
        max: {
          x: prop.position.x + 0.3,
          y: prop.position.y + height,
          z: prop.position.z + 0.3,
        },
      };
      const inside = index
        .query(footprint.min, footprint.max)
        .some((collider) => intersects(footprint, collider));
      expect(
        inside,
        `a ${prop.kind} at ${prop.position.x},${prop.position.z} is inside geometry`,
      ).toBe(false);
    }
  });

  it('keeps the outer landscape outside the arena', () => {
    const outside = plan.props.filter((prop) => prop.clearance === 'outside');
    expect(outside.length).toBeGreaterThan(300);

    for (const prop of outside) {
      const clear =
        Math.abs(prop.position.x) > ARENA_OUTER_HALF_EXTENT ||
        Math.abs(prop.position.z) > ARENA_OUTER_HALF_EXTENT;
      expect(clear, `a ${prop.kind} landed inside the arena`).toBe(true);
    }
  });

  it('seats outdoor props on the terrain surface', () => {
    for (const prop of plan.props.filter((entry) => entry.clearance === 'outside')) {
      const surface = sampleTerrainHeight(plan.terrain, prop.position.x, prop.position.z);
      expect(prop.position.y).toBeCloseTo(surface, 4);
    }
  });

  it('varies the tint of every instance', () => {
    const distinct = new Set(
      plan.props.map((prop) => `${prop.tint.r.toFixed(4)}:${prop.tint.b.toFixed(4)}`),
    );
    // A tiled-looking field is the failure mode; near-unique tints are the fix.
    expect(distinct.size).toBeGreaterThan(plan.props.length * 0.9);
  });
});

describe('terrain', () => {
  it('meets the arena floor at exactly zero', () => {
    for (const [x, z] of [
      [TERRAIN_INNER_HALF_EXTENT, 0],
      [-TERRAIN_INNER_HALF_EXTENT, 12],
      [0, TERRAIN_INNER_HALF_EXTENT],
      [20, -TERRAIN_INNER_HALF_EXTENT],
    ]) {
      expect(Math.abs(sampleTerrainHeight(plan.terrain, x, z))).toBeLessThan(1e-6);
    }
  });

  it('punches out the arena footprint so the two surfaces never z-fight', () => {
    const { cells, cellSize, originX, originZ, mask } = plan.terrain;
    for (let cz = 0; cz < cells; cz++) {
      for (let cx = 0; cx < cells; cx++) {
        if (mask[cz * cells + cx] === 0) continue;
        const minX = originX + cx * cellSize;
        const minZ = originZ + cz * cellSize;
        const insideArena =
          minX >= -TERRAIN_INNER_HALF_EXTENT &&
          minX + cellSize <= TERRAIN_INNER_HALF_EXTENT &&
          minZ >= -TERRAIN_INNER_HALF_EXTENT &&
          minZ + cellSize <= TERRAIN_INNER_HALF_EXTENT;
        expect(insideArena).toBe(false);
      }
    }
  });

  it('rises into hills further out', () => {
    let peak = 0;
    for (const height of plan.terrain.heights) peak = Math.max(peak, Math.abs(height));
    expect(peak).toBeGreaterThan(4);
  });
});
