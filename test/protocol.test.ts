import { describe, expect, it } from 'vitest';
import {
  KickReason,
  MsgType,
  PROTOCOL_VERSION,
  TICK_RATE,
  decodeClientMessage,
  decodeServerMessage,
  encodeJoin,
  encodeKick,
  encodePing,
  encodePong,
  encodeWelcome,
} from '@br/shared';

describe('protocol', () => {
  it('round-trips join', () => {
    const msg = decodeClientMessage(encodeJoin('tester'));
    expect(msg).toEqual({
      type: MsgType.Join,
      protocolVersion: PROTOCOL_VERSION,
      name: 'tester',
    });
  });

  it('round-trips ping and pong', () => {
    expect(decodeClientMessage(encodePing(1234.5))).toEqual({
      type: MsgType.Ping,
      clientTime: 1234.5,
    });
    expect(decodeServerMessage(encodePong(1234.5, 9999.25, 42))).toEqual({
      type: MsgType.Pong,
      clientTime: 1234.5,
      serverTime: 9999.25,
      tick: 42,
    });
  });

  it('round-trips welcome', () => {
    const msg = decodeServerMessage(encodeWelcome(7, 0xdeadbeef, 99, 1000));
    expect(msg).toEqual({
      type: MsgType.Welcome,
      protocolVersion: PROTOCOL_VERSION,
      playerId: 7,
      mapSeed: 0xdeadbeef,
      tickRate: TICK_RATE,
      tick: 99,
      serverTime: 1000,
    });
  });

  it('round-trips kick', () => {
    expect(decodeServerMessage(encodeKick(KickReason.ServerFull))).toEqual({
      type: MsgType.Kick,
      reason: KickReason.ServerFull,
    });
  });

  it('rejects unknown and truncated messages instead of throwing', () => {
    expect(decodeClientMessage(new Uint8Array([0x7f]))).toBeNull();
    expect(decodeServerMessage(new Uint8Array([0xff]))).toBeNull();
    // A ping header with no payload behind it.
    expect(decodeClientMessage(new Uint8Array([MsgType.Ping]))).toBeNull();
    expect(decodeClientMessage(new Uint8Array([]))).toBeNull();
  });
});
