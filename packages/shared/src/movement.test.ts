import { describe, expect, it } from 'vitest';
import { ColliderIndex } from './collision.js';
import { FIXED_DT, JUMP_COOLDOWN_MS, SPRINT_SPEED, WALK_SPEED } from './constants.js';
import {
  INPUT_JUMP,
  INPUT_SPRINT,
  createMovementState,
  stepMovement,
  type InputCommand,
} from './movement.js';
import { getArena } from './arena.js';

const GROUND = new ColliderIndex([
  { id: 'ground', min: { x: -50, y: -1, z: -50 }, max: { x: 50, y: 0, z: 50 } },
]);

const command = (overrides: Partial<InputCommand> = {}): InputCommand => ({
  seq: 1,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
  ...overrides,
});

function run(
  index: ColliderIndex,
  steps: number,
  input: InputCommand,
  startY = 0.5,
): ReturnType<typeof createMovementState> {
  const state = createMovementState({ x: 0, y: startY, z: 0 });
  for (let i = 0; i < steps; i++) {
    stepMovement(state, { ...input, seq: i + 1 }, FIXED_DT, index);
  }
  return state;
}

describe('gravity and ground detection', () => {
  it('falls until it lands on the ground', () => {
    const state = run(GROUND, 60, command(), 5);
    expect(state.grounded).toBe(true);
    expect(state.position.y).toBeCloseTo(0, 2);
    expect(state.velocity.y).toBe(0);
  });

  it('does not sink through the floor over a long simulation', () => {
    const state = run(GROUND, 600, command());
    expect(state.position.y).toBeGreaterThanOrEqual(-0.001);
  });
});

describe('horizontal movement', () => {
  it('accelerates towards walk speed and stops there', () => {
    const state = run(GROUND, 120, command({ moveZ: 1 }));
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    expect(speed).toBeGreaterThan(WALK_SPEED * 0.95);
    expect(speed).toBeLessThanOrEqual(WALK_SPEED + 1e-6);
  });

  it('reaches sprint speed only while holding sprint and moving forward', () => {
    const sprinting = run(GROUND, 120, command({ moveZ: 1, buttons: INPUT_SPRINT }));
    const walking = run(GROUND, 120, command({ moveZ: 1 }));
    expect(Math.hypot(sprinting.velocity.x, sprinting.velocity.z)).toBeGreaterThan(
      Math.hypot(walking.velocity.x, walking.velocity.z),
    );
    expect(Math.hypot(sprinting.velocity.x, sprinting.velocity.z)).toBeLessThanOrEqual(
      SPRINT_SPEED + 1e-6,
    );
  });

  it('does not sprint while moving backwards', () => {
    const state = run(GROUND, 120, command({ moveZ: -1, buttons: INPUT_SPRINT }));
    expect(Math.hypot(state.velocity.x, state.velocity.z)).toBeLessThanOrEqual(WALK_SPEED + 1e-6);
  });

  it('does not exceed walk speed when moving diagonally', () => {
    const state = run(GROUND, 120, command({ moveX: 1, moveZ: 1 }));
    expect(Math.hypot(state.velocity.x, state.velocity.z)).toBeLessThanOrEqual(WALK_SPEED + 1e-6);
  });

  it('decelerates to a stop when input is released', () => {
    const state = createMovementState({ x: 0, y: 0.5, z: 0 });
    for (let i = 0; i < 120; i++) {
      stepMovement(state, command({ seq: i + 1, moveZ: 1 }), FIXED_DT, GROUND);
    }
    for (let i = 0; i < 120; i++) {
      stepMovement(state, command({ seq: 200 + i }), FIXED_DT, GROUND);
    }
    expect(Math.hypot(state.velocity.x, state.velocity.z)).toBeLessThan(0.1);
  });

  it('moves in the direction the player is facing', () => {
    const state = createMovementState({ x: 0, y: 0.5, z: 0 });
    for (let i = 0; i < 60; i++) {
      // Yaw of PI/2 faces +X.
      stepMovement(state, command({ seq: i + 1, moveZ: 1, yaw: Math.PI / 2 }), FIXED_DT, GROUND);
    }
    expect(state.position.x).toBeGreaterThan(1);
    expect(Math.abs(state.position.z)).toBeLessThan(0.2);
  });
});

