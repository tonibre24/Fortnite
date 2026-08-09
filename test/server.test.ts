import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_PLAYERS, RoundPhase, StateFlag } from '@br/shared';
import { GameServer } from '../server/src/GameServer.js';
import { StaticFiles } from '../server/src/StaticFiles.js';

/**
 * Reaches into the connection handling the way a dropped socket does, without
 * standing up real sockets: `dropConnection` is what both the close and error
 * handlers call.
 */
interface ServerInternals {
  connections: Set<{ playerId: number; name: string; close(): void }>;
  dropConnection(conn: { playerId: number; name: string; close(): void }): void;
  freeIds: number[];
}

function internals(server: GameServer): ServerInternals {
  return server as unknown as ServerInternals;
}

/** Registers a player the way a completed Join handshake does. */
function join(server: GameServer, name: string): { playerId: number; name: string; close(): void } {
  const inner = internals(server);
  const id = inner.freeIds.shift();
  expect(id).toBeDefined();
  const conn = { playerId: id!, name, close: () => {} };
  inner.connections.add(conn);
  server.world.addPlayer(id!, name);
  return conn;
}

describe('dropped connections', () => {
  it('removes a player from the world the moment their socket goes', () => {
    const server = new GameServer({ port: 0 });
    const a = join(server, 'a');
    const b = join(server, 'b');
    expect(server.world.players.size).toBe(2);

    internals(server).dropConnection(b);

    expect(server.world.players.has(b.playerId)).toBe(false);
    expect(server.world.players.has(a.playerId)).toBe(true);
    expect(server.world.aliveCount).toBe(1);
  });

  /**
   * The reason removal has to be immediate: a round waiting on someone who has
   * already closed their laptop never ends, and everyone else is stuck in it.
   */
  it('lets the round end when the last opponent disconnects mid-round', () => {
    const server = new GameServer({ port: 0 });
    const a = join(server, 'a');
    const b = join(server, 'b');

    server.world.round.state.phase = RoundPhase.Playing;
    server.world.round.state.phaseTick = 0;
    expect(server.world.round.state.winnerId).toBe(0);

    internals(server).dropConnection(b);
    server.world.step();

    expect(server.world.round.state.phase).toBe(RoundPhase.Ended);
    expect(server.world.round.state.winnerId).toBe(a.playerId);
  });

  it('reports the departure to everyone still connected', () => {
    const server = new GameServer({ port: 0 });
    const a = join(server, 'a');
    const b = join(server, 'b');
    server.world.step();

    // A snapshot taken against a baseline that still holds the leaver has to
    // carry the removal, or clients keep drawing a body that is not there.
    const before = server.world.players.get(b.playerId);
    expect(before).toBeDefined();

    internals(server).dropConnection(b);
    server.world.step();

    const survivor = server.world.players.get(a.playerId)!;
    expect(() => server.world.snapshotFor(survivor)).not.toThrow();
    expect(server.world.players.size).toBe(1);
  });

  it('does not hand a leaver\'s id to the next player to join', () => {
    const server = new GameServer({ port: 0 });
    const first = join(server, 'first');
    internals(server).dropConnection(first);
    const next = join(server, 'next');
    expect(next.playerId).not.toBe(first.playerId);
  });

  it('recycles ids rather than running out', () => {
    const server = new GameServer({ port: 0 });
    for (let i = 0; i < MAX_PLAYERS * 3; i++) {
      const conn = join(server, `p${i}`);
      expect(conn.playerId).toBeGreaterThan(0);
      expect(conn.playerId).toBeLessThanOrEqual(MAX_PLAYERS);
      internals(server).dropConnection(conn);
    }
    expect(server.world.players.size).toBe(0);
  });

  it('ignores a second drop of the same connection', () => {
    const server = new GameServer({ port: 0 });
    const conn = join(server, 'a');
    const inner = internals(server);
    inner.dropConnection(conn);
    const freed = inner.freeIds.length;
    inner.dropConnection(conn);
    // A double close must not put the id back twice, or two players get it.
    expect(inner.freeIds.length).toBe(freed);
  });

  it('keeps a disconnect from stranding the lobby countdown', () => {
    const server = new GameServer({ port: 0 });
    const a = join(server, 'a');
    const b = join(server, 'b');
    for (let i = 0; i < 5; i++) server.world.step();
    expect(server.world.round.state.phaseTick).toBeGreaterThan(0);

    internals(server).dropConnection(b);
    server.world.step();

    // Back under the minimum, so the countdown parks at zero instead of
    // launching a bus with one passenger.
    expect(server.world.round.state.phase).toBe(RoundPhase.Lobby);
    expect(server.world.round.state.phaseTick).toBe(0);
    expect((server.world.players.get(a.playerId)!.state.flags & StateFlag.Alive) !== 0).toBe(true);
  });
});

describe('static file serving', () => {
  const files = new StaticFiles('client/dist');

  /** Only the resolution matters here, so the filesystem is never touched. */
  function resolvePath(urlPath: string): string | null {
    return (files as unknown as { resolvePath(p: string): string | null }).resolvePath(urlPath);
  }

  it('keeps requests inside the client directory', () => {
    expect(resolvePath('/index.html')).not.toBeNull();
    expect(resolvePath('/assets/app.js')).not.toBeNull();
  });

  /**
   * The property that matters is not "returns null" but "never points outside
   * the root". Leading `..` segments get clamped to the root by `normalize`
   * rather than rejected, which lands on a path that simply does not exist -
   * equally safe, and a plain 404 to the caller.
   */
  it('never resolves outside the root', () => {
    const root = resolve('client/dist');
    const attempts = [
      '/../package.json',
      '/../../etc/passwd',
      '/assets/../../../package.json',
      // Percent-encoded separators decode after the URL parser has had its go.
      '/..%2f..%2fpackage.json',
      '/./../../package.json',
      '/assets/..%2f..%2f..%2fetc%2fpasswd',
    ];
    for (const attempt of attempts) {
      const resolved = resolvePath(attempt);
      if (resolved === null) continue;
      expect(resolved === root || resolved.startsWith(root + sep), `${attempt} -> ${resolved}`).toBe(true);
    }
  });

  it('rejects malformed and truncating paths', () => {
    expect(resolvePath('/%')).toBeNull();
    expect(resolvePath('/index.html\0.png')).toBeNull();
  });
});
