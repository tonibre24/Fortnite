import { describe, expect, it } from 'vitest';
import {
  Field,
  MsgType,
  clonePlayerState,
  createPlayerState,
  decodeClientMessage,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
  type PlayerState,
} from '@br/shared';

function player(id: number, x: number, y = 0, z = 0): PlayerState {
  const state = createPlayerState(id);
  state.pos.x = x;
  state.pos.y = y;
  state.pos.z = z;
  state.vel.x = x / 2;
  state.yawQ = (id * 1000) & 0xffff;
  state.pitchQ = id * -700;
  state.health = 100 - id;
  state.shield = id * 2;
  state.sinceGrounded = id;
  return state;
}

function snapshot(players: PlayerState[]): Map<number, PlayerState> {
  return new Map(players.map((p) => [p.id, p]));
}

const noBaseline = (): null => null;

describe('snapshot encoding', () => {
  it('round-trips a full snapshot', () => {
    const state = snapshot([player(1, 10), player(2, -20, 3, 4)]);
    const decoded = decodeSnapshot(encodeSnapshot(7, state, null, 1, 42), noBaseline);

    expect(decoded).not.toBeNull();
    expect(decoded!.tick).toBe(7);
    expect(decoded!.lastProcessedSeq).toBe(42);
    expect(decoded!.players.get(1)).toEqual(state.get(1));
  });

  it('only replicates velocity to the player it belongs to', () => {
    const state = snapshot([player(1, 10), player(2, -20)]);
    const decoded = decodeSnapshot(encodeSnapshot(1, state, null, 1, 0), noBaseline)!;

    expect(decoded.players.get(1)!.vel.x).toBe(5);
    // Player 2's velocity is nobody else's business - it is not on the wire.
    expect(decoded.players.get(2)!.vel.x).toBe(0);
    expect(decoded.players.get(2)!.pos.x).toBe(-20);
  });

  it('carries unchanged players forward without sending them', () => {
    const first = snapshot([player(1, 10), player(2, -20)]);
    const baseline = { tick: 1, players: first };

    const second = snapshot([player(1, 11), clonePlayerState(first.get(2)!)]);
    const delta = encodeSnapshot(2, second, baseline, 1, 5);
    const full = encodeSnapshot(2, second, null, 1, 5);
    expect(delta.byteLength).toBeLessThan(full.byteLength);

    const decoded = decodeSnapshot(delta, (tick) => (tick === 1 ? first : null))!;
    expect(decoded.players.get(1)!.pos.x).toBe(11);
    expect(decoded.players.get(2)!.pos.x).toBe(-20);
  });

  it('sends nothing but headers when nobody moved', () => {
    const state = snapshot([player(1, 10), player(2, -20)]);
    const baseline = { tick: 1, players: state };
    const delta = encodeSnapshot(2, state, baseline, 1, 5);
    // type + tick + flags + baseline + seq + removedCount + playerCount
    expect(delta.byteLength).toBe(1 + 4 + 1 + 4 + 4 + 1 + 2);
  });

  it('removes players that left', () => {
    const first = snapshot([player(1, 10), player(2, -20)]);
    const second = snapshot([first.get(1)!]);
    const decoded = decodeSnapshot(
      encodeSnapshot(2, second, { tick: 1, players: first }, 1, 0),
      (tick) => (tick === 1 ? first : null),
    )!;
    expect([...decoded.players.keys()]).toEqual([1]);
  });

  it('reports failure when the baseline is gone instead of decoding garbage', () => {
    const first = snapshot([player(1, 10)]);
    const second = snapshot([player(1, 11)]);
    const delta = encodeSnapshot(2, second, { tick: 1, players: first }, 1, 0);
    expect(decodeSnapshot(delta, noBaseline)).toBeNull();
  });

  it('never lets decoded snapshots alias each other', () => {
    const first = snapshot([player(1, 10)]);
    const decodedFirst = decodeSnapshot(encodeSnapshot(1, first, null, 1, 0), noBaseline)!;

    const second = snapshot([player(1, 99)]);
    const decodedSecond = decodeSnapshot(
      encodeSnapshot(2, second, { tick: 1, players: first }, 1, 0),
      () => decodedFirst.players,
    )!;

    expect(decodedSecond.players.get(1)!.pos.x).toBe(99);
    // The stored baseline must not have been mutated by decoding the delta.
    expect(decodedFirst.players.get(1)!.pos.x).toBe(10);
  });

  it('marks every field on a player the baseline has never seen', () => {
    const first = snapshot([player(1, 10)]);
    const second = snapshot([first.get(1)!, player(2, 5, 6, 7)]);
    const decoded = decodeSnapshot(
      encodeSnapshot(2, second, { tick: 1, players: first }, 1, 0),
      (tick) => (tick === 1 ? first : null),
    )!;
    const joined = decoded.players.get(2)!;
    expect(joined.pos).toEqual({ x: 5, y: 6, z: 7 });
    expect(joined.health).toBe(98);
    expect(joined.shield).toBe(4);
    expect(joined.sinceGrounded).toBe(2);
  });

  it('exposes distinct bits for every replicated field', () => {
    const bits = Object.values(Field);
    expect(new Set(bits).size).toBe(bits.length);
    // The mask is written as a u16.
    expect(Math.max(...bits)).toBeLessThan(1 << 16);
  });
});

describe('input encoding', () => {
  it('round-trips a batch with implied consecutive sequence numbers', () => {
    const commands = [
      { seq: 100, buttons: 3, yawQ: 1234, pitchQ: -30000 },
      { seq: 101, buttons: 0, yawQ: 5, pitchQ: 6 },
      { seq: 102, buttons: 255, yawQ: 65535, pitchQ: 32767 },
    ];
    const msg = decodeClientMessage(encodeInput(commands, 77));
    expect(msg).toEqual({ type: MsgType.Input, ackTick: 77, commands });
  });

  it('costs five bytes per extra command', () => {
    const one = encodeInput([{ seq: 1, buttons: 0, yawQ: 0, pitchQ: 0 }], 0).byteLength;
    const two = encodeInput(
      [
        { seq: 1, buttons: 0, yawQ: 0, pitchQ: 0 },
        { seq: 2, buttons: 0, yawQ: 0, pitchQ: 0 },
      ],
      0,
    ).byteLength;
    expect(two - one).toBe(5);
  });
});
