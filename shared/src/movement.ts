import { Axis, type CollisionWorld, sweepAxis } from './collision.js';
import {
  AIM_SPEED_MULTIPLIER,
  AIR_ACCEL,
  AIR_FRICTION,
  COYOTE_TICKS,
  FREEFALL_ACCEL,
  FREEFALL_MAX_SPEED,
  FREEFALL_TERMINAL,
  GLIDE_ACCEL,
  GLIDE_ALTITUDE,
  GLIDE_FALL_SPEED,
  GLIDE_FRICTION,
  GLIDE_MAX_SPEED,
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
  TICK_DT,
  WALK_SPEED,
} from './constants.js';
import { dequantizeYaw, f32 } from './math.js';
import { MoveMode } from './round.js';
import { Button, StateFlag, type InputCommand, type PlayerState } from './types.js';

/** Direction the player is asking to move, in world space, already normalised. */
function wishDirection(cmd: InputCommand): { x: number; z: number; active: boolean } {
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
  const yaw = dequantizeYaw(cmd.yawQ);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  return {
    x: cosYaw * strafe - sinYaw * forward,
    z: -sinYaw * strafe - cosYaw * forward,
    active: forward !== 0 || strafe !== 0,
  };
}

/**
 * Falling out of the bus. A dive accelerates towards terminal velocity with
 * loose steering; below the glide altitude the glider opens by itself and the
 * descent slows to something survivable, which is why there is no fall damage
 * anywhere in this game.
 */
export function stepSkydive(
  state: PlayerState,
  cmd: InputCommand,
  world: CollisionWorld,
  dt: number,
): void {
  const gliding = state.mode === MoveMode.Glide;
  const wish = wishDirection(cmd);

  const accel = gliding ? GLIDE_ACCEL : FREEFALL_ACCEL;
  const maxSpeed = gliding ? GLIDE_MAX_SPEED : FREEFALL_MAX_SPEED;

  if (gliding) {
    const speed = Math.sqrt(state.vel.x * state.vel.x + state.vel.z * state.vel.z);
    if (speed > 0) {
      const scale = Math.max(0, speed - speed * GLIDE_FRICTION * dt) / speed;
      state.vel.x *= scale;
      state.vel.z *= scale;
    }
  }

  if (wish.active) {
    const along = state.vel.x * wish.x + state.vel.z * wish.z;
    const addSpeed = maxSpeed - along;
    if (addSpeed > 0) {
      const step = Math.min(accel * dt * maxSpeed, addSpeed);
      state.vel.x += step * wish.x;
      state.vel.z += step * wish.z;
    }
  }

  if (gliding) {
    // The glider holds a steady sink rate rather than accelerating.
    state.vel.y = -GLIDE_FALL_SPEED;
  } else {
    state.vel.y -= GRAVITY * dt;
    if (state.vel.y < -FREEFALL_TERMINAL) state.vel.y = -FREEFALL_TERMINAL;
  }

  const landed = sweepAxis(state.pos, Axis.Y, state.vel.y * dt, PLAYER_RADIUS, PLAYER_HEIGHT, world);
  if (landed) state.vel.y = 0;
  moveHorizontal(state, state.vel.x * dt, state.vel.z * dt, false, world);

  if (landed) {
    // Touching down ends the drop; ordinary movement takes over next tick.
    state.mode = MoveMode.Ground;
    state.flags |= StateFlag.OnGround;
    state.sinceGrounded = 0;
    state.vel.x = 0;
    state.vel.z = 0;
  } else if (!gliding && state.pos.y <= GLIDE_ALTITUDE) {
    state.mode = MoveMode.Glide;
  }

  state.yawQ = cmd.yawQ;
  state.pitchQ = cmd.pitchQ;
  state.pos.x = f32(state.pos.x);
  state.pos.y = f32(state.pos.y);
  state.pos.z = f32(state.pos.z);
  state.vel.x = f32(state.vel.x);
  state.vel.y = f32(state.vel.y);
  state.vel.z = f32(state.vel.z);
}

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
  // Riding the bus is not simulated at all - the server places you - and the
  // drop has its own physics.
  if (state.mode === MoveMode.Bus) {
    state.yawQ = cmd.yawQ;
    state.pitchQ = cmd.pitchQ;
    return;
  }
  if (state.mode === MoveMode.Freefall || state.mode === MoveMode.Glide) {
    stepSkydive(state, cmd, world, dt);
    return;
  }

  const onGround = (state.flags & StateFlag.OnGround) !== 0;
  const jumpLatched = (state.flags & StateFlag.JumpLatched) !== 0;

  // --- desired horizontal direction, in world space -------------------------
  const wish = wishDirection(cmd);
  const wishX = wish.x;
  const wishZ = wish.z;
  const wishing = wish.active;

  // Aiming overrides sprint rather than combining with it - matches how the
  // viewmodel and FOV only have one eased target to move towards, and it
  // means a player cannot use Aim to sneak a burst of extra top speed.
  const aiming = (cmd.buttons & Button.Aim) !== 0;
  const sprinting = wishing && !aiming && (cmd.buttons & Button.Sprint) !== 0;
  const targetSpeed = (sprinting ? SPRINT_SPEED : WALK_SPEED) * (aiming ? AIM_SPEED_MULTIPLIER : 1);

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
    (state.flags &
      ~(StateFlag.OnGround | StateFlag.Sprinting | StateFlag.JumpLatched | StateFlag.Aiming)) |
    (nowOnGround ? StateFlag.OnGround : 0) |
    (sprinting ? StateFlag.Sprinting : 0) |
    (nextJumpLatched ? StateFlag.JumpLatched : 0) |
    (aiming ? StateFlag.Aiming : 0);

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
export function idleCommand(seq: number, yawQ: number, pitchQ: number, slot = 0): InputCommand {
  return { seq, buttons: 0, yawQ, pitchQ, renderTick: 0, slot };
}

/**
 * Settles a freshly placed player onto the ground.
 *
 * A spawn point sits exactly on the terrain surface, which is not a state
 * `stepMovement` ever produces: the first simulated step drops the player a
 * fraction, resolves the collision and raises `OnGround`. Until that happens the
 * position is a pose, not a simulation state, and a client that starts
 * predicting from it walks a different path than the server does - a real
 * divergence the client cannot see coming, since nothing about the snapshot says
 * "not settled yet".
 *
 * Running one idle step here produces exactly the state the next real step would
 * have started from, so prediction matches from the very first command.
 */
export function settleOnGround(state: PlayerState, world: CollisionWorld): void {
  stepMovement(state, idleCommand(0, state.yawQ, state.pitchQ, state.slot), world, TICK_DT);
}
