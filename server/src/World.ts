import {
  EventType,
  INPUT_STARVE_GRACE_TICKS,
  SNAPSHOT_HISTORY,
  StateFlag,
  TICK_DT,
  clonePlayerState,
  encodeSnapshot,
  generateMap,
  hashMap,
  idleCommand,
  lerp,
  packWeapon,
  stepMovement,
  weaponStats,
  type GameEvent,
  type GameMap,
  type PlayerState,
  type SnapshotBaseline,
  type Vec3,
} from '@br/shared';
import { resolveWeapon } from './Combat.js';
import { ServerPlayer } from './ServerPlayer.js';

/** An event plus who is allowed to see it; zero means everyone. */
interface AddressedEvent {
  event: GameEvent;
  only: number;
}

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
  /** Kills resolved so far, for the sim report. */
  killCount = 0;

  private readonly history: HistoryEntry[] = [];
  private readonly events: AddressedEvent[] = [];
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
    this.equipStarterWeapon(player);
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
  }

  /**
   * Every player starts armed so combat is playable before loot exists. Phase
   * four replaces this with what they pick up.
   */
  private equipStarterWeapon(player: ServerPlayer): void {
    const cls = player.id % 4;
    player.state.weapon = packWeapon(cls, 0);
    player.state.ammo = weaponStats(cls).magazine;
  }

  /** Queues an event for delivery with this tick's snapshots. */
  pushEvent(event: GameEvent, only: number): void {
    this.events.push({ event, only });
  }

  /**
   * Where a player was at a fractional tick in the past, interpolated between
   * recorded snapshots. This is the whole of lag compensation: the shooter's
   * shot is tested against these positions rather than the current ones.
   * Returns false when the tick is older than the history ring.
   */
  positionAt(id: number, tick: number, out: Vec3): boolean {
    const live = this.players.get(id);
    if (live === undefined) return false;

    const useLive = (): boolean => {
      out.x = live.state.pos.x;
      out.y = live.state.pos.y;
      out.z = live.state.pos.z;
      return true;
    };

    if (tick >= this.tick) return useLive();

    const lower = Math.floor(tick);
    const a = this.stateAt(lower, id);
    const b = this.stateAt(lower + 1, id);
    // No history that far back - resolve against the present rather than
    // silently dropping the target out of the shot.
    if (a === null && b === null) return useLive();
    if (a === null || b === null) {
      const only = (a ?? b)!;
      out.x = only.pos.x;
      out.y = only.pos.y;
      out.z = only.pos.z;
      return true;
    }
    const t = tick - lower;
    out.x = lerp(a.pos.x, b.pos.x, t);
    out.y = lerp(a.pos.y, b.pos.y, t);
    out.z = lerp(a.pos.z, b.pos.z, t);
    return true;
  }

  private stateAt(tick: number, id: number): PlayerState | null {
    if (tick <= 0) return null;
    const entry = this.history[((tick % SNAPSHOT_HISTORY) + SNAPSHOT_HISTORY) % SNAPSHOT_HISTORY]!;
    if (entry.tick !== tick) return null;
    return entry.players.get(id) ?? null;
  }

  /** Marks a player dead. They stay in the world as a spectator. */
  killPlayer(victim: ServerPlayer, killer: ServerPlayer | null): void {
    if ((victim.state.flags & StateFlag.Alive) === 0) return;
    victim.state.flags &= ~StateFlag.Alive;
    victim.state.health = 0;
    victim.state.shield = 0;
    victim.state.reload = 0;
    victim.diedAtTick = this.tick;
    victim.killedBy = killer?.id ?? 0;
    if (killer !== null && killer !== victim) killer.state.kills += 1;
    this.killCount += 1;

    this.pushEvent(
      {
        type: EventType.Kill,
        killerId: killer?.id ?? 0,
        victimId: victim.id,
        weapon: killer?.state.weapon ?? 0,
      },
      0,
    );
  }

  get aliveCount(): number {
    let alive = 0;
    for (const p of this.players.values()) {
      if ((p.state.flags & StateFlag.Alive) !== 0) alive += 1;
    }
    return alive;
  }

  /** Advances the simulation by exactly one tick and records the result. */
  step(): void {
    this.tick += 1;
    this.events.length = 0;

    for (const player of this.players.values()) {
      player.refillCredit();

      let processed = 0;
      player.resolvedCommands.length = 0;
      for (;;) {
        const cmd = player.takeCommand();
        if (cmd === undefined) break;
        stepMovement(player.state, cmd, this.map.world, TICK_DT);
        player.resolvedCommands.push(cmd);
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
        player.resolvedCommands.push(cmd);
        this.starvationSteps += 1;
      }
    }

    // Record before combat so a shot can be rewound to this very tick, and so
    // that everybody has already moved: whose command happened to be processed
    // first must not decide who wins a trade.
    this.record();

    for (const player of this.players.values()) {
      for (const cmd of player.resolvedCommands) resolveWeapon(this, player, cmd);
      player.resolvedCommands.length = 0;
    }
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

  private readonly visibleEvents: GameEvent[] = [];

  /** Encodes this tick's state as a delta against whatever `player` last acked. */
  snapshotFor(player: ServerPlayer): ArrayBuffer {
    this.liveStates.clear();
    for (const [id, p] of this.players) this.liveStates.set(id, p.state);

    this.visibleEvents.length = 0;
    for (const addressed of this.events) {
      if (addressed.only === 0 || addressed.only === player.id) {
        this.visibleEvents.push(addressed.event);
      }
    }

    return encodeSnapshot(
      this.tick,
      this.liveStates,
      this.baselineAt(player.ackedTick),
      player.id,
      player.lastProcessedSeq,
      this.visibleEvents,
    );
  }
}
