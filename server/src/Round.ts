import {
  BUS_DURATION_TICKS,
  BUS_RIDER_SPACING,
  LOBBY_COUNTDOWN_TICKS,
  LOBBY_MIN_PLAYERS,
  MoveMode,
  ROUND_END_TICKS,
  RoundPhase,
  STORM_DAMAGE,
  STORM_PHASES,
  STORM_RADII,
  STORM_SHRINK_TICKS,
  STORM_WAIT_TICKS,
  StateFlag,
  TICK_DT,
  busPosition,
  createRoundState,
  f32,
  lerp,
  outsideStorm,
  planStorm,
  vec3,
  type RoundState,
  type StormStep,
} from '@br/shared';
import type { ServerPlayer } from './ServerPlayer.js';

const busPos = vec3();

/**
 * Drives a round from lobby, through the bus drop, into the closing storm and
 * out the other side to a winner - then starts another one.
 *
 * The phase and the storm circle are replicated as plain numbers rather than
 * being recomputed on the client, because the client has no reason to predict
 * any of it: nothing here responds to local input.
 */
export class Round {
  readonly state: RoundState;
  private storm: StormStep[];
  /** Ticks into the current storm phase, counting wait then shrink. */
  private stormTick = 0;
  private stormStartX = 0;
  private stormStartZ = 0;
  private stormStartRadius = 0;

  constructor(mapSeed: number) {
    this.state = createRoundState(mapSeed);
    this.storm = planStorm(mapSeed);
    this.resetStorm();
  }

  private resetStorm(): void {
    this.state.stormPhase = 0;
    this.state.stormX = 0;
    this.state.stormZ = 0;
    this.state.stormRadius = STORM_RADII[0]!;
    this.stormStartX = 0;
    this.stormStartZ = 0;
    this.stormStartRadius = STORM_RADII[0]!;
    this.stormTick = 0;
    const first = this.storm[0]!;
    this.state.targetX = first.x;
    this.state.targetZ = first.z;
    this.state.targetRadius = first.radius;
    this.state.stormWait = STORM_WAIT_TICKS[0]!;
  }

  /** Begins a fresh round on a new map. */
  restart(mapSeed: number, mapHash: number): void {
    this.state.phase = RoundPhase.Lobby;
    this.state.phaseTick = 0;
    this.state.mapSeed = mapSeed;
    this.state.mapHash = mapHash;
    this.state.winnerId = 0;
    this.storm = planStorm(mapSeed);
    this.resetStorm();
  }

  get phase(): number {
    return this.state.phase;
  }

  /** True while players should be taking storm damage and can win. */
  get live(): boolean {
    return this.state.phase === RoundPhase.Playing;
  }

  private enter(phase: number): void {
    this.state.phase = phase;
    this.state.phaseTick = 0;
  }

  /**
   * Advances the round. Returns the seed of a new map when the round has ended
   * and the next one should be built, otherwise null.
   */
  step(players: ReadonlyMap<number, ServerPlayer>, aliveCount: number, nextSeed: () => number): number | null {
    this.state.phaseTick += 1;
    this.state.aliveCount = aliveCount;

    switch (this.state.phase) {
      case RoundPhase.Lobby:
        return this.stepLobby(players);
      case RoundPhase.Bus:
        return this.stepBus(players);
      case RoundPhase.Playing:
        return this.stepPlaying(players, aliveCount);
      default:
        return this.stepEnded(nextSeed);
    }
  }

  private stepLobby(players: ReadonlyMap<number, ServerPlayer>): null {
    let count = 0;
    for (const player of players.values()) {
      if ((player.state.flags & StateFlag.Alive) !== 0) count += 1;
    }
    if (count < LOBBY_MIN_PLAYERS) {
      // Not enough people yet; hold the countdown at the start.
      this.state.phaseTick = 0;
      return null;
    }
    if (this.state.phaseTick >= LOBBY_COUNTDOWN_TICKS) {
      this.enter(RoundPhase.Bus);
      for (const player of players.values()) this.boardBus(player);
      // Put them on the bus in the same tick they board, so the epoch bump and
      // the position jump land in one snapshot rather than the client seeing an
      // unexplained four-hundred-unit correction a tick later.
      this.placeRiders(players);
    }
    return null;
  }

  private boardBus(player: ServerPlayer): void {
    player.state.mode = MoveMode.Bus;
    player.teleport();
    player.state.vel.x = 0;
    player.state.vel.y = 0;
    player.state.vel.z = 0;
    player.state.flags &= ~StateFlag.OnGround;
  }

