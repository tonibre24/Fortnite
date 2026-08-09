import { BinaryReader, BinaryWriter } from './binary.js';
import { PROTOCOL_VERSION, RENDER_TICK_SCALE, TICK_RATE } from './constants.js';
import type { ItemStack } from './items.js';
import { createRoundState, type RoundState } from './round.js';
import { Button, createPlayerState, type InputCommand, type PlayerState } from './types.js';

/** Message type tags. Client messages are < 0x80, server messages >= 0x80. */
export const MsgType = {
  Join: 0x01,
  Input: 0x02,
  Ping: 0x03,

  Welcome: 0x81,
  Snapshot: 0x82,
  Pong: 0x83,
  Kick: 0x84,
} as const;

export const KickReason = {
  BadProtocol: 1,
  ServerFull: 2,
  Timeout: 3,
  BadMessage: 4,
} as const;

export const KICK_TEXT: Record<number, string> = {
  [KickReason.BadProtocol]: 'protocol version mismatch',
  [KickReason.ServerFull]: 'server is full',
  [KickReason.Timeout]: 'connection timed out',
  [KickReason.BadMessage]: 'malformed message',
};

// ------------------------------------------------------------- client -> server

export interface JoinMsg {
  type: typeof MsgType.Join;
  protocolVersion: number;
  name: string;
}

export interface PingMsg {
  type: typeof MsgType.Ping;
  clientTime: number;
}

export interface InputMsg {
  type: typeof MsgType.Input;
  /** Newest snapshot tick the client has successfully decoded (0 = none yet). */
  ackTick: number;
  commands: InputCommand[];
}

export type ClientMessage = JoinMsg | PingMsg | InputMsg;

export function encodeJoin(name: string): ArrayBuffer {
  const w = new BinaryWriter(64);
  w.u8(MsgType.Join);
  w.u8(PROTOCOL_VERSION);
  w.str(name);
  return w.finish();
}

export function encodePing(clientTime: number): ArrayBuffer {
  const w = new BinaryWriter(16);
  w.u8(MsgType.Ping);
  w.f64(clientTime);
  return w.finish();
}

/**
 * Input commands are produced one per client tick, so a packet only needs the
 * sequence number of its first command; the rest are implied. Packets carry the
 * last few commands redundantly, which repairs a dropped one without any
 * retransmission logic.
 */
export function encodeInput(commands: readonly InputCommand[], ackTick: number): ArrayBuffer {
  const w = new BinaryWriter(16 + commands.length * 10);
  w.u8(MsgType.Input);
  w.u32(ackTick >>> 0);
  w.u32(commands.length === 0 ? 0 : commands[0]!.seq >>> 0);
  w.u8(commands.length);
  for (const cmd of commands) {
    w.u16(cmd.buttons);
    w.u16(cmd.yawQ);
    w.i16(cmd.pitchQ);
    w.u8(cmd.slot);
    // The rewind time only matters for a shot, so only a shot pays for it.
    if ((cmd.buttons & Button.Fire) !== 0) {
      w.u32(Math.max(0, Math.round(cmd.renderTick * RENDER_TICK_SCALE)));
    }
  }
  return w.finish();
}

// ------------------------------------------------------------- server -> client

export interface WelcomeMsg {
  type: typeof MsgType.Welcome;
  protocolVersion: number;
  playerId: number;
  mapSeed: number;
  /** Fingerprint of the server's generated map; the client checks its own against it. */
  mapHash: number;
  tickRate: number;
  tick: number;
  serverTime: number;
}

export interface PongMsg {
  type: typeof MsgType.Pong;
  clientTime: number;
  serverTime: number;
  tick: number;
}

export interface KickMsg {
  type: typeof MsgType.Kick;
  reason: number;
}

export type ServerMessage = WelcomeMsg | PongMsg | KickMsg;

export function encodeWelcome(
  playerId: number,
  mapSeed: number,
  mapHash: number,
  tick: number,
  serverTime: number,
): ArrayBuffer {
  const w = new BinaryWriter(32);
  w.u8(MsgType.Welcome);
  w.u8(PROTOCOL_VERSION);
  w.u16(playerId);
  w.u32(mapSeed >>> 0);
  w.u32(mapHash >>> 0);
  w.u8(TICK_RATE);
  w.u32(tick >>> 0);
  w.f64(serverTime);
  return w.finish();
}

