import type { MatchPhase } from './match.js';

/**
 * Read-only structural views of the replicated Colyseus schema.
 *
 * The server owns the actual `Schema` classes. Clients receive the schema definition
 * through Colyseus reflection at handshake time, so at runtime they hold decoder-built
 * objects rather than the server's classes. These interfaces describe that shape once,
 * giving the client full type safety without importing server code — and the `readonly`
 * markers document that replicated state is never client-mutable.
 */

export interface PlayerView {
  readonly id: string;
  readonly displayName: string;

  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;

  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly grounded: boolean;

  readonly health: number;
  readonly shield: number;
  readonly alive: boolean;

  readonly weaponId: string;
  readonly magazine: number;
  readonly reserve: number;
  readonly reloading: boolean;
  readonly reloadEndsAtMs: number;

  readonly kills: number;
  readonly deaths: number;
  readonly damageDealt: number;
  readonly ping: number;

  readonly moving: boolean;
  readonly sprinting: boolean;
  readonly aiming: boolean;

  readonly respawnAtMs: number;
  readonly spawnProtectedUntilMs: number;
  readonly lastProcessedInputSeq: number;
}

/** The subset of Colyseus' MapSchema the client actually relies on. */
export interface MapView<T> {
  readonly size: number;
  get(key: string): T | undefined;
  forEach(callback: (value: T, key: string) => void): void;
  entries(): IterableIterator<[string, T]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<T>;
}

export interface MatchStateView {
  readonly roomCode: string;
  readonly arenaName: string;
  /** Always one of the MatchPhase values; the server is the only writer. */
  readonly phase: MatchPhase;
  readonly phaseEndsAtMs: number;
  readonly serverTimeMs: number;

  readonly scoreLimit: number;
  readonly maxPlayers: number;
  readonly minPlayers: number;
  readonly matchDurationMs: number;

  readonly winnerId: string;
  readonly winnerName: string;

  readonly players: MapView<PlayerView>;
}

/** Convenience: snapshot the replicated player map into a plain array. */
export function playersToArray(state: MatchStateView): PlayerView[] {
  const result: PlayerView[] = [];
  state.players.forEach((player) => result.push(player));
  return result;
}
