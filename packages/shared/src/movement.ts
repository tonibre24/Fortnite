import {
  AIM_SPEED,
  AIR_ACCELERATION,
  AIR_DRAG,
  COYOTE_TIME_MS,
  GRAVITY,
  GROUND_ACCELERATION,
  GROUND_FRICTION,
  JUMP_COOLDOWN_MS,
  JUMP_VELOCITY,
  MAX_PITCH,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SPRINT_SPEED,
  STEP_HEIGHT,
  TERMINAL_VELOCITY,
  WALK_SPEED,
} from './constants.js';
import { aabbOverlaps, type AABB, type ColliderIndex } from './collision.js';
import { clamp, cloneVec3, type Vec3 } from './math.js';

/**
 * Deterministic third-person character controller.
 *
 * The exact same function runs for local prediction on the client and for the
 * authoritative simulation on the server, stepped at a fixed `FIXED_DT`. Anything
 * frame-rate dependent or randomised would break reconciliation, so neither is used.
 */

export const INPUT_JUMP = 1 << 0;
export const INPUT_SPRINT = 1 << 1;
export const INPUT_AIM = 1 << 2;

export interface InputCommand {
  /** Monotonic per-connection sequence number; also the reconciliation key. */
  seq: number;
  /** Strafe axis, -1 (left) to 1 (right). */
  moveX: number;
  /** Forward axis, -1 (back) to 1 (forward). */
  moveZ: number;
  yaw: number;
  pitch: number;
  /** Bitfield of INPUT_* flags. */
  buttons: number;
}

export interface MovementState {
  /** Feet position. */
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  /** Simulated clock in milliseconds; advanced by `stepMovement`. */
  timeMs: number;
  lastGroundedAtMs: number;
  lastJumpAtMs: number;
}

export const createMovementState = (position: Vec3, timeMs = 0): MovementState => ({
  position: cloneVec3(position),
  velocity: { x: 0, y: 0, z: 0 },
  grounded: false,
  timeMs,
  lastGroundedAtMs: timeMs,
  lastJumpAtMs: -Infinity,
});

export const hasButton = (buttons: number, flag: number): boolean => (buttons & flag) !== 0;

export function playerAABB(position: Vec3): AABB {
  return {
    min: { x: position.x - PLAYER_RADIUS, y: position.y, z: position.z - PLAYER_RADIUS },
    max: {
      x: position.x + PLAYER_RADIUS,
      y: position.y + PLAYER_HEIGHT,
      z: position.z + PLAYER_RADIUS,
    },
  };
}

/** Theoretical top speed for a given input; used for server-side speed validation. */
export function maxSpeedForInput(buttons: number): number {
  if (hasButton(buttons, INPUT_AIM)) return AIM_SPEED;
  if (hasButton(buttons, INPUT_SPRINT)) return SPRINT_SPEED;
  return WALK_SPEED;
}

function overlapsWorld(position: Vec3, index: ColliderIndex): boolean {
  const box = playerAABB(position);
  const candidates = index.query(box.min, box.max);
  for (const collider of candidates) {
    if (aabbOverlaps(box, collider)) return true;
  }
  return false;
}

/**
 * Moves along one axis and resolves penetration against every overlapping collider.
 * Returns true when the movement was blocked.
 */
function moveAxis(
  position: Vec3,
  axis: 'x' | 'y' | 'z',
  delta: number,
  index: ColliderIndex,
): boolean {
  if (delta === 0) return false;
  position[axis] += delta;

  let blocked = false;
  // Two passes are enough for axis-aligned geometry: the first resolves the deepest
  // contact, the second catches a collider revealed by that correction.
  for (let pass = 0; pass < 2; pass++) {
    const box = playerAABB(position);
    const candidates = index.query(box.min, box.max);
    let resolved = false;
    for (const collider of candidates) {
      if (!aabbOverlaps(playerAABB(position), collider)) continue;
      const current = playerAABB(position);
      if (delta > 0) {
        position[axis] -= current.max[axis] - collider.min[axis];
      } else {
        position[axis] += collider.max[axis] - current.min[axis];
      }
      blocked = true;
      resolved = true;
    }
    if (!resolved) break;
  }
  return blocked;
}

export interface StepResult {
  /** True when a horizontal collision occurred this step (used for effects/debug). */
  hitWall: boolean;
  /** True when the controller landed this step. */
  landed: boolean;
}

/**
 * Advances one player by exactly `dt` seconds under a single input command.
 * Mutates `state` in place.
 */
