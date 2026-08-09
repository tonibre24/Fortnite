import {
  CLIENT_MAX_CATCHUP_TICKS,
  EXTRAPOLATION_LIMIT_MS,
  INPUT_REDUNDANCY,
  INTERP_DELAY_MS,
  SNAPSHOT_BUFFER_SIZE,
  TICK_MS,
  decodeSnapshot,
  generateMap,
  hashMap,
  peekSnapshotTick,
  StateFlag,
  type GameEvent,
  type ClientBaseline,
  type GameMap,
  type InputCommand,
  type LootItem,
  type WelcomeMsg,
} from '@br/shared';
import { Connection, type ConnectionStatus, type SocketLike } from '../net/Connection.js';
import { Predictor } from './Predictor.js';
import { RemoteInterpolator, type RenderedRemote } from './RemoteInterpolator.js';

/** Events are dropped rather than queued forever if nothing drains them. */
const MAX_BUFFERED_EVENTS = 256;
const EMPTY_EVENTS: GameEvent[] = [];

/** What the local player is doing this tick. Produced by keyboard/mouse or by a bot. */
export interface InputSample {
  buttons: number;
  yawQ: number;
  pitchQ: number;
  /** Inventory slot the player wants in hand. */
  slot: number;
}

export interface InputSource {
  sample(): InputSample;
  /**
   * Called once the server's spawn state arrives, so the player's look
   * direction starts where the server put it instead of snapping to zero on
   * the very first command.
   */
  adoptLook?(yawQ: number, pitchQ: number): void;
}

export interface GameClientOptions {
  url: string;
  name: string;
  input: InputSource;
  /** >1 compresses wall-clock time; the simulation step is always TICK_DT. */
  timeScale?: number;
  createSocket?: (url: string) => SocketLike;
  onStatus?: (status: ConnectionStatus, detail: string) => void;
}

/**
 * The whole client game loop with no DOM or WebGL in sight, so the headless sim
 * harness can run the real thing rather than an approximation of it.
 */
export class GameClient {
  readonly connection: Connection;
  readonly predictor = new Predictor();
  readonly remotes = new Map<number, RenderedRemote>();

  map: GameMap | null = null;
  mapHashMatches = true;
  /** Fraction between the previous and current predicted tick, for rendering. */
  alpha = 0;
  snapshotsReceived = 0;
  snapshotsDropped = 0;
  /** Packets discarded for being older than one already applied. */
  snapshotsStale = 0;
  /**
   * Events from the latest snapshots, drained by whoever is presenting them.
   * Kept bounded so a host that never drains cannot grow this without limit.
   */
  readonly events: GameEvent[] = [];
  /** Everything currently lying in the world, straight from the last snapshot. */
  loot: ReadonlyMap<number, LootItem> = new Map();

  private readonly interpolator: RemoteInterpolator;
  private readonly input: InputSource;
  private readonly timeScale: number;
  private readonly tickMs: number;
  private readonly snapshots = new Map<number, ClientBaseline>();
  private accumulator = 0;
  private lastUpdate = 0;
  private hasLastUpdate = false;
  private seq = 0;
  private ackTick = 0;
  private lastAppliedTick = 0;

  constructor(options: GameClientOptions) {
    this.input = options.input;
    this.timeScale = options.timeScale ?? 1;
    this.tickMs = TICK_MS / this.timeScale;
    this.interpolator = new RemoteInterpolator(
      this.tickMs,
      INTERP_DELAY_MS / this.timeScale,
      EXTRAPOLATION_LIMIT_MS / this.timeScale,
    );

    this.connection = new Connection({
      url: options.url,
      name: options.name,
      timeScale: this.timeScale,
      ...(options.createSocket !== undefined ? { createSocket: options.createSocket } : {}),
      handlers: {
        ...(options.onStatus !== undefined ? { onStatus: options.onStatus } : {}),
        onWelcome: (msg) => this.onWelcome(msg),
        onSnapshot: (data) => this.onSnapshot(data),
      },
    });
  }

  get playerId(): number {
    return this.connection.playerId;
  }

  get ready(): boolean {
    return this.map !== null && this.predictor.initialized;
  }

  get alive(): boolean {
    return (this.predictor.state.flags & StateFlag.Alive) !== 0;
  }

  /** Everyone the server still lists, including the local player. */
  get playerCount(): number {
    return this.remotes.size + (this.ready ? 1 : 0);
  }