export function encodePong(clientTime: number, serverTime: number, tick: number): ArrayBuffer {
  const w = new BinaryWriter(32);
  w.u8(MsgType.Pong);
  w.f64(clientTime);
  w.f64(serverTime);
  w.u32(tick >>> 0);
  return w.finish();
}

export function encodeKick(reason: number): ArrayBuffer {
  const w = new BinaryWriter(4);
  w.u8(MsgType.Kick);
  w.u8(reason);
  return w.finish();
}

// --------------------------------------------------------------- snapshots

/**
 * Which fields a player record carries. Anything unchanged since the baseline
 * is simply absent, which is where nearly all of the bandwidth saving comes
 * from - a standing player costs two bytes of id plus a zero mask.
 */
export const Field = {
  PosX: 1 << 0,
  PosY: 1 << 1,
  PosZ: 1 << 2,
  VelX: 1 << 3,
  VelY: 1 << 4,
  VelZ: 1 << 5,
  Yaw: 1 << 6,
  Pitch: 1 << 7,
  Flags: 1 << 8,
  Health: 1 << 9,
  Shield: 1 << 10,
  SinceGrounded: 1 << 11,
  Weapon: 1 << 12,
  Ammo: 1 << 13,
  Reload: 1 << 14,
  Kills: 1 << 15,
  Inventory: 1 << 16,
  Slot: 1 << 17,
  Mode: 1 << 18,
  Epoch: 1 << 19,
} as const;

/**
 * Fields only replicated to the player they belong to. Everyone needs to know
 * which gun you are holding; nobody else needs your magazine count, and your
 * velocity is only useful to the client predicting you.
 */
const SELF_ONLY_FIELDS =
  Field.VelX | Field.VelY | Field.VelZ | Field.Ammo | Field.Reload | Field.Inventory | Field.Slot;

const SNAPSHOT_FLAG_DELTA = 1 << 0;

const EMPTY_LOOT: ReadonlyMap<number, LootItem> = new Map();
const DEFAULT_ROUND: RoundState = createRoundState(0);

/** One thing lying in the world, with the id the server tracks it by. */
export interface LootItem {
  id: number;
  x: number;
  y: number;
  z: number;
  kind: number;
  rarity: number;
  count: number;
}

export interface SnapshotBaseline {
  tick: number;
  players: ReadonlyMap<number, PlayerState>;
  /**
   * Which loot existed at this tick. Items never change once spawned, so the
   * delta only ever needs to say what appeared and what was taken - the same
   * trick the player list uses, against the same acknowledged baseline.
   */
  lootIds: ReadonlySet<number>;
}

/** What a client keeps for a decoded tick so it can serve as a baseline. */
export interface ClientBaseline {
  players: ReadonlyMap<number, PlayerState>;
  loot: ReadonlyMap<number, LootItem>;
}

/**
 * One-shot notifications for things that happen at an instant rather than
 * having a state: a shot going off, a hit landing, someone dying. They ride
 * along with the snapshot because it is already a per-client packet, so each
 * client can be told only what it should know - hit markers go to the shooter,
 * damage direction to the victim, kills to everyone.
 */
export const EventType = {
  Shot: 1,
  Hit: 2,
  Kill: 3,
  Damaged: 4,
} as const;

export interface ShotEvent {
  type: typeof EventType.Shot;
  shooterId: number;
  seq: number;
  weapon: number;
  x: number;
  y: number;
  z: number;
  yawQ: number;
  pitchQ: number;
}

export interface HitEvent {
  type: typeof EventType.Hit;
  victimId: number;
  damage: number;
  headshot: boolean;
  killed: boolean;
}

export interface KillEvent {
  type: typeof EventType.Kill;
  killerId: number;
  victimId: number;
  weapon: number;
}

export interface DamagedEvent {
  type: typeof EventType.Damaged;
  attackerId: number;
  damage: number;
  dirX: number;
  dirZ: number;
}

export type GameEvent = ShotEvent | HitEvent | KillEvent | DamagedEvent;