export function stepMovement(
  state: MovementState,
  command: InputCommand,
  dt: number,
  index: ColliderIndex,
  options: { frozen?: boolean } = {},
): StepResult {
  const wasGrounded = state.grounded;
  state.timeMs += dt * 1000;

  if (options.frozen) {
    // Eliminated players keep their clock running but do not move.
    state.velocity.x = 0;
    state.velocity.z = 0;
    return { hitWall: false, landed: false };
  }

  const buttons = command.buttons | 0;
  const aiming = hasButton(buttons, INPUT_AIM);
  const wantsSprint = hasButton(buttons, INPUT_SPRINT) && !aiming && command.moveZ > 0.1;

  // Input direction in world space (yaw 0 faces +Z).
  const moveX = clamp(command.moveX, -1, 1);
  const moveZ = clamp(command.moveZ, -1, 1);
  const inputLength = Math.hypot(moveX, moveZ);
  const sin = Math.sin(command.yaw);
  const cos = Math.cos(command.yaw);
  let wishX = 0;
  let wishZ = 0;
  if (inputLength > 1e-4) {
    const nx = moveX / Math.max(1, inputLength);
    const nz = moveZ / Math.max(1, inputLength);
    wishX = nx * cos + nz * sin;
    wishZ = -nx * sin + nz * cos;
  }

  const targetSpeed = aiming ? AIM_SPEED : wantsSprint ? SPRINT_SPEED : WALK_SPEED;
  const desiredX = wishX * targetSpeed;
  const desiredZ = wishZ * targetSpeed;

  if (state.grounded) {
    if (inputLength <= 1e-4) {
      const friction = Math.max(0, 1 - GROUND_FRICTION * dt);
      state.velocity.x *= friction;
      state.velocity.z *= friction;
    } else {
      const accel = GROUND_ACCELERATION * dt;
      state.velocity.x += clamp(desiredX - state.velocity.x, -accel, accel);
      state.velocity.z += clamp(desiredZ - state.velocity.z, -accel, accel);
    }
  } else {
    const accel = AIR_ACCELERATION * dt;
    state.velocity.x += clamp(desiredX - state.velocity.x, -accel, accel);
    state.velocity.z += clamp(desiredZ - state.velocity.z, -accel, accel);
    const drag = Math.max(0, 1 - AIR_DRAG * dt);
    state.velocity.x *= drag;
    state.velocity.z *= drag;
  }

  // Jumping: requires ground contact (or coyote time) and respects a cooldown so
  // holding/spamming the key cannot produce repeated boosts.
  const canCoyote = state.timeMs - state.lastGroundedAtMs <= COYOTE_TIME_MS;
  const jumpReady = state.timeMs - state.lastJumpAtMs >= JUMP_COOLDOWN_MS;
  if (hasButton(buttons, INPUT_JUMP) && (state.grounded || canCoyote) && jumpReady) {
    state.velocity.y = JUMP_VELOCITY;
    state.grounded = false;
    state.lastJumpAtMs = state.timeMs;
    state.lastGroundedAtMs = -Infinity;
  }

  state.velocity.y = Math.max(-TERMINAL_VELOCITY, state.velocity.y - GRAVITY * dt);

  // --- Horizontal movement with step-up ------------------------------------
  const before = cloneVec3(state.position);
  const dx = state.velocity.x * dt;
  const dz = state.velocity.z * dt;
  const blockedX = moveAxis(state.position, 'x', dx, index);
  const blockedZ = moveAxis(state.position, 'z', dz, index);
  const hitWall = blockedX || blockedZ;

  if (hitWall && (wasGrounded || state.grounded)) {
    const flatProgress = Math.hypot(state.position.x - before.x, state.position.z - before.z);
    const stepped = cloneVec3(before);
    stepped.y += STEP_HEIGHT;
    if (!overlapsWorld(stepped, index)) {
      moveAxis(stepped, 'x', dx, index);
      moveAxis(stepped, 'z', dz, index);
      const steppedProgress = Math.hypot(stepped.x - before.x, stepped.z - before.z);
      if (steppedProgress > flatProgress + 1e-4) {
        // Settle back down onto the step we just climbed.
        moveAxis(stepped, 'y', -STEP_HEIGHT, index);
        if (!overlapsWorld(stepped, index)) {
          state.position.x = stepped.x;
          state.position.y = stepped.y;
          state.position.z = stepped.z;
        }
      }
    }
  }

  if (blockedX) state.velocity.x = 0;
  if (blockedZ) state.velocity.z = 0;

  // --- Vertical movement ----------------------------------------------------
  const dy = state.velocity.y * dt;
  const blockedY = moveAxis(state.position, 'y', dy, index);
  let landed = false;
  if (blockedY) {
    if (dy <= 0) {
      state.grounded = true;
      landed = !wasGrounded;
    }
    state.velocity.y = 0;
  } else if (dy < 0) {
    state.grounded = false;
  }

  // Ground probe: keeps `grounded` true while walking over seams between colliders.
  if (!state.grounded && state.velocity.y <= 0) {
    const probe = cloneVec3(state.position);
    if (moveAxis(probe, 'y', -0.08, index)) {
      state.grounded = true;
      state.position.y = probe.y;
      state.velocity.y = 0;
    }
  }

  if (state.grounded) state.lastGroundedAtMs = state.timeMs;

  return { hitWall, landed };
}

/** Clamps pitch to the playable range; shared so client and server never disagree. */
export const clampPitch = (pitch: number): number => clamp(pitch, -MAX_PITCH, MAX_PITCH);

/** Eye position used as the hitscan origin and camera anchor. */
export function eyePosition(position: Vec3, eyeHeight: number): Vec3 {
  return { x: position.x, y: position.y + eyeHeight, z: position.z };
}
