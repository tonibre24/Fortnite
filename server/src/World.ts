import {
  Button,
  EventType,
  INPUT_STARVE_GRACE_TICKS,
  INVENTORY_SLOTS,
  ItemKind,
  MEDKIT_USE_TICKS,
  MoveMode,
  PLAYER_MAX_HEALTH,
  Rng,
  SHIELD_POTION_USE_TICKS,
  SNAPSHOT_HISTORY,
  StateFlag,
  TICK_DT,
  clonePlayerState,
  encodeSnapshot,
  generateMap,
  hashMap,
  idleCommand,
  applyDamage,
  emptyStack,
  isConsumableKind,
  lerp,
  stepMovement,
  type GameEvent,
  type GameMap,
  type InputCommand,
  type PlayerState,
  type SnapshotBaseline,
  type Vec3,
} from '@br/shared';
import { resolveWeapon } from './Combat.js';
import { Round } from './Round.js';
import {
  LootField,
  consume,
  dropInventory,
  giveWeapon,
  syncAmmoToSlot,
  syncHeldWeapon,
  tryPickup,
} from './Loot.js';
import { ServerPlayer } from './ServerPlayer.js';

/** An event plus who is allowed to see it; zero means everyone. */
interface AddressedEvent {
  event: GameEvent;
  only: number;
}

interface HistoryEntry {
  tick: number;
  players: Map<number, PlayerState>;
  /** Which loot existed, so the snapshot delta can say what changed. */
  lootIds: Set<number>;
}

/**
 * The authoritative simulation. Owns the map, the players and a ring of past
 * states used both as delta baselines and (later) for lag-compensated hitscan.
 */
export class World {
  map: GameMap;
  /** Sent in the welcome packet so clients can prove they built the same map. */
  mapHash: number;
  readonly players = new Map<number, ServerPlayer>();
  loot: LootField;
  readonly round: Round;
  tick = 0;
  /** Rounds completed since the server started, for the sim report. */
  roundsPlayed = 0;

  /**
   * Times the server had to simulate a player idle because their input never
   * arrived. Each one is a real divergence from that client's prediction, so
   * this is the number to watch when reconciliation error is not zero.
   */
  starvationSteps = 0;
  /** Kills resolved so far, for the sim report. */
  killCount = 0;
  /** Successful pickups and chest opens, for the sim report. */
  pickupCount = 0;

  private readonly seedSource: Rng;
  private readonly history: HistoryEntry[] = [];
  private readonly events: AddressedEvent[] = [];
  private spawnCursor = 0;