export function writeEvent(w: BinaryWriter, event: GameEvent): void {
  w.u8(event.type);
  switch (event.type) {
    case EventType.Shot:
      w.u16(event.shooterId);
      w.u32(event.seq >>> 0);
      w.u8(event.weapon);
      w.f32(event.x);
      w.f32(event.y);
      w.f32(event.z);
      w.u16(event.yawQ);
      w.i16(event.pitchQ);
      break;
    case EventType.Hit:
      w.u16(event.victimId);
      w.u16(event.damage);
      w.u8((event.headshot ? 1 : 0) | (event.killed ? 2 : 0));
      break;
    case EventType.Kill:
      w.u16(event.killerId);
      w.u16(event.victimId);
      w.u8(event.weapon);
      break;
    case EventType.Damaged:
      w.u16(event.attackerId);
      w.u16(event.damage);
      w.f32(event.dirX);
      w.f32(event.dirZ);
      break;
  }
}

export function readEvent(r: BinaryReader): GameEvent | null {
  const type = r.u8();
  switch (type) {
    case EventType.Shot:
      return {
        type: EventType.Shot,
        shooterId: r.u16(),
        seq: r.u32(),
        weapon: r.u8(),
        x: r.f32(),
        y: r.f32(),
        z: r.f32(),
        yawQ: r.u16(),
        pitchQ: r.i16(),
      };
    case EventType.Hit: {
      const victimId = r.u16();
      const damage = r.u16();
      const flags = r.u8();
      return {
        type: EventType.Hit,
        victimId,
        damage,
        headshot: (flags & 1) !== 0,
        killed: (flags & 2) !== 0,
      };
    }
    case EventType.Kill:
      return { type: EventType.Kill, killerId: r.u16(), victimId: r.u16(), weapon: r.u8() };
    case EventType.Damaged:
      return {
        type: EventType.Damaged,
        attackerId: r.u16(),
        damage: r.u16(),
        dirX: r.f32(),
        dirZ: r.f32(),
      };
    default:
      return null;
  }
}

export interface DecodedSnapshot {
  tick: number;
  lastProcessedSeq: number;
  players: Map<number, PlayerState>;
  loot: Map<number, LootItem>;
  events: GameEvent[];
  round: RoundState;
}

/**
 * Writes the difference between `players` and `baseline`. Pass `baseline: null`
 * to write a full snapshot, which is what a client gets until it has
 * acknowledged something the server still remembers.
 */
