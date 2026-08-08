import {
  INPUT_STARVE_GRACE_TICKS,
  SNAPSHOT_HISTORY,
  TICK_DT,
  clonePlayerState,
  encodeSnapshot,
  generateMap,
  hashMap,
  idleCommand,
  stepMovement,
  type GameMap,
  type PlayerState,
  type SnapshotBaseline,
} from '@br/shared';
import { ServerPlayer } from './ServerPlayer.js';

interface HistoryEntry {
  tick: number;
  players: Map<number, PlayerState>;
}

/**
 * The authoritative simulation. Owns the map, the players and a ring of past
 * states used both as delta baselines and (later) for lag-compensated hitscan.
 */
export class World {
  readonly map: GameMap;
  /** Sent in the welcome packet so clients can prove they built the same map. */
  readonly mapHash: number;
  readonly players = new Map<number, ServerPlayer>();
  tick = 0;

  /**
   * Times the server had to simulate a player idle because their input never
   * arrived. Each one is a real divergence from that client's prediction, so
   * this is the number to watch when reconciliation error is not zero.
   */
  starvationSteps = 0;

  private readonly history: HistoryEntry[] = [];
  private spawnCursor = 0;

  constructor(seed: number) {
    this.map = generateMap(seed);
    this.mapHash = hashMap(this.map);
    for (let i = 0; i < SNAPSHOT_HISTORY; i++) {
      this.history.push({ tick: -1, players: new Map() });
    }
  }

  addPlayer(id: number, name: string): ServerPlayer {
    const spawn = this.map.spawns[this.spawnCursor % this.map.spawns.length]!;
    this.spawnCursor += 1;
    const player = new ServerPlayer(id, name, spawn);
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
  }

  /** Advances the simulation by exactly one tick and records the result. */
  step(): void {
    this.tick += 1;

    for (const player of this.players.values()) {
      player.refillCredit();

      let processed = 0;
      for (;;) {
        const cmd = player.takeCommand();
        if (cmd === undefined) break;
        stepMovement(player.state, cmd, this.map.world, TICK_DT);
        processed += 1;
      }

      if (processed > 0) {
        player.starvedTicks = 0;
        continue;
      }

      // No input this tick. A brief gap is jitter and the player simply holds
      // position, which keeps prediction exact. A long gap means the client is
      // gone or hitching, so simulate them idle rather than leaving them frozen
      // mid-air; the client corrects itself when it comes back.
      player.starvedTicks += 1;
      if (player.starvedTicks > INPUT_STARVE_GRACE_TICKS) {
        const cmd = idleCommand(player.lastProcessedSeq, player.state.yawQ, player.state.pitchQ);
        stepMovement(player.state, cmd, this.map.world, TICK_DT);
        this.starvationSteps += 1;
      }
    }

    this.record();
  }

  private record(): void {
    const entry = this.history[this.tick % SNAPSHOT_HISTORY]!;
    entry.tick = this.tick;
    entry.players.clear();
    for (const [id, player] of this.players) {
      entry.players.set(id, clonePlayerState(player.state));
    }
  }

  /** The recorded state at `tick`, or null once it has aged out of the ring. */
  baselineAt(tick: number): SnapshotBaseline | null {
    if (tick <= 0) return null;
    const entry = this.history[tick % SNAPSHOT_HISTORY]!;
    if (entry.tick !== tick) return null;
    return entry;
  }

  private readonly liveStates = new Map<number, PlayerState>();

  /** Encodes this tick's state as a delta against whatever `player` last acked. */
  snapshotFor(player: ServerPlayer): ArrayBuffer {
    this.liveStates.clear();
    for (const [id, p] of this.players) this.liveStates.set(id, p.state);
    return encodeSnapshot(
      this.tick,
      this.liveStates,
      this.baselineAt(player.ackedTick),
      player.id,
      player.lastProcessedSeq,
    );
  }
}
