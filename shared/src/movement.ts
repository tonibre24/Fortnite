import { Axis, type CollisionWorld, sweepAxis } from './collision.js';
import {
  AIR_ACCEL,
  AIR_FRICTION,
  COYOTE_TICKS,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_FRICTION,
  JUMP_VELOCITY,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SINCE_GROUNDED_MAX,
  SPRINT_SPEED,
  STEP_HEIGHT,
  TERMINAL_VELOCITY,
  WALK_SPEED,
} from './constants.js';
import { dequantizeYaw, f32 } from './math.js';
import { Button, StateFlag, type InputCommand, type PlayerState } from './types.js';

/**
 * The single movement implementation. The server runs it to produce authority;
 * the client runs the identical code to predict and to replay unacknowledged
 * input during reconciliation.
 *
 * Every stored float is rounded to float32 at the end of the step. That makes
 * the simulation state exactly representable on the wire, so a client replaying
 * from a received snapshot lands on the server's numbers bit-for-bit instead of
 * drifting by fractions of a ULP every tick.
 */
export function stepMovement(state: PlayerState, cmd: InputCommand, world: CollisionWorld, dt: number): void {
  const onGround = (state.flags & StateFlag.OnGround) !== 0;
  const jumpLatched = (state.flags & StateFlag.JumpLatched) !== 0;

  // --- desired horizontal direction, in world space -------------------------
  const yaw = dequantizeYaw(cmd.yawQ);
  let forward = 0;
  let strafe = 0;
  if ((cmd.buttons & Button.Forward) !== 0) forward += 1;
  if ((cmd.buttons & Button.Back) !== 0) forward -= 1;
  if ((cmd.buttons & Button.Right) !== 0) strafe += 1;
  if ((cmd.buttons & Button.Left) !== 0) strafe -= 1;
  if (forward !== 0 && strafe !== 0) {
    forward *= Math.SQRT1_2;
    strafe *= Math.SQRT1_2;
  }

  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  // Camera-space forward is (-sin, 0, -cos) and right is (cos, 0, -sin).
  const wishX = cosYaw * strafe - sinYaw * forward;
  const wishZ = -sinYaw * strafe - cosYaw * forward;
  const wishing = forward !== 0 || strafe !== 0;

  const sprinting = wishing && (cmd.buttons & Button.Sprint) !== 0;
  const targetSpeed = sprinting ? SPRINT_SPEED : WALK_SPEED;

  // --- horizontal velocity: friction, then acceleration ---------------------
  const friction = onGround ? GROUND_FRICTION : AIR_FRICTION;
  const speed = Math.sqrt(state.vel.x * state.vel.x + state.vel.z * state.vel.z);
  if (speed > 0) {
    const scale = Math.max(0, speed - speed * friction * dt) / speed;
    state.vel.x *= scale;
    state.vel.z *= scale;
  }

  if (wishing) {
    const accel = onGround ? GROUND_ACCEL : AIR_ACCEL;
    const alongWish = state.vel.x * wishX + state.vel.z * wishZ;
    const addSpeed = targetSpeed - alongWish;
    if (addSpeed > 0) {
      // Scaling by targetSpeed is what makes sprinting actually faster than
      // walking: without it, friction pins top speed at accel/friction no
      // matter what speed the player is asking for.
      const accelSpeed = Math.min(accel * dt * targetSpeed, addSpeed);
      state.vel.x += accelSpeed * wishX;
      state.vel.z += accelSpeed * wishZ;
    }
  }

  // --- jump -----------------------------------------------------------------
  const jumpHeld = (cmd.buttons & Button.Jump) !== 0;
  let nextJumpLatched = jumpLatched;
  let nextSinceGrounded = state.sinceGrounded;
  if (jumpHeld) {
    const canJump = onGround || state.sinceGrounded <= COYOTE_TICKS;
    if (!jumpLatched && canJump) {
      state.vel.y = JUMP_VELOCITY;
      nextSinceGrounded = SINCE_GROUNDED_MAX;
    }
    nextJumpLatched = true;
  } else {
    nextJumpLatched = false;
  }

  // --- gravity --------------------------------------------------------------
  state.vel.y -= GRAVITY * dt;
  if (state.vel.y < -TERMINAL_VELOCITY) state.vel.y = -TERMINAL_VELOCITY;

  // --- integrate and collide ------------------------------------------------
  const landed = sweepAxis(state.pos, Axis.Y, state.vel.y * dt, PLAYER_RADIUS, PLAYER_HEIGHT, world);
  const wasFalling = state.vel.y <= 0;
  if (landed) state.vel.y = 0;
  const nowOnGround = landed && wasFalling;

  moveHorizontal(state, state.vel.x * dt, state.vel.z * dt, nowOnGround, world);

  if (nowOnGround) {
    nextSinceGrounded = 0;
  } else if (nextSinceGrounded < SINCE_GROUNDED_MAX) {
    nextSinceGrounded += 1;
  }

  state.sinceGrounded = nextSinceGrounded;
  state.yawQ = cmd.yawQ;
  state.pitchQ = cmd.pitchQ;
  state.flags =
    (state.flags & ~(StateFlag.OnGround | StateFlag.Sprinting | StateFlag.JumpLatched)) |
    (nowOnGround ? StateFlag.OnGround : 0) |
    (sprinting ? StateFlag.Sprinting : 0) |
    (nextJumpLatched ? StateFlag.JumpLatched : 0);

  // Collapse to float32 so wire == memory.
  state.pos.x = f32(state.pos.x);
  state.pos.y = f32(state.pos.y);
  state.pos.z = f32(state.pos.z);
  state.vel.x = f32(state.vel.x);
  state.vel.y = f32(state.vel.y);
  state.vel.z = f32(state.vel.z);
}