export function encodeSnapshot(
  tick: number,
  players: ReadonlyMap<number, PlayerState>,
  baseline: SnapshotBaseline | null,
  selfId: number,
  lastProcessedSeq: number,
  events: readonly GameEvent[] = [],
  loot: ReadonlyMap<number, LootItem> = EMPTY_LOOT,
  round: RoundState = DEFAULT_ROUND,
): ArrayBuffer {
  const w = new BinaryWriter(64 + players.size * 40);
  w.u8(MsgType.Snapshot);
  w.u32(tick >>> 0);
  w.u8(baseline === null ? 0 : SNAPSHOT_FLAG_DELTA);
  w.u32(baseline === null ? 0 : baseline.tick >>> 0);
  w.u32(lastProcessedSeq >>> 0);

  // Round and storm state is small and changes every tick, so it is written
  // whole rather than delta-compressed.
  w.u8(round.phase);
  w.u32(round.phaseTick >>> 0);
  w.u32(round.mapSeed >>> 0);
  w.u32(round.mapHash >>> 0);
  w.u8(round.stormPhase);
  w.f32(round.stormX);
  w.f32(round.stormZ);
  w.f32(round.stormRadius);
  w.f32(round.targetX);
  w.f32(round.targetZ);
  w.f32(round.targetRadius);
  w.u16(Math.min(0xffff, round.stormWait));
  w.u8(round.aliveCount);
  w.u16(round.winnerId);

  const removed: number[] = [];
  if (baseline !== null) {
    for (const id of baseline.players.keys()) {
      if (!players.has(id)) removed.push(id);
    }
  }
  w.u8(removed.length);
  for (const id of removed) w.u16(id);

  // Players whose every field matches the baseline are omitted; the client
  // carries them forward. Absence therefore means "unchanged", and removal is
  // what the list above is for.
  const changed: Array<{ id: number; state: PlayerState; mask: number }> = [];
  for (const [id, state] of players) {
    const prev = baseline === null ? undefined : baseline.players.get(id);
    let mask = prev === undefined ? fullMask(id === selfId) : diffMask(state, prev, id === selfId);
    if (id !== selfId) mask &= ~SELF_ONLY_FIELDS;
    if (prev !== undefined && mask === 0) continue;
    changed.push({ id, state, mask });
  }

  w.u16(changed.length);
  for (const { id, state, mask } of changed) {
    w.u16(id);
    w.u32(mask);
    if ((mask & Field.PosX) !== 0) w.f32(state.pos.x);
    if ((mask & Field.PosY) !== 0) w.f32(state.pos.y);
    if ((mask & Field.PosZ) !== 0) w.f32(state.pos.z);
    if ((mask & Field.VelX) !== 0) w.f32(state.vel.x);
    if ((mask & Field.VelY) !== 0) w.f32(state.vel.y);
    if ((mask & Field.VelZ) !== 0) w.f32(state.vel.z);
    if ((mask & Field.Yaw) !== 0) w.u16(state.yawQ);
    if ((mask & Field.Pitch) !== 0) w.i16(state.pitchQ);
    if ((mask & Field.Flags) !== 0) w.u8(state.flags);
    if ((mask & Field.Health) !== 0) w.u8(state.health);
    if ((mask & Field.Shield) !== 0) w.u8(state.shield);
    if ((mask & Field.SinceGrounded) !== 0) w.u8(state.sinceGrounded);
    if ((mask & Field.Weapon) !== 0) w.u8(state.weapon);
    if ((mask & Field.Ammo) !== 0) w.u8(state.ammo);
    if ((mask & Field.Reload) !== 0) w.u8(state.reload);
    if ((mask & Field.Kills) !== 0) w.u8(state.kills);
    if ((mask & Field.Inventory) !== 0) {
      for (const stack of state.inventory) {
        w.u8(stack.kind);
        w.u8(stack.rarity);
        w.u8(stack.count);
      }
    }
    if ((mask & Field.Slot) !== 0) w.u8(state.slot);
    if ((mask & Field.Mode) !== 0) w.u8(state.mode);
    if ((mask & Field.Epoch) !== 0) w.u8(state.epoch);
  }

  // Loot: what the baseline had and we no longer do, then what is new.
  const removedLoot: number[] = [];
  if (baseline !== null) {
    for (const id of baseline.lootIds) {
      if (!loot.has(id)) removedLoot.push(id);
    }
  }
  w.u16(removedLoot.length);
  for (const id of removedLoot) w.u16(id);

  const addedLoot: LootItem[] = [];
  for (const [id, item] of loot) {
    if (baseline !== null && baseline.lootIds.has(id)) continue;
    addedLoot.push(item);
  }
  w.u16(addedLoot.length);
  for (const item of addedLoot) {
    w.u16(item.id);
    w.f32(item.x);
    w.f32(item.y);
    w.f32(item.z);
    w.u8(item.kind);
    w.u8(item.rarity);
    w.u8(item.count);
  }

  // Events are never delta-compressed: they describe an instant, not a state,
  // so a lost snapshot simply loses them.
  const capped = events.length > 255 ? events.slice(0, 255) : events;
  w.u8(capped.length);
  for (const event of capped) writeEvent(w, event);

  return w.finish();
}

function fullMask(isSelf: boolean): number {
  const all =
    Field.PosX |
    Field.PosY |
    Field.PosZ |
    Field.VelX |
    Field.VelY |
    Field.VelZ |
    Field.Yaw |
    Field.Pitch |
    Field.Flags |
    Field.Health |
    Field.Shield |
    Field.SinceGrounded |
    Field.Weapon |
    Field.Ammo |
    Field.Reload |
    Field.Kills |
    Field.Inventory |
    Field.Slot |
    Field.Mode |
    Field.Epoch;
  return isSelf ? all : all & ~SELF_ONLY_FIELDS;
}

function inventoryDiffers(a: readonly ItemStack[], b: readonly ItemStack[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.kind !== y.kind || x.rarity !== y.rarity || x.count !== y.count) return true;
  }
  return false;
}

