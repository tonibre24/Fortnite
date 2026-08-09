import { PLAYER_MAX_HEALTH } from './constants.js';
import { copyStack, createInventory, type ItemStack } from './items.js';
import type { Vec3 } from './math.js';

/** Bitfield of held actions, packed into two bytes of every input command. */
export const Button = {
  Forward: 1 << 0,
  Back: 1 << 1,
  Left: 1 << 2,
  Right: 1 << 3,
  Jump: 1 << 4,
  Sprint: 1 << 5,
  Crouch: 1 << 6,
  Fire: 1 << 7,
  Reload: 1 << 8,
  Interact: 1 << 9,
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
  /**
   * The moment, in fractional server ticks, that the client was rendering other
   * players at when it pressed fire. The server rewinds to it so a shot is
   * judged against what the shooter actually saw. Only carried on commands that
   * fire; zero otherwise.
   */
  renderTick: number;
  /** Inventory slot the client wants held. Sent every tick so it cannot be lost. */
  slot: number;
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
  /** Equipped weapon, packed class + rarity. Zero means empty handed. */
  weapon: number;
  /** Rounds left in the magazine. */
  ammo: number;
  /** Ticks left on a reload, zero when not reloading. */
  reload: number;
  kills: number;
  /** Five slots of carried items. Only replicated to their owner. */
  inventory: ItemStack[];
  /** Which slot is in hand. */
  slot: number;
}

export function createPlayerState(id: number): PlayerState {
  return {
    id,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yawQ: 0,
    pitchQ: 0,
    flags: StateFlag.Alive,
    health: PLAYER_MAX_HEALTH,
    shield: 0,
    sinceGrounded: 0,
    weapon: 0,
    ammo: 0,
    reload: 0,
    kills: 0,
    inventory: createInventory(),
    slot: 0,
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
  out.weapon = src.weapon;
  out.ammo = src.ammo;
  out.reload = src.reload;
  out.kills = src.kills;
  for (let i = 0; i < out.inventory.length; i++) {
    copyStack(out.inventory[i]!, src.inventory[i]!);
  }
  out.slot = src.slot;
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
