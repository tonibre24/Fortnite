import { describe, expect, it } from 'vitest';
import {
  AIM_SPEED_MULTIPLIER,
  Button,
  CollisionWorld,
  GRAVITY,
  GROUND_Y,
  JUMP_VELOCITY,
  MAP_HALF,
  PLAYER_HEIGHT,
  SPRINT_SPEED,
  STEP_HEIGHT,
  StateFlag,
  TICK_DT,
  WALK_SPEED,
  box,
  clonePlayerState,
  createPlayerState,
  f32,
  generateMap,
  quantizeYaw,
  stepMovement,
  type InputCommand,
  type PlayerState,
} from '@br/shared';

const FLAT_GROUND = new CollisionWorld([box(-500, -2, -500, 500, GROUND_Y, 500, 0)]);

function cmd(seq: number, buttons: number, yaw = 0): InputCommand {
  return { seq, buttons, yawQ: quantizeYaw(yaw), pitchQ: 0, renderTick: 0, slot: 0 };
}

function spawn(x = 0, y = 0, z = 0): PlayerState {
  const state = createPlayerState(1);
  state.pos.x = x;
  state.pos.y = y;
  state.pos.z = z;
  return state;
}

function run(state: PlayerState, world: CollisionWorld, ticks: number, buttons: number, yaw = 0): void {
  for (let i = 0; i < ticks; i++) stepMovement(state, cmd(i + 1, buttons, yaw), world, TICK_DT);
}