  /** Snaps everyone still aboard to the bus at its current point on the path. */
  private placeRiders(players: ReadonlyMap<number, ServerPlayer>): void {
    busPosition(this.state.mapSeed, this.state.phaseTick, busPos);

    let index = 0;
    for (const player of players.values()) {
      if (player.state.mode !== MoveMode.Bus) continue;
      // Spread riders along the bus so they are not stacked in one point.
      player.state.pos.x = f32(busPos.x + index * BUS_RIDER_SPACING);
      player.state.pos.y = f32(busPos.y);
      player.state.pos.z = f32(busPos.z);
      index += 1;
    }
  }

  private stepBus(players: ReadonlyMap<number, ServerPlayer>): null {
    this.placeRiders(players);

    if (this.state.phaseTick >= BUS_DURATION_TICKS) {
      // End of the line: anyone still aboard is dropped.
      for (const player of players.values()) {
        if (player.state.mode !== MoveMode.Bus) continue;
        player.state.mode = MoveMode.Freefall;
        player.teleport();
      }
      this.enter(RoundPhase.Playing);
    }
    return null;
  }

  private stepPlaying(players: ReadonlyMap<number, ServerPlayer>, aliveCount: number): null {
    this.advanceStorm();
    this.applyStormDamage(players);

    // A round is over when one player is left standing, or nobody is.
    if (aliveCount <= 1) {
      let winner = 0;
      for (const player of players.values()) {
        if ((player.state.flags & StateFlag.Alive) !== 0) winner = player.id;
      }
      this.state.winnerId = winner;
      this.enter(RoundPhase.Ended);
    }
    return null;
  }

  private stepEnded(nextSeed: () => number): number | null {
    if (this.state.phaseTick < ROUND_END_TICKS) return null;
    return nextSeed();
  }

  private advanceStorm(): void {
    const phase = this.state.stormPhase;
    if (phase >= STORM_PHASES) return;

    const wait = STORM_WAIT_TICKS[phase]!;
    const shrink = STORM_SHRINK_TICKS[phase]!;
    this.stormTick += 1;

    if (this.stormTick <= wait) {
      this.state.stormWait = wait - this.stormTick;
      return;
    }
    this.state.stormWait = 0;

    const target = this.storm[phase]!;
    const progress = Math.min(1, (this.stormTick - wait) / shrink);
    this.state.stormX = f32(lerp(this.stormStartX, target.x, progress));
    this.state.stormZ = f32(lerp(this.stormStartZ, target.z, progress));
    this.state.stormRadius = f32(lerp(this.stormStartRadius, target.radius, progress));

    if (progress < 1) return;

    // Phase complete: the circle we just closed becomes the next starting point.
    this.stormStartX = this.state.stormX;
    this.stormStartZ = this.state.stormZ;
    this.stormStartRadius = this.state.stormRadius;
    this.state.stormPhase = phase + 1;
    this.stormTick = 0;

    const next = this.storm[phase + 1];
    if (next !== undefined) {
      this.state.targetX = next.x;
      this.state.targetZ = next.z;
      this.state.targetRadius = next.radius;
      this.state.stormWait = STORM_WAIT_TICKS[phase + 1]!;
    } else {
      this.state.targetX = this.state.stormX;
      this.state.targetZ = this.state.stormZ;
      this.state.targetRadius = 0;
      this.state.stormWait = 0;
    }
  }

  /**
   * Damage ticks up as a fraction so a one-per-second storm still hurts at
   * twenty ticks per second, without rounding every tick down to zero.
   */
  private applyStormDamage(players: ReadonlyMap<number, ServerPlayer>): void {
    const perSecond = STORM_DAMAGE[Math.min(this.state.stormPhase, STORM_DAMAGE.length - 1)]!;
    for (const player of players.values()) {
      const state = player.state;
      if ((state.flags & StateFlag.Alive) === 0) continue;
      if (state.mode === MoveMode.Bus) continue;
      if (!outsideStorm(this.state, state.pos.x, state.pos.z)) {
        player.stormDebt = 0;
        continue;
      }
      player.stormDebt += perSecond * TICK_DT;
      const whole = Math.floor(player.stormDebt);
      if (whole <= 0) continue;
      player.stormDebt -= whole;
      player.pendingStormDamage += whole;
    }
  }
}