function diffMask(next: PlayerState, prev: PlayerState, isSelf: boolean): number {
  let mask = 0;
  if (next.pos.x !== prev.pos.x) mask |= Field.PosX;
  if (next.pos.y !== prev.pos.y) mask |= Field.PosY;
  if (next.pos.z !== prev.pos.z) mask |= Field.PosZ;
  if (isSelf) {
    if (next.vel.x !== prev.vel.x) mask |= Field.VelX;
    if (next.vel.y !== prev.vel.y) mask |= Field.VelY;
    if (next.vel.z !== prev.vel.z) mask |= Field.VelZ;
  }
  if (next.yawQ !== prev.yawQ) mask |= Field.Yaw;
  if (next.pitchQ !== prev.pitchQ) mask |= Field.Pitch;
  if (next.flags !== prev.flags) mask |= Field.Flags;
  if (next.health !== prev.health) mask |= Field.Health;
  if (next.shield !== prev.shield) mask |= Field.Shield;
  if (next.sinceGrounded !== prev.sinceGrounded) mask |= Field.SinceGrounded;
  if (next.weapon !== prev.weapon) mask |= Field.Weapon;
  if (isSelf) {
    if (next.ammo !== prev.ammo) mask |= Field.Ammo;
    if (next.reload !== prev.reload) mask |= Field.Reload;
  }
  if (next.kills !== prev.kills) mask |= Field.Kills;
  if (isSelf) {
    if (inventoryDiffers(next.inventory, prev.inventory)) mask |= Field.Inventory;
    if (next.slot !== prev.slot) mask |= Field.Slot;
  }
  if (next.mode !== prev.mode) mask |= Field.Mode;
  if (next.epoch !== prev.epoch) mask |= Field.Epoch;
  return mask;
}

/**
 * The tick a snapshot packet is for, without decoding the rest of it. Lets a
 * client drop a stale packet before doing any work on it.
 */
export function peekSnapshotTick(buffer: ArrayBuffer | Uint8Array): number | null {
  try {
    const r = new BinaryReader(buffer);
    if (r.u8() !== MsgType.Snapshot) return null;
    return r.u32();
  } catch {
    return null;
  }
}

/**
 * Rebuilds a full player map from a snapshot packet. `lookupBaseline` returns
 * the client's stored state for a given tick; returning null (the client no
 * longer has that baseline) makes this return null so the caller can ignore the
 * packet and keep acknowledging the last tick it does have.
 */
export function decodeSnapshot(
  buffer: ArrayBuffer | Uint8Array,
  lookupBaseline: (tick: number) => ClientBaseline | null,
): DecodedSnapshot | null {
  try {
    const r = new BinaryReader(buffer);
    if (r.u8() !== MsgType.Snapshot) return null;
    const tick = r.u32();
    const flags = r.u8();
    const baselineTick = r.u32();
    const lastProcessedSeq = r.u32();

    let baseline: ClientBaseline | null = null;
    if ((flags & SNAPSHOT_FLAG_DELTA) !== 0) {
      baseline = lookupBaseline(baselineTick);
      if (baseline === null) return null;
    }

    // Start from the baseline, drop what was removed, then overwrite what
    // changed. Every entry is cloned so stored snapshots never alias each other.
    const players = new Map<number, PlayerState>();
    if (baseline !== null) {
      for (const [id, state] of baseline.players) players.set(id, clonePlayer(state, id));
    }

    const round: RoundState = {
      phase: r.u8(),
      phaseTick: r.u32(),
      mapSeed: r.u32(),
      mapHash: r.u32(),
      stormPhase: r.u8(),
      stormX: r.f32(),
      stormZ: r.f32(),
      stormRadius: r.f32(),
      targetX: r.f32(),
      targetZ: r.f32(),
      targetRadius: r.f32(),
      stormWait: r.u16(),
      aliveCount: r.u8(),
      winnerId: r.u16(),
    };

    const removedCount = r.u8();
    for (let i = 0; i < removedCount; i++) players.delete(r.u16());

    const count = r.u16();
    for (let i = 0; i < count; i++) {
      const id = r.u16();
      const mask = r.u32();
      const prev = players.get(id);
      const state = prev === undefined ? createPlayerState(id) : prev;

      if ((mask & Field.PosX) !== 0) state.pos.x = r.f32();
      if ((mask & Field.PosY) !== 0) state.pos.y = r.f32();
      if ((mask & Field.PosZ) !== 0) state.pos.z = r.f32();
      if ((mask & Field.VelX) !== 0) state.vel.x = r.f32();
      if ((mask & Field.VelY) !== 0) state.vel.y = r.f32();
      if ((mask & Field.VelZ) !== 0) state.vel.z = r.f32();
      if ((mask & Field.Yaw) !== 0) state.yawQ = r.u16();
      if ((mask & Field.Pitch) !== 0) state.pitchQ = r.i16();
      if ((mask & Field.Flags) !== 0) state.flags = r.u8();
      if ((mask & Field.Health) !== 0) state.health = r.u8();
      if ((mask & Field.Shield) !== 0) state.shield = r.u8();
      if ((mask & Field.SinceGrounded) !== 0) state.sinceGrounded = r.u8();
      if ((mask & Field.Weapon) !== 0) state.weapon = r.u8();
      if ((mask & Field.Ammo) !== 0) state.ammo = r.u8();
      if ((mask & Field.Reload) !== 0) state.reload = r.u8();
      if ((mask & Field.Kills) !== 0) state.kills = r.u8();
      if ((mask & Field.Inventory) !== 0) {
        for (const stack of state.inventory) {
          stack.kind = r.u8();
          stack.rarity = r.u8();
          stack.count = r.u8();
        }
      }
      if ((mask & Field.Slot) !== 0) state.slot = r.u8();
      if ((mask & Field.Mode) !== 0) state.mode = r.u8();
      if ((mask & Field.Epoch) !== 0) state.epoch = r.u8();

      players.set(id, state);
    }

    const loot = new Map<number, LootItem>();
    if (baseline !== null) {
      for (const [id, item] of baseline.loot) loot.set(id, item);
    }
    const removedLoot = r.u16();
    for (let i = 0; i < removedLoot; i++) loot.delete(r.u16());
    const addedLoot = r.u16();
    for (let i = 0; i < addedLoot; i++) {
      const item: LootItem = {
        id: r.u16(),
        x: r.f32(),
        y: r.f32(),
        z: r.f32(),
        kind: r.u8(),
        rarity: r.u8(),
        count: r.u8(),
      };
      loot.set(item.id, item);
    }

    const events: GameEvent[] = [];
    const eventCount = r.u8();
    for (let i = 0; i < eventCount; i++) {
      const event = readEvent(r);
      if (event === null) break;
      events.push(event);
    }

    return { tick, lastProcessedSeq, players, loot, events, round };
  } catch {
    return null;
  }
}