describe('stepMovement', () => {
  it('settles on the ground and stays there', () => {
    const state = spawn(0, 5);
    run(state, FLAT_GROUND, 60, 0);
    expect(state.pos.y).toBeGreaterThanOrEqual(GROUND_Y);
    expect(state.pos.y).toBeLessThan(GROUND_Y + 0.01);
    expect(state.flags & StateFlag.OnGround).toBeTruthy();
    expect(state.vel.y).toBe(0);
  });

  it('keeps every stored value exactly representable as float32', () => {
    const state = spawn(123.456, 7.89, -45.6);
    for (let i = 0; i < 40; i++) {
      stepMovement(state, cmd(i + 1, Button.Forward | Button.Jump, 0.7), FLAT_GROUND, TICK_DT);
      expect(state.pos.x).toBe(f32(state.pos.x));
      expect(state.pos.y).toBe(f32(state.pos.y));
      expect(state.pos.z).toBe(f32(state.pos.z));
      expect(state.vel.x).toBe(f32(state.vel.x));
      expect(state.vel.y).toBe(f32(state.vel.y));
      expect(state.vel.z).toBe(f32(state.vel.z));
    }
  });

  it('reproduces the same trajectory bit-for-bit from the same inputs', () => {
    const commands = Array.from({ length: 120 }, (_, i) =>
      cmd(i + 1, i % 3 === 0 ? Button.Forward | Button.Sprint : Button.Forward | Button.Right, i * 0.05),
    );
    const a = spawn(3, 2, -7);
    const b = spawn(3, 2, -7);
    for (const c of commands) {
      stepMovement(a, c, FLAT_GROUND, TICK_DT);
      stepMovement(b, c, FLAT_GROUND, TICK_DT);
    }
    expect(a).toEqual(b);
  });

  it('splitting a command sequence in half changes nothing', () => {
    const commands = Array.from({ length: 60 }, (_, i) => cmd(i + 1, Button.Forward | Button.Left, i * 0.11));
    const whole = spawn();
    for (const c of commands) stepMovement(whole, c, FLAT_GROUND, TICK_DT);

    // Same sequence, but paused and resumed from a copied state - exactly what
    // reconciliation does when it replays unacknowledged input.
    let split = spawn();
    for (const c of commands.slice(0, 25)) stepMovement(split, c, FLAT_GROUND, TICK_DT);
    split = clonePlayerState(split);
    for (const c of commands.slice(25)) stepMovement(split, c, FLAT_GROUND, TICK_DT);

    expect(split).toEqual(whole);
  });

  it('walks at the walk speed and sprints at the sprint speed', () => {
    const walker = spawn();
    run(walker, FLAT_GROUND, 60, Button.Forward);
    const walkSpeed = Math.hypot(walker.vel.x, walker.vel.z);
    expect(walkSpeed).toBeGreaterThan(WALK_SPEED - 0.35);
    expect(walkSpeed).toBeLessThanOrEqual(WALK_SPEED + 0.01);

    const sprinter = spawn();
    run(sprinter, FLAT_GROUND, 60, Button.Forward | Button.Sprint);
    const sprintSpeed = Math.hypot(sprinter.vel.x, sprinter.vel.z);
    expect(sprintSpeed).toBeGreaterThan(SPRINT_SPEED - 0.35);
    expect(sprintSpeed).toBeLessThanOrEqual(SPRINT_SPEED + 0.01);
  });

  /**
   * Aiming has to slow the player identically on client prediction and server
   * authority, because it is the same stepMovement on both sides - there is no
   * separate "aim slowdown" implementation to keep in sync.
   */
  it('slows to AIM_SPEED_MULTIPLIER of walk speed while aiming', () => {
    const aimer = spawn();
    run(aimer, FLAT_GROUND, 60, Button.Forward | Button.Aim);
    const aimSpeed = Math.hypot(aimer.vel.x, aimer.vel.z);
    const expected = WALK_SPEED * AIM_SPEED_MULTIPLIER;
    expect(aimSpeed).toBeGreaterThan(expected - 0.35);
    expect(aimSpeed).toBeLessThanOrEqual(expected + 0.01);
  });

  it('lets aiming override sprint rather than combining with it', () => {
    const aimer = spawn();
    run(aimer, FLAT_GROUND, 60, Button.Forward | Button.Sprint | Button.Aim);
    const aimSpeed = Math.hypot(aimer.vel.x, aimer.vel.z);
    const expected = WALK_SPEED * AIM_SPEED_MULTIPLIER;
    expect(aimSpeed).toBeLessThan(SPRINT_SPEED * AIM_SPEED_MULTIPLIER - 0.01);
    expect(aimSpeed).toBeGreaterThan(expected - 0.35);
    expect(aimSpeed).toBeLessThanOrEqual(expected + 0.01);
  });

  it('sets StateFlag.Aiming while the button is held and clears it once released', () => {
    const state = spawn();
    stepMovement(state, cmd(1, Button.Forward | Button.Aim), FLAT_GROUND, TICK_DT);
    expect(state.flags & StateFlag.Aiming).toBeTruthy();
    stepMovement(state, cmd(2, Button.Forward), FLAT_GROUND, TICK_DT);
    expect(state.flags & StateFlag.Aiming).toBeFalsy();
  });

  it('does not let diagonal input move faster than straight input', () => {
    const straight = spawn();
    run(straight, FLAT_GROUND, 80, Button.Forward);
    const diagonal = spawn();
    run(diagonal, FLAT_GROUND, 80, Button.Forward | Button.Right);

    const straightSpeed = Math.hypot(straight.vel.x, straight.vel.z);
    const diagonalSpeed = Math.hypot(diagonal.vel.x, diagonal.vel.z);
    expect(diagonalSpeed).toBeLessThanOrEqual(straightSpeed + 1e-4);
  });

  it('moves in the direction the player is facing', () => {
    const north = spawn();
    run(north, FLAT_GROUND, 20, Button.Forward, 0);
    // Yaw 0 looks down -Z.
    expect(north.pos.z).toBeLessThan(-0.5);
    expect(Math.abs(north.pos.x)).toBeLessThan(1e-3);

    const west = spawn();
    run(west, FLAT_GROUND, 20, Button.Forward, Math.PI / 2);
    expect(west.pos.x).toBeLessThan(-0.5);
    expect(Math.abs(west.pos.z)).toBeLessThan(1e-3);
  });

  it('jumps roughly to the height the constants predict', () => {
    const state = spawn();
    run(state, FLAT_GROUND, 5, 0);
    let peak = state.pos.y;
    for (let i = 0; i < 40; i++) {
      stepMovement(state, cmd(100 + i, Button.Jump), FLAT_GROUND, TICK_DT);
      peak = Math.max(peak, state.pos.y);
    }
    const expected = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY);
    expect(peak).toBeGreaterThan(expected * 0.75);
    expect(peak).toBeLessThan(expected * 1.15);
  });

  it('does not bunny-hop while the jump key is simply held down', () => {
    const state = spawn();
    run(state, FLAT_GROUND, 5, 0);
    // Hold jump continuously; it should fire once, land, and stay landed.
    run(state, FLAT_GROUND, 60, Button.Jump);
    expect(state.flags & StateFlag.OnGround).toBeTruthy();
    expect(state.pos.y).toBeLessThan(GROUND_Y + 0.01);
  });

  it('jumps again once the key is released and pressed', () => {
    const state = spawn();
    run(state, FLAT_GROUND, 5, 0);
    run(state, FLAT_GROUND, 40, Button.Jump);
    run(state, FLAT_GROUND, 3, 0);
    stepMovement(state, cmd(500, Button.Jump), FLAT_GROUND, TICK_DT);
    expect(state.vel.y).toBeGreaterThan(0);
  });
});

