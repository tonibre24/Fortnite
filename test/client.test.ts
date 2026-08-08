import { describe, expect, it } from 'vitest';
import {
  Button,
  TICK_MS,
  createPlayerState,
  encodeSnapshot,
  encodeWelcome,
  generateMap,
  hashMap,
  quantizeYaw,
  type PlayerState,
} from '@br/shared';
import { GameClient, type InputSample, type InputSource } from '../client/src/game/GameClient.js';
import type { SocketLike } from '../client/src/net/Connection.js';

const SEED = 0x5eed1234;

/** A socket that goes nowhere, so packets can be fed in by hand. */
class FakeSocket implements SocketLike {
  binaryType = 'arraybuffer';
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: ArrayBuffer[] = [];

  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  deliver(data: ArrayBuffer): void {
    this.onmessage?.({ data });
  }
}

class HeldInput implements InputSource {
  constructor(private readonly buttons: number) {}
  sample(): InputSample {
    return { buttons: this.buttons, yawQ: quantizeYaw(0), pitchQ: 0 };
  }
}

function setup(): { client: GameClient; socket: FakeSocket; state: PlayerState } {
  let socket: FakeSocket | null = null;
  const client = new GameClient({
    url: 'ws://fake',
    name: 'test',
    input: new HeldInput(Button.Forward),
    createSocket: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
  client.connect();
  socket!.onopen?.();

  const map = generateMap(SEED);
  socket!.deliver(encodeWelcome(1, SEED, hashMap(map), 10, 0));

  const state = createPlayerState(1);
  state.pos.x = map.spawns[0]!.pos.x;
  state.pos.y = map.spawns[0]!.pos.y;
  state.pos.z = map.spawns[0]!.pos.z;
  return { client, socket: socket!, state };
}

function snapshot(tick: number, state: PlayerState, lastProcessedSeq: number): ArrayBuffer {
  return encodeSnapshot(tick, new Map([[state.id, state]]), null, state.id, lastProcessedSeq);
}

/** Runs enough wall-clock time through the client to produce `ticks` commands. */
function advance(client: GameClient, ticks: number, from = 0): number {
  let now = from;
  client.update(now);
  for (let i = 0; i < ticks; i++) {
    now += TICK_MS;
    client.update(now);
  }
  return now;
}

describe('GameClient', () => {
  it('builds the map from the seed and checks it against the server', () => {
    const { client } = setup();
    expect(client.map).not.toBeNull();
    expect(client.mapHashMatches).toBe(true);
  });

  it('notices when its map does not match the server', () => {
    let socket: FakeSocket | null = null;
    const client = new GameClient({
      url: 'ws://fake',
      name: 'test',
      input: new HeldInput(0),
      createSocket: () => {
        socket = new FakeSocket();
        return socket;
      },
    });
    client.connect();
    socket!.onopen?.();
    socket!.deliver(encodeWelcome(1, SEED, 0xdeadbeef, 1, 0));
    expect(client.mapHashMatches).toBe(false);
  });

  it('sends no input until the server has told it where it is', () => {
    const { client, socket } = setup();
    socket.sent.length = 0;
    advance(client, 5);
    expect(socket.sent.length).toBe(0);
    expect(client.ready).toBe(false);
  });

  it('predicts locally and sends input once it has a spawn', () => {
    const { client, socket, state } = setup();
    socket.deliver(snapshot(11, state, 0));
    expect(client.ready).toBe(true);

    socket.sent.length = 0;
    advance(client, 4);
    expect(socket.sent.length).toBe(4);
    expect(client.predictor.pending.length).toBe(4);
    // Held forward with yaw 0 means travelling towards -Z.
    expect(client.predictor.state.pos.z).toBeLessThan(state.pos.z);
  });

  /**
   * A stale snapshot rewinds the server's acknowledged input sequence, which
   * silently drops a command out of the replay queue and leaves prediction a
   * tick adrift for the rest of the session. The sim caught this happening for
   * real; this pins it down.
   */
  it('ignores a snapshot older than one it already applied', () => {
    const { client, socket, state } = setup();
    socket.deliver(snapshot(11, state, 0));
    const now = advance(client, 4);

    socket.deliver(snapshot(12, state, 2));
    expect(client.predictor.pending.map((c) => c.seq)).toEqual([3, 4]);

    // Same player state, but an older tick claiming less input was processed.
    socket.deliver(snapshot(11, state, 0));
    expect(client.snapshotsStale).toBe(1);
    expect(client.predictor.pending.map((c) => c.seq)).toEqual([3, 4]);

    // And the client keeps working afterwards.
    advance(client, 2, now);
    expect(client.predictor.pending.map((c) => c.seq)).toEqual([3, 4, 5, 6]);
  });

  it('replays only unacknowledged input after a snapshot', () => {
    const { client, socket, state } = setup();
    socket.deliver(snapshot(11, state, 0));
    advance(client, 6);
    expect(client.predictor.pending.length).toBe(6);

    socket.deliver(snapshot(12, state, 4));
    expect(client.predictor.pending.map((c) => c.seq)).toEqual([5, 6]);
  });

  it('caps how far it will catch up after a long stall', () => {
    const { client, socket, state } = setup();
    socket.deliver(snapshot(11, state, 0));
    client.update(0);
    // Simulate a backgrounded tab: ten seconds with no frames at all.
    client.update(10_000);
    expect(client.predictor.pending.length).toBeLessThanOrEqual(5);
  });
});