/**
 * Slides along X then Z. When grounded movement is obstructed, the whole move
 * is retried from a raised start so small ledges (and the tiers of a hill) are
 * climbed instead of blocking.
 */
function moveHorizontal(
  state: PlayerState,
  dx: number,
  dz: number,
  onGround: boolean,
  world: CollisionWorld,
): void {
  if (dx === 0 && dz === 0) return;

  const startX = state.pos.x;
  const startY = state.pos.y;
  const startZ = state.pos.z;
  const startVelX = state.vel.x;
  const startVelZ = state.vel.z;

  if (sweepAxis(state.pos, Axis.X, dx, PLAYER_RADIUS, PLAYER_HEIGHT, world)) state.vel.x = 0;
  if (sweepAxis(state.pos, Axis.Z, dz, PLAYER_RADIUS, PLAYER_HEIGHT, world)) state.vel.z = 0;

  if (!onGround) return;

  const flatX = state.pos.x;
  const flatZ = state.pos.z;
  const flatDistSq = (flatX - startX) * (flatX - startX) + (flatZ - startZ) * (flatZ - startZ);
  const wantedDistSq = dx * dx + dz * dz;
  if (flatDistSq >= wantedDistSq) return;

  // Blocked. Try again over the top of whatever is in the way.
  const flatVelX = state.vel.x;
  const flatVelZ = state.vel.z;
  state.pos.x = startX;
  state.pos.y = startY;
  state.pos.z = startZ;
  state.vel.x = startVelX;
  state.vel.z = startVelZ;

  sweepAxis(state.pos, Axis.Y, STEP_HEIGHT, PLAYER_RADIUS, PLAYER_HEIGHT, world);
  const steppedVelX = sweepAxis(state.pos, Axis.X, dx, PLAYER_RADIUS, PLAYER_HEIGHT, world);
  const steppedVelZ = sweepAxis(state.pos, Axis.Z, dz, PLAYER_RADIUS, PLAYER_HEIGHT, world);
  sweepAxis(state.pos, Axis.Y, -STEP_HEIGHT, PLAYER_RADIUS, PLAYER_HEIGHT, world);

  const stepDistSq =
    (state.pos.x - startX) * (state.pos.x - startX) + (state.pos.z - startZ) * (state.pos.z - startZ);

  if (stepDistSq > flatDistSq) {
    if (steppedVelX) state.vel.x = 0;
    if (steppedVelZ) state.vel.z = 0;
  } else {
    state.pos.x = flatX;
    state.pos.y = startY;
    state.pos.z = flatZ;
    state.vel.x = flatVelX;
    state.vel.z = flatVelZ;
  }
}

/** Command a disconnected or starved player is simulated with: look, no intent. */
export function idleCommand(seq: number, yawQ: number, pitchQ: number): InputCommand {
  return { seq, buttons: 0, yawQ, pitchQ };
}
