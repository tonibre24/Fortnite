import { BinaryReader, BinaryWriter } from './binary.js';
import { PROTOCOL_VERSION, TICK_RATE } from './constants.js';
import { createPlayerState, type InputCommand, type PlayerState } from './types.js';

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
  const w = new BinaryWriter(16 + commands.length * 5);
  w.u8(MsgType.Input);
  w.u32(ackTick >>> 0);
  w.u32(commands.length === 0 ? 0 : commands[0]!.seq >>> 0);
  w.u8(commands.length);
  for (const cmd of commands) {
    w.u8(cmd.buttons);
    w.u16(cmd.yawQ);
    w.i16(cmd.pitchQ);
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
} as const;

/** Velocity is only replicated to a player's own client, which needs it to predict. */
const SELF_ONLY_FIELDS = Field.VelX | Field.VelY | Field.VelZ;

const SNAPSHOT_FLAG_DELTA = 1 << 0;

export interface SnapshotBaseline {
  tick: number;
  players: ReadonlyMap<number, PlayerState>;
}

export interface DecodedSnapshot {
  tick: number;
  lastProcessedSeq: number;
  players: Map<number, PlayerState>;
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
): ArrayBuffer {
  const w = new BinaryWriter(64 + players.size * 40);
  w.u8(MsgType.Snapshot);
  w.u32(tick >>> 0);
  w.u8(baseline === null ? 0 : SNAPSHOT_FLAG_DELTA);
  w.u32(baseline === null ? 0 : baseline.tick >>> 0);
  w.u32(lastProcessedSeq >>> 0);

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
    w.u16(mask);
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
  }

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
    Field.SinceGrounded;
  return isSelf ? all : all & ~SELF_ONLY_FIELDS;
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
  return mask;
}

/**
 * Rebuilds a full player map from a snapshot packet. `lookupBaseline` returns
 * the client's stored state for a given tick; returning null (the client no
 * longer has that baseline) makes this return null so the caller can ignore the
 * packet and keep acknowledging the last tick it does have.
 */
export function decodeSnapshot(
  buffer: ArrayBuffer | Uint8Array,
  lookupBaseline: (tick: number) => ReadonlyMap<number, PlayerState> | null,
): DecodedSnapshot | null {
  try {
    const r = new BinaryReader(buffer);
    if (r.u8() !== MsgType.Snapshot) return null;
    const tick = r.u32();
    const flags = r.u8();
    const baselineTick = r.u32();
    const lastProcessedSeq = r.u32();

    let baseline: ReadonlyMap<number, PlayerState> | null = null;
    if ((flags & SNAPSHOT_FLAG_DELTA) !== 0) {
      baseline = lookupBaseline(baselineTick);
      if (baseline === null) return null;
    }

    // Start from the baseline, drop what was removed, then overwrite what
    // changed. Every entry is cloned so stored snapshots never alias each other.
    const players = new Map<number, PlayerState>();
    if (baseline !== null) {
      for (const [id, state] of baseline) players.set(id, clonePlayer(state, id));
    }

    const removedCount = r.u8();
    for (let i = 0; i < removedCount; i++) players.delete(r.u16());

    const count = r.u16();
    for (let i = 0; i < count; i++) {
      const id = r.u16();
      const mask = r.u16();
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

      players.set(id, state);
    }

    return { tick, lastProcessedSeq, players };
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
          commands.push({
            seq: baseSeq + i,
            buttons: r.u8(),
            yawQ: r.u16(),
            pitchQ: r.i16(),
          });
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
