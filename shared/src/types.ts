import type { Vec3 } from './math.js';

/** Bitfield of held actions, packed into one byte of every input command. */
export const Button = {
  Forward: 1 << 0,
  Back: 1 << 1,
  Left: 1 << 2,
  Right: 1 << 3,
  Jump: 1 << 4,
  Sprint: 1 << 5,
  Crouch: 1 << 6,
  Fire: 1 << 7,
} as const;

export type ButtonName = keyof typeof Button;

/**
 * One tick of player intent. This is the only thing a client is allowed to
 * send about itself - never a position. Angles are pre-quantized so that
 * client prediction and server simulation consume identical numbers.
 */
export interface InputCommand {
  seq: number;
  buttons: number;
  yawQ: number;
  pitchQ: number;
}

/** Flags packed into the replicated player flag byte. */
export const StateFlag = {
  OnGround: 1 << 0,
  Sprinting: 1 << 1,
  Alive: 1 << 2,
  JumpLatched: 1 << 3,
} as const;

/**
 * The full replicated state of a player. Every float here is kept float32-exact
 * so the wire representation is lossless and reconciliation converges to zero
 * error.
 */
export interface PlayerState {
  id: number;
  pos: Vec3;
  vel: Vec3;
  yawQ: number;
  pitchQ: number;
  flags: number;
  health: number;
  shield: number;
  /** Ticks since the player was last grounded, saturating at 255 (coyote time). */
  sinceGrounded: number;
}

export function createPlayerState(id: number): PlayerState {
  return {
    id,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yawQ: 0,
    pitchQ: 0,
    flags: StateFlag.Alive,
    health: 100,
    shield: 0,
    sinceGrounded: 0,
  };
}

export function copyPlayerState(out: PlayerState, src: PlayerState): PlayerState {
  out.id = src.id;
  out.pos.x = src.pos.x;
  out.pos.y = src.pos.y;
  out.pos.z = src.pos.z;
  out.vel.x = src.vel.x;
  out.vel.y = src.vel.y;
  out.vel.z = src.vel.z;
  out.yawQ = src.yawQ;
  out.pitchQ = src.pitchQ;
  out.flags = src.flags;
  out.health = src.health;
  out.shield = src.shield;
  out.sinceGrounded = src.sinceGrounded;
  return out;
}

export function clonePlayerState(src: PlayerState): PlayerState {
  return copyPlayerState(createPlayerState(src.id), src);
}

export function hasFlag(state: PlayerState, flag: number): boolean {
  return (state.flags & flag) !== 0;
}

export function setFlag(state: PlayerState, flag: number, on: boolean): void {
  if (on) state.flags |= flag;
  else state.flags &= ~flag;
}

/** Public info about a connected player that changes rarely. */
export interface PlayerInfo {
  id: number;
  name: string;
}