function clonePlayer(src: PlayerState, id: number): PlayerState {
  const out = createPlayerState(id);
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
    const from = src.inventory[i]!;
    out.inventory[i] = { kind: from.kind, rarity: from.rarity, count: from.count };
  }
  out.slot = src.slot;
  out.mode = src.mode;
  out.epoch = src.epoch;
  return out;
}

// -------------------------------------------------------------------- decoding

/** Returns null for anything that is not a well-formed client message. */
export function decodeClientMessage(buffer: ArrayBuffer | Uint8Array): ClientMessage | null {
  try {
    const r = new BinaryReader(buffer);
    const type = r.u8();
    switch (type) {
      case MsgType.Join:
        return { type: MsgType.Join, protocolVersion: r.u8(), name: r.str() };
      case MsgType.Ping:
        return { type: MsgType.Ping, clientTime: r.f64() };
      case MsgType.Input: {
        const ackTick = r.u32();
        const baseSeq = r.u32();
        const count = r.u8();
        const commands: InputCommand[] = [];
        for (let i = 0; i < count; i++) {
          const buttons = r.u16();
          const yawQ = r.u16();
          const pitchQ = r.i16();
          const slot = r.u8();
          const renderTick =
            (buttons & Button.Fire) !== 0 ? r.u32() / RENDER_TICK_SCALE : 0;
          commands.push({ seq: baseSeq + i, buttons, yawQ, pitchQ, renderTick, slot });
        }
        return { type: MsgType.Input, ackTick, commands };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Returns null for anything that is not a well-formed server message. */
export function decodeServerMessage(buffer: ArrayBuffer | Uint8Array): ServerMessage | null {
  try {
    const r = new BinaryReader(buffer);
    const type = r.u8();
    switch (type) {
      case MsgType.Welcome:
        return {
          type: MsgType.Welcome,
          protocolVersion: r.u8(),
          playerId: r.u16(),
          mapSeed: r.u32(),
          mapHash: r.u32(),
          tickRate: r.u8(),
          tick: r.u32(),
          serverTime: r.f64(),
        };
      case MsgType.Pong:
        return {
          type: MsgType.Pong,
          clientTime: r.f64(),
          serverTime: r.f64(),
          tick: r.u32(),
        };
      case MsgType.Kick:
        return { type: MsgType.Kick, reason: r.u8() };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