  constructor(seed: number) {
    this.map = generateMap(seed);
    this.mapHash = hashMap(this.map);
    // Loot rolls from its own stream so that adding or removing a roll cannot
    // shift the map geometry the client also generates.
    this.loot = new LootField(this.map, new Rng(seed ^ 0x10077));
    this.round = new Round(seed);
    this.round.state.mapHash = this.mapHash;
    this.seedSource = new Rng(seed ^ 0x9a5eed);
    for (let i = 0; i < SNAPSHOT_HISTORY; i++) {
      this.history.push({ tick: -1, players: new Map(), lootIds: new Set() });
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
    giveWeapon(player.state, player.id % 4, 0, 0);
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
    // Everything they were carrying is up for grabs.
    dropInventory(this.loot, victim.state);
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

  /**
   * Slot selection, picking things up, and using a consumable. Runs before the
   * weapon so a switch takes effect on the same command that requested it.
   */
  private resolveInventory(player: ServerPlayer, cmd: InputCommand): void {
    const state = player.state;
    if ((state.flags & StateFlag.Alive) === 0) return;

    // Nothing to manage while riding, and pressing jump is what gets you off.
    if (state.mode === MoveMode.Bus) {
      if ((cmd.buttons & Button.Jump) !== 0) {
        state.mode = MoveMode.Freefall;
        player.teleport();
      }
      return;
    }

    if (cmd.slot < INVENTORY_SLOTS && cmd.slot !== state.slot) {
      state.slot = cmd.slot;
      // Switching weapons interrupts a reload and re-arms a semi-automatic.
      state.reload = 0;
      player.useTicks = 0;
      player.triggerHeld = true;
    }
    syncHeldWeapon(state);

    const interact = (cmd.buttons & Button.Interact) !== 0;
    if (interact && !player.interactHeld && tryPickup(this.loot, state) !== 0) {
      this.pickupCount += 1;
    }
    player.interactHeld = interact;

    const held = state.inventory[state.slot]!;
    if (!isConsumableKind(held.kind)) {
      player.useTicks = 0;
      return;
    }

    // Consumables are used by holding fire, which is why they never reach the
    // weapon code below.
    if ((cmd.buttons & Button.Fire) === 0) {
      player.useTicks = 0;
      return;
    }
    player.useTicks += 1;
    const needed = held.kind === ItemKind.Medkit ? MEDKIT_USE_TICKS : SHIELD_POTION_USE_TICKS;
    if (player.useTicks >= needed) {
      consume(state, state.slot);
      player.useTicks = 0;
      syncHeldWeapon(state);
    }
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
        const cmd = idleCommand(
          player.lastProcessedSeq,
          player.state.yawQ,
          player.state.pitchQ,
          player.state.slot,
        );
        stepMovement(player.state, cmd, this.map.world, TICK_DT);
        player.resolvedCommands.push(cmd);
        this.starvationSteps += 1;
      }
    }

    // Record before combat so a shot can be rewound to this very tick, and so
    // that everybody has already moved: whose command happened to be processed
    // first must not decide who wins a trade.
    this.record();

    const nextSeed = this.round.step(this.players, this.aliveCount, () =>
      this.seedSource.nextUint32(),
    );
    this.applyPendingStormDamage();
    if (nextSeed !== null) this.startNewRound(nextSeed);

    for (const player of this.players.values()) {
      for (const cmd of player.resolvedCommands) {
        this.resolveInventory(player, cmd);
        resolveWeapon(this, player, cmd);
        syncAmmoToSlot(player.state);
      }
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
    entry.lootIds.clear();
    for (const id of this.loot.items.keys()) entry.lootIds.add(id);
  }

  /** The recorded state at `tick`, or null once it has aged out of the ring. */
  /**
   * Storm damage is applied here rather than inside the round so that a death
   * it causes goes through the same path as any other, dropping loot and
   * raising a kill event.
   */
  private applyPendingStormDamage(): void {
    for (const player of this.players.values()) {
      const amount = player.pendingStormDamage;
      if (amount <= 0) continue;
      player.pendingStormDamage = 0;
      const state = player.state;
      if ((state.flags & StateFlag.Alive) === 0) continue;
      const result = applyDamage(state.health, state.shield, amount);
      state.health = result.health;
      state.shield = result.shield;
      if (result.killed) this.killPlayer(player, null);
    }
  }

  /** Rebuilds the world on a fresh seed and puts everyone back in the lobby. */
  private startNewRound(seed: number): void {
    this.map = generateMap(seed);
    this.mapHash = hashMap(this.map);
    this.loot = new LootField(this.map, new Rng(seed ^ 0x10077));
    this.round.restart(seed, this.mapHash);
    this.roundsPlayed += 1;
    this.spawnCursor = 0;
    for (const player of this.players.values()) this.respawn(player);
    for (const entry of this.history) {
      entry.tick = -1;
      entry.players.clear();
      entry.lootIds.clear();
    }
  }

  /** Puts a player back on the spawn ring, alive and freshly armed. */
  private respawn(player: ServerPlayer): void {
    const spawn = this.map.spawns[this.spawnCursor % this.map.spawns.length]!;
    this.spawnCursor += 1;
    const state = player.state;
    state.pos.x = spawn.pos.x;
    state.pos.y = spawn.pos.y;
    state.pos.z = spawn.pos.z;
    state.vel.x = 0;
    state.vel.y = 0;
    state.vel.z = 0;
    state.yawQ = spawn.yawQ;
    state.pitchQ = 0;
    state.health = PLAYER_MAX_HEALTH;
    state.shield = 0;
    state.kills = 0;
    state.mode = MoveMode.Ground;
    state.flags = StateFlag.Alive;
    state.slot = 0;
    for (let i = 0; i < state.inventory.length; i++) state.inventory[i] = emptyStack();
    player.diedAtTick = -1;
    player.killedBy = 0;
    player.stormDebt = 0;
    player.pendingStormDamage = 0;
    player.useTicks = 0;
    player.teleport();
    this.equipStarterWeapon(player);
  }

  /** Ticks a player has spent using the consumable in hand, for the HUD. */
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
      this.loot.items,
      this.round.state,
    );
  }
}