  /** Removes and returns everything queued since the last call. */
  drainEvents(): GameEvent[] {
    if (this.events.length === 0) return EMPTY_EVENTS;
    return this.events.splice(0, this.events.length);
  }

  connect(): void {
    this.connection.connect();
  }

  disconnect(): void {
    this.connection.close();
  }

  private onWelcome(msg: WelcomeMsg): void {
    this.map = generateMap(msg.mapSeed);
    this.predictor.state.id = msg.playerId;
    // If this ever fails the two sides are simulating different worlds and
    // every prediction from here on would be wrong.
    this.mapHashMatches = hashMap(this.map) === msg.mapHash;
  }

  private onSnapshot(data: ArrayBuffer): void {
    const map = this.map;
    if (map === null) return;

    // Never apply a snapshot older than one already applied. The server's
    // acknowledged input sequence only ever moves forward, so accepting a stale
    // packet would rewind it, drop a command out of the replay queue, and leave
    // prediction permanently a tick adrift.
    const tick = peekSnapshotTick(data);
    if (tick === null) return;
    if (tick <= this.lastAppliedTick) {
      this.snapshotsStale += 1;
      return;
    }

    const decoded = decodeSnapshot(data, (t) => this.snapshots.get(t) ?? null);
    if (decoded === null) {
      // The baseline aged out of our buffer. Keep acknowledging the last tick we
      // do have; the server will re-send a full snapshot against it or from
      // scratch.
      this.snapshotsDropped += 1;
      return;
    }

    this.snapshotsReceived += 1;
    this.lastAppliedTick = decoded.tick;
    this.snapshots.set(decoded.tick, { players: decoded.players, loot: decoded.loot });
    this.loot = decoded.loot;
    this.trimSnapshots(decoded.tick);
    this.ackTick = decoded.tick;

    for (const event of decoded.events) this.events.push(event);
    while (this.events.length > MAX_BUFFERED_EVENTS) this.events.shift();

    const self = decoded.players.get(this.connection.playerId);
    if (self !== undefined) {
      const first = !this.predictor.initialized;
      this.predictor.reconcile(self, decoded.lastProcessedSeq, map.world);
      if (first) this.input.adoptLook?.(self.yawQ, self.pitchQ);
    }

    this.interpolator.add(decoded.tick, decoded.players, performance.now());
  }

  private trimSnapshots(newestTick: number): void {
    if (this.snapshots.size <= SNAPSHOT_BUFFER_SIZE) return;
    const cutoff = newestTick - SNAPSHOT_BUFFER_SIZE;
    for (const tick of this.snapshots.keys()) {
      if (tick <= cutoff) this.snapshots.delete(tick);
    }
  }

  /**
   * Drives the fixed-step simulation from whatever clock the host provides
   * (requestAnimationFrame in the browser, a timer in the sim).
   */
  update(nowMs: number): void {
    if (!this.hasLastUpdate) {
      this.lastUpdate = nowMs;
      this.hasLastUpdate = true;
      return;
    }
    const frameMs = Math.max(0, nowMs - this.lastUpdate);
    this.lastUpdate = nowMs;

    if (!this.ready) return;

    // Cap the backlog: a backgrounded tab must skip time rather than fire off
    // hundreds of commands at once when it wakes up.
    this.accumulator = Math.min(this.accumulator + frameMs, this.tickMs * CLIENT_MAX_CATCHUP_TICKS);
    while (this.accumulator >= this.tickMs) {
      this.accumulator -= this.tickMs;
      this.runTick();
    }
    this.alpha = this.accumulator / this.tickMs;

    this.predictor.decaySmoothing((frameMs / 1000) * this.timeScale);
    this.interpolator.sample(nowMs, this.connection.playerId, this.remotes);
  }

  private runTick(): void {
    const map = this.map;
    if (map === null) return;

    const sample = this.input.sample();
    this.seq += 1;
    const cmd: InputCommand = {
      seq: this.seq,
      buttons: sample.buttons,
      yawQ: sample.yawQ,
      pitchQ: sample.pitchQ,
      // What this client is currently drawing other players at. The server
      // rewinds to it so a shot is judged against what the shooter saw.
      renderTick: this.interpolator.renderTick,
      slot: sample.slot,
    };

    this.predictor.applyCommand(cmd, map.world);

    // Re-send the last few commands so a single lost packet never costs the
    // server a tick of input.
    const pending = this.predictor.pending;
    const from = Math.max(0, pending.length - INPUT_REDUNDANCY);
    this.connection.sendInput(pending.slice(from), this.ackTick);
  }
}
