import { describe, expect, it } from 'vitest';
import { getArena, resetArenaCache } from './arena.js';
import { ColliderIndex, aabbOverlaps } from './collision.js';
import { FIXED_DT, PLAYER_RADIUS, STEP_HEIGHT } from './constants.js';
import { createMovementState, playerAABB, stepMovement, type InputCommand } from './movement.js';

const arena = getArena();
const index = new ColliderIndex(arena.colliders);

const idle = (seq: number): InputCommand => ({
  seq,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
});

describe('arena definition', () => {
  it('is memoised but rebuildable', () => {
    expect(getArena()).toBe(arena);
    resetArenaCache();
    const rebuilt = getArena();
    expect(rebuilt).not.toBe(arena);
    expect(rebuilt.colliders.length).toBe(arena.colliders.length);
  });

  it('produces colliders with well-formed bounds', () => {
    for (const collider of arena.colliders) {
      expect(collider.max.x).toBeGreaterThan(collider.min.x);
      expect(collider.max.y).toBeGreaterThan(collider.min.y);
      expect(collider.max.z).toBeGreaterThan(collider.min.z);
    }
  });

  it('gives every collider a unique id', () => {
    const ids = new Set(arena.colliders.map((collider) => collider.id));
    expect(ids.size).toBe(arena.colliders.length);
  });

  it('defines enough spawn points for a full lobby', () => {
    expect(arena.spawnPoints.length).toBeGreaterThanOrEqual(8);
  });

  it('names distinct landmarks for orientation', () => {
    expect(arena.landmarks.length).toBeGreaterThanOrEqual(4);
  });
});

describe('spawn points', () => {
  // This is the regression test for a spawn placed inside the central obelisk, which
  // trapped that player for the whole match.
  it('never place a player inside geometry', () => {
    for (const spawn of arena.spawnPoints) {
      const box = playerAABB(spawn.position);
      const candidates = index.query(box.min, box.max);
      const blocking = candidates.filter((collider) => aabbOverlaps(box, collider));
      expect(
        blocking.map((collider) => collider.id),
        `spawn at ${JSON.stringify(spawn.position)} overlaps geometry`,
      ).toEqual([]);
    }
  });

  it('settle onto solid ground within a short fall', () => {
    for (const spawn of arena.spawnPoints) {
      const state = createMovementState(spawn.position);
      for (let i = 0; i < 180 && !state.grounded; i++) {
        stepMovement(state, idle(i + 1), FIXED_DT, index);
      }
      expect(state.grounded, `spawn at ${JSON.stringify(spawn.position)} never landed`).toBe(true);
      // A spawn should not drop the player from a great height.
      expect(spawn.position.y - state.position.y).toBeLessThan(6);
    }
  });

  it('sit inside the arena bounds', () => {
    for (const spawn of arena.spawnPoints) {
      expect(Math.abs(spawn.position.x)).toBeLessThan(32 - PLAYER_RADIUS);
      expect(Math.abs(spawn.position.z)).toBeLessThan(32 - PLAYER_RADIUS);
    }
  });

  it('are spread out rather than clustered', () => {
    let closest = Infinity;
    for (let i = 0; i < arena.spawnPoints.length; i++) {
      for (let j = i + 1; j < arena.spawnPoints.length; j++) {
        const a = arena.spawnPoints[i].position;
        const b = arena.spawnPoints[j].position;
        closest = Math.min(closest, Math.hypot(a.x - b.x, a.z - b.z));
      }
    }
    expect(closest).toBeGreaterThan(6);
  });
});

describe('ramps', () => {
  it('build staircases whose individual rise is walkable', () => {
    const stepColliders = arena.colliders.filter((collider) => collider.id.includes('-step-'));
    expect(stepColliders.length).toBeGreaterThan(0);

    // Group by ramp and confirm consecutive steps never exceed the controller's reach.
    const byRamp = new Map<string, number[]>();
    for (const collider of stepColliders) {
      const rampId = collider.id.slice(0, collider.id.indexOf('-step-'));
      const heights = byRamp.get(rampId) ?? [];
      heights.push(collider.max.y);
      byRamp.set(rampId, heights);
    }

    for (const [rampId, heights] of byRamp) {
      heights.sort((a, b) => a - b);
      for (let i = 1; i < heights.length; i++) {
        expect(
          heights[i] - heights[i - 1],
          `ramp ${rampId} has an unclimbable step`,
        ).toBeLessThanOrEqual(STEP_HEIGHT + 1e-6);
      }
    }
  });

  it('lets a player walk from the ground up onto the core platform', () => {
    // Start south of the core ramp and walk north (+Z) onto the platform.
    const state = createMovementState({ x: 0, y: 0.2, z: -16 });
    for (let i = 0; i < 400; i++) {
      stepMovement(
        state,
        { seq: i + 1, moveX: 0, moveZ: 1, yaw: 0, pitch: 0, buttons: 0 },
        FIXED_DT,
        index,
      );
    }
    expect(state.position.z).toBeGreaterThan(-7);
    expect(state.position.y).toBeGreaterThan(2.5);
  });
});

describe('collider index', () => {
  it('finds the ground below an open part of the arena', () => {
    // Below the invisible ceiling, which caps the playable volume at wall height.
    const hit = index.raycast({ x: 0, y: 8, z: 20 }, { x: 0, y: -1, z: 0 }, 60);
    expect(hit).not.toBeNull();
    expect(hit?.point.y).toBeCloseTo(0, 3);
  });

  it('reports no hit when the ray misses everything', () => {
    const hit = index.raycast({ x: 0, y: 200, z: 0 }, { x: 0, y: 1, z: 0 }, 50);
    expect(hit).toBeNull();
  });

  it('caps the playable volume with a ceiling above the walls', () => {
    const hit = index.raycast({ x: 0, y: 5, z: 20 }, { x: 0, y: 1, z: 0 }, 30);
    expect(hit?.colliderId).toBe('ceiling');
  });

  it('is blocked by the outer wall', () => {
    const hit = index.raycast({ x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: 1 }, 200);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeLessThanOrEqual(34);
  });
});