describe('collision', () => {
  const withWall = new CollisionWorld([
    box(-500, -2, -500, 500, GROUND_Y, 500, 0),
    box(-10, GROUND_Y, -6, 10, GROUND_Y + 4, -5, 0),
  ]);

  it('stops the player at a wall instead of passing through it', () => {
    const state = spawn(0, 0, 0);
    run(state, withWall, 80, Button.Forward | Button.Sprint, 0);
    expect(state.pos.z).toBeGreaterThan(-5);
    expect(state.pos.z).toBeLessThan(-4.5);
  });

  it('slides along a wall rather than sticking to it', () => {
    const state = spawn(0, 0, -4.6);
    run(state, withWall, 40, Button.Forward | Button.Right, 0);
    expect(state.pos.x).toBeGreaterThan(1);
    expect(state.pos.z).toBeGreaterThan(-5);
  });

  it('steps up onto a low ledge', () => {
    const ledge = new CollisionWorld([
      box(-500, -2, -500, 500, GROUND_Y, 500, 0),
      box(-10, GROUND_Y, -20, 10, GROUND_Y + STEP_HEIGHT - 0.05, -5, 0),
    ]);
    const state = spawn(0, 0, 0);
    run(state, ledge, 40, Button.Forward, 0);
    expect(state.pos.z).toBeLessThan(-5);
    expect(state.pos.y).toBeGreaterThan(GROUND_Y + STEP_HEIGHT - 0.2);
  });

  it('refuses to step up something taller than the step height', () => {
    const tall = new CollisionWorld([
      box(-500, -2, -500, 500, GROUND_Y, 500, 0),
      box(-10, GROUND_Y, -20, 10, GROUND_Y + STEP_HEIGHT + 1, -5, 0),
    ]);
    const state = spawn(0, 0, 0);
    run(state, tall, 60, Button.Forward, 0);
    expect(state.pos.z).toBeGreaterThan(-5);
  });

  it('stops under a ceiling instead of clipping through it', () => {
    const roofY = GROUND_Y + PLAYER_HEIGHT + 0.6;
    const roofed = new CollisionWorld([
      box(-500, -2, -500, 500, GROUND_Y, 500, 0),
      box(-10, roofY, -10, 10, roofY + 1, 10, 0),
    ]);
    const state = spawn(0, 0, 0);
    run(state, roofed, 30, Button.Jump);
    expect(state.pos.y + PLAYER_HEIGHT).toBeLessThanOrEqual(roofY + 1e-3);
  });

  it('keeps players inside the map boundary', () => {
    const map = generateMap(1);
    const state = spawn(MAP_HALF - 5, 0, 0);
    run(state, map.world, 200, Button.Forward | Button.Sprint, -Math.PI / 2);
    expect(state.pos.x).toBeLessThanOrEqual(MAP_HALF);
  });
});
