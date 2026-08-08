import { BinaryReader, BinaryWriter } from './binary.js';
import { PROTOCOL_VERSION, TICK_RATE } from './constants.js';

/** Message type tags. Client messages are < 0x80, server messages >= 0x80. */
export const MsgType = {
  Join: 0x01,
  Ping: 0x03,

  Welcome: 0x81,
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

export type ClientMessage = JoinMsg | PingMsg;

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

// ------------------------------------------------------------- server -> client

export interface WelcomeMsg {
  type: typeof MsgType.Welcome;
  protocolVersion: number;
  playerId: number;
  mapSeed: number;
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
  tick: number,
  serverTime: number,
): ArrayBuffer {
  const w = new BinaryWriter(32);
  w.u8(MsgType.Welcome);
  w.u8(PROTOCOL_VERSION);
  w.u16(playerId);
  w.u32(mapSeed >>> 0);
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