describe('jumping', () => {
  it('leaves the ground when jump is pressed', () => {
    const state = createMovementState({ x: 0, y: 0.5, z: 0 });
    for (let i = 0; i < 30; i++) {
      stepMovement(state, command({ seq: i + 1 }), FIXED_DT, GROUND);
    }
    expect(state.grounded).toBe(true);
    stepMovement(state, command({ seq: 100, buttons: INPUT_JUMP }), FIXED_DT, GROUND);
    expect(state.velocity.y).toBeGreaterThan(0);
    expect(state.grounded).toBe(false);
  });

  it('cannot jump again mid-air (no infinite jumping)', () => {
    const state = createMovementState({ x: 0, y: 0.5, z: 0 });
    let maxHeight = 0;
    for (let i = 0; i < 240; i++) {
      // Jump is held for the entire simulation.
      stepMovement(state, command({ seq: i + 1, buttons: INPUT_JUMP }), FIXED_DT, GROUND);
      maxHeight = Math.max(maxHeight, state.position.y);
    }
    // A single jump apex is ~1.4 m; anything far above that means repeated boosts.
    expect(maxHeight).toBeLessThan(2);
  });

  it('enforces the jump cooldown between grounded jumps', () => {
    const state = createMovementState({ x: 0, y: 0.5, z: 0 });
    for (let i = 0; i < 30; i++) stepMovement(state, command({ seq: i + 1 }), FIXED_DT, GROUND);

    stepMovement(state, command({ seq: 100, buttons: INPUT_JUMP }), FIXED_DT, GROUND);
    const firstJumpTime = state.lastJumpAtMs;

    // Land again, then immediately try to jump before the cooldown elapses.
    for (let i = 0; i < 4; i++) {
      stepMovement(state, command({ seq: 200 + i, buttons: INPUT_JUMP }), FIXED_DT, GROUND);
    }
    expect(state.lastJumpAtMs).toBe(firstJumpTime);
    expect(state.timeMs - firstJumpTime).toBeLessThan(JUMP_COOLDOWN_MS);
  });
});

describe('collision', () => {
  const WITH_WALL = new ColliderIndex([
    { id: 'ground', min: { x: -50, y: -1, z: -50 }, max: { x: 50, y: 0, z: 50 } },
    { id: 'wall', min: { x: -5, y: 0, z: 3 }, max: { x: 5, y: 4, z: 4 } },
  ]);

  it('stops at a wall instead of passing through it', () => {
    const state = run(WITH_WALL, 200, command({ moveZ: 1 }));
    expect(state.position.z).toBeLessThan(3);
    expect(state.position.z).toBeGreaterThan(2);
  });

  it('walks up a step under the step height', () => {
    // The platform runs to the end of the ground so the player cannot walk off it.
    const withStep = new ColliderIndex([
      { id: 'ground', min: { x: -50, y: -1, z: -50 }, max: { x: 50, y: 0, z: 50 } },
      { id: 'step', min: { x: -5, y: 0, z: 3 }, max: { x: 5, y: 0.4, z: 50 } },
    ]);
    const state = run(withStep, 180, command({ moveZ: 1 }));
    expect(state.position.z).toBeGreaterThan(4);
    expect(state.position.y).toBeCloseTo(0.4, 1);
    expect(state.grounded).toBe(true);
  });

  it('climbs a staircase of steps, as the arena ramps are built', () => {
    const stairs = [{ id: 'ground', min: { x: -50, y: -1, z: -50 }, max: { x: 50, y: 0, z: 50 } }];
    for (let i = 0; i < 8; i++) {
      stairs.push({
        id: `stair-${i}`,
        min: { x: -5, y: -1, z: 3 + i * 1.2 },
        max: { x: 5, y: (i + 1) * 0.4, z: 50 },
      });
    }
    const state = run(new ColliderIndex(stairs), 240, command({ moveZ: 1 }));
    expect(state.position.y).toBeGreaterThan(2.5);
    expect(state.grounded).toBe(true);
  });

  it('does not climb a wall taller than the step height', () => {
    const withLedge = new ColliderIndex([
      { id: 'ground', min: { x: -50, y: -1, z: -50 }, max: { x: 50, y: 0, z: 50 } },
      { id: 'ledge', min: { x: -5, y: 0, z: 3 }, max: { x: 5, y: 1.2, z: 8 } },
    ]);
    const state = run(withLedge, 180, command({ moveZ: 1 }));
    expect(state.position.y).toBeLessThan(0.5);
    expect(state.position.z).toBeLessThan(3);
  });
});

describe('determinism', () => {
  it('produces bit-identical results for identical input sequences', () => {
    const index = new ColliderIndex(getArena().colliders);
    const inputs = Array.from({ length: 300 }, (_, i) =>
      command({
        seq: i + 1,
        moveX: Math.sin(i / 9),
        moveZ: Math.cos(i / 13),
        yaw: i / 40,
        buttons: i % 47 === 0 ? INPUT_JUMP : i % 3 === 0 ? INPUT_SPRINT : 0,
      }),
    );

    const simulate = (): { x: number; y: number; z: number } => {
      const state = createMovementState({ x: 0, y: 4, z: 0 });
      for (const input of inputs) stepMovement(state, input, FIXED_DT, index);
      return state.position;
    };

    expect(simulate()).toEqual(simulate());
  });

  it('keeps a player inside the arena walls', () => {
    const index = new ColliderIndex(getArena().colliders);
    const state = createMovementState({ x: 0, y: 4, z: 0 });
    for (let i = 0; i < 1200; i++) {
      stepMovement(
        state,
        command({ seq: i + 1, moveZ: 1, yaw: i / 200, buttons: INPUT_SPRINT }),
        FIXED_DT,
        index,
      );
    }
    expect(Math.abs(state.position.x)).toBeLessThan(33);
    expect(Math.abs(state.position.z)).toBeLessThan(33);
    expect(state.position.y).toBeGreaterThan(-1);
  });
});
