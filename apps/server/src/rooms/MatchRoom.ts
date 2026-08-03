import { type Client, Room } from 'colyseus';
import {
  ClientMessage,
  ColliderIndex,
  DEFAULT_WEAPON_ID,
  FIRE_RATE_GRACE_MS,
  FIXED_DT_MS,
  KILL_PLANE_Y,
  PLAYER_EYE_HEIGHT,
  PROTOCOL_VERSION,
  SERVER_TICK_MS,
  SPAWN_PROTECTION_MS,
  ServerMessage,
  getArena,
  rankScoreboard,
  selectSpawnPoint,
  validateFire,
  validateInputBatch,
  validateJoinOptions,
  validatePing,
  validateSwitchWeapon,
  type MatchEndedPayload,
  type MatchResultEntry,
  type MatchRules,
  type Vec3,
} from '@riftfront/shared';
import { MatchRoomState } from '../schema/MatchRoomState.js';
import { PlayerState } from '../schema/PlayerState.js';
import { PlayerSimulation } from '../sim/PlayerSimulation.js';
import { applyHit, resolveFire, type CombatParticipant } from '../sim/CombatResolver.js';
import { MatchController } from '../match/MatchController.js';
import { loadConfig } from '../config.js';

export interface MatchRoomOptions {
  roomCode?: string;
  displayName?: string;
  protocolVersion?: number;
}

/** Commands stepped per tick. One tick is ~3 simulation steps; the slack absorbs jitter. */
const MAX_COMMANDS_PER_TICK = Math.ceil(SERVER_TICK_MS / FIXED_DT_MS) + 2;
/** Hard ceiling on the queue so a stalled client cannot accumulate a replay buffer. */
const MAX_QUEUED_COMMANDS = MAX_COMMANDS_PER_TICK * 4;
/** Minimum interval between weapon switches. */
const WEAPON_SWITCH_COOLDOWN_MS = 350;

/**
 * Authoritative free-for-all deathmatch room.
 *
 * The server owns movement, ammunition, damage, eliminations, scoring and the match
 * clock. Clients send inputs and intents only; nothing they report is trusted as fact.
 */
export class MatchRoom extends Room<MatchRoomState> {
  private readonly config = loadConfig();
  private readonly arena = getArena();
  private readonly colliders = new ColliderIndex(getArena().colliders);
  private readonly sims = new Map<string, PlayerSimulation>();

  private rules!: MatchRules;
  private match!: MatchController;
  private serverClockMs = 0;
  private accumulatedRealMs = 0;

  override onCreate(options: MatchRoomOptions): void {
    this.rules = this.config.matchRules;
    this.maxClients = this.rules.maxPlayers;
    this.serverClockMs = Date.now();
    this.match = new MatchController(this.rules, this.serverClockMs);

    const state = new MatchRoomState();
    state.roomCode = typeof options.roomCode === 'string' ? options.roomCode : this.roomId;
    state.arenaName = this.arena.name;
    state.phase = this.match.phase;
    state.scoreLimit = this.rules.scoreLimit;
    state.maxPlayers = this.rules.maxPlayers;
    state.minPlayers = this.rules.minPlayers;
    state.matchDurationMs = this.rules.durationMs;
    state.serverTimeMs = this.serverClockMs;
    this.setState(state);

    void this.setMetadata({ roomCode: state.roomCode });

    // Colyseus patches state at the same cadence as the simulation tick.
    this.setPatchRate(SERVER_TICK_MS);
    this.setSimulationInterval((deltaMs) => this.update(deltaMs), SERVER_TICK_MS);

    this.registerMessageHandlers();

    console.log(`[room ${this.roomId}] created (code ${state.roomCode})`);
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  override onAuth(_client: Client, options: MatchRoomOptions): boolean {
    const result = validateJoinOptions(options, PROTOCOL_VERSION);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return true;
  }

  override onJoin(client: Client, options: MatchRoomOptions): void {
    const join = validateJoinOptions(options, PROTOCOL_VERSION);
    if (!join.ok) {
      // onAuth already rejected mismatches; this guards direct/replayed joins.
      client.leave(4000, join.error);
      return;
    }

    const nowMs = this.serverClockMs;
    const spawn = this.pickSpawn();

    const player = new PlayerState();
    player.id = client.sessionId;
    player.displayName = this.uniqueDisplayName(join.value.displayName);
    player.x = spawn.position.x;
    player.y = spawn.position.y;
    player.z = spawn.position.z;
    player.yaw = spawn.yaw;
    player.alive = true;
    player.weaponId = DEFAULT_WEAPON_ID;
    player.spawnProtectedUntilMs = nowMs + SPAWN_PROTECTION_MS;
    PlayerSimulation.resetVitals(player);

    const sim = new PlayerSimulation(client.sessionId, spawn.position, nowMs);
    sim.history.record(nowMs, spawn.position, true);
    sim.syncTo(player);

    this.sims.set(client.sessionId, sim);
    this.state.players.set(client.sessionId, player);

    client.send(ServerMessage.Welcome, {
      sessionId: client.sessionId,
      roomCode: this.state.roomCode,
      protocolVersion: PROTOCOL_VERSION,
      serverTimeMs: nowMs,
      tickRateHz: Math.round(1000 / SERVER_TICK_MS),
      arenaName: this.arena.name,
    });

    console.log(
      `[room ${this.roomId}] ${player.displayName} joined (${this.state.players.size}/${this.maxClients})`,
    );
  }

  override onLeave(client: Client): void {
    // Removal is immediate and unconditional: reconnection windows are the usual
    // source of "ghost" players, and rejoining by room code is cheap here.
    this.sims.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    console.log(`[room ${this.roomId}] ${client.sessionId} left (${this.state.players.size} left)`);
  }

  override onDispose(): void {
    this.sims.clear();
    console.log(`[room ${this.roomId}] disposed`);
  }

  // -------------------------------------------------------------------------
  // Message handlers
  // -------------------------------------------------------------------------

  private registerMessageHandlers(): void {
    this.onMessage(ClientMessage.Input, (client, payload: unknown) => {
      const sim = this.simFor(client);
      if (!sim?.allowMessage(this.serverClockMs)) return;

      const result = validateInputBatch(payload);
      if (!result.ok) {
        this.rejectMessage(client, 'invalidInput', result.error);
        return;
      }
      sim.enqueueInput(result.value.commands, this.serverClockMs, MAX_QUEUED_COMMANDS);
    });

    this.onMessage(ClientMessage.Fire, (client, payload: unknown) => {
      const sim = this.simFor(client);
      if (!sim?.allowMessage(this.serverClockMs)) return;

      const result = validateFire(payload);
      if (!result.ok) {
        this.rejectMessage(client, 'invalidFire', result.error);
        return;
      }
      this.handleFire(
        client,
        sim,
        result.value.shotSeq,
        result.value.direction,
        result.value.aiming,
      );
    });

    this.onMessage(ClientMessage.Reload, (client) => {
      const sim = this.simFor(client);
      const player = this.state.players.get(client.sessionId);
      if (!sim || !player || !sim.allowMessage(this.serverClockMs)) return;
      sim.tryStartReload(this.serverClockMs, player.alive, player);
    });

    this.onMessage(ClientMessage.SwitchWeapon, (client, payload: unknown) => {
      const sim = this.simFor(client);
      const player = this.state.players.get(client.sessionId);
      if (!sim || !player || !sim.allowMessage(this.serverClockMs)) return;

      const result = validateSwitchWeapon(payload);
      if (!result.ok) {
        this.rejectMessage(client, 'invalidWeapon', result.error);
        return;
      }
      if (!player.alive) return;
      if (result.value.weaponId === sim.weaponId) return;
      if (this.serverClockMs - sim.lastWeaponSwitchAtMs < WEAPON_SWITCH_COOLDOWN_MS) return;

      sim.cancelReload(player);
      sim.weaponId = result.value.weaponId;
      sim.lastWeaponSwitchAtMs = this.serverClockMs;
      sim.syncTo(player);
    });

    this.onMessage(ClientMessage.Ping, (client, payload: unknown) => {
      const sim = this.simFor(client);
      if (!sim?.allowMessage(this.serverClockMs)) return;

      const result = validatePing(payload);
      if (!result.ok) return;
      client.send(ServerMessage.Pong, {
        clientTimeMs: result.value.clientTimeMs,
        serverTimeMs: this.serverClockMs,
      });
    });

    this.onMessage(ClientMessage.RequestRespawn, (client) => {
      const sim = this.simFor(client);
      const player = this.state.players.get(client.sessionId);
      if (!sim || !player || !sim.allowMessage(this.serverClockMs)) return;
      // Only shortens the wait for an already-elapsed timer; never skips it.
      if (!player.alive && this.serverClockMs >= player.respawnAtMs) {
        this.respawn(client.sessionId, sim, player);
      }
    });

    // Any message type the server does not know about is dropped with a notice
    // rather than crashing the room.
    this.onMessage('*', (client, type) => {
      this.rejectMessage(client, 'unknownMessage', `unsupported message type: ${String(type)}`);
    });
  }

  private simFor(client: Client): PlayerSimulation | undefined {
    return this.sims.get(client.sessionId);
  }

  private rejectMessage(client: Client, code: string, message: string): void {
    if (this.config.verboseValidation) {
      console.warn(`[room ${this.roomId}] rejected ${code} from ${client.sessionId}: ${message}`);
    }
    client.send(ServerMessage.Notice, { level: 'warning', code, message });
  }

  // -------------------------------------------------------------------------
  // Simulation tick
  // -------------------------------------------------------------------------

  private update(deltaMs: number): void {
    // The server clock is driven by the simulation interval rather than Date.now()
    // so timers stay consistent even if the event loop stalls briefly.
    this.accumulatedRealMs += deltaMs;
    this.serverClockMs += deltaMs;
    const nowMs = this.serverClockMs;

    const running = this.match.isRunning;

    for (const [sessionId, sim] of this.sims) {
      const player = this.state.players.get(sessionId);
      if (!player) continue;

      const frozen = !player.alive || !running;
      sim.simulate(this.colliders, MAX_COMMANDS_PER_TICK, frozen);
      sim.finishReloadIfDue(nowMs, player);

      if (player.alive && sim.movement.position.y < KILL_PLANE_Y) {
        // Safety net: the arena is walled, but a physics escape must never strand a player.
        this.eliminate(sessionId, player, null, false);
      }

      if (!player.alive && player.respawnAtMs > 0 && nowMs >= player.respawnAtMs) {
        this.respawn(sessionId, sim, player);
      }

      sim.history.record(nowMs, sim.movement.position, player.alive);
      sim.syncTo(player);

      if (sim.needsForcedReconcile) {
        sim.needsForcedReconcile = false;
        this.sendReconcile(sessionId, sim, player);
      }
    }

    this.advanceMatch(nowMs);

    this.state.serverTimeMs = nowMs;
    this.state.phase = this.match.phase;
    this.state.phaseEndsAtMs = this.match.phaseEndsAtMs(nowMs);
  }

  private advanceMatch(nowMs: number): void {
    const playerCount = this.state.players.size;
    let topScore = 0;
    for (const player of this.state.players.values()) {
      topScore = Math.max(topScore, player.kills);
    }

    const transitions = this.match.update(nowMs, playerCount, topScore);
    for (const transition of transitions) {
      this.onPhaseEntered(transition.to, nowMs, topScore);
    }
  }

  private onPhaseEntered(phase: string, nowMs: number, topScore: number): void {
    switch (phase) {
      case 'COUNTDOWN':
        this.resetPlayersForNewMatch();
        break;

      case 'PLAYING':
        this.state.winnerId = '';
        this.state.winnerName = '';
        this.broadcast(ServerMessage.MatchStarted, {
          serverTimeMs: nowMs,
          durationMs: this.rules.durationMs,
        });
        break;

      case 'FINISHED':
        this.broadcastResults(topScore);
        break;

      case 'RESTARTING':
        this.resetPlayersForNewMatch();
        break;

      default:
        break;
    }
  }

  private broadcastResults(topScore: number): void {
    const ranked = this.buildScoreboard();
    const winner = ranked[0] ?? null;
    this.state.winnerId = winner?.id ?? '';
    this.state.winnerName = winner?.displayName ?? '';

    const reason: MatchEndedPayload['reason'] =
      this.state.players.size === 0
        ? 'abandoned'
        : this.rules.scoreLimit > 0 && topScore >= this.rules.scoreLimit
          ? 'scoreLimit'
          : 'timeLimit';

    const payload: MatchEndedPayload = {
      winnerId: this.state.winnerId || null,
      winnerName: this.state.winnerName || null,
      scoreboard: ranked,
      reason,
      restartInMs: this.rules.resultsMs,
    };
    this.broadcast(ServerMessage.MatchEnded, payload);
  }

  private buildScoreboard(): MatchResultEntry[] {
    const entries = [...this.state.players.values()].map((player) => ({
      id: player.id,
      displayName: player.displayName,
      kills: player.kills,
      deaths: player.deaths,
      damageDealt: player.damageDealt,
      ping: player.ping,
    }));

    return rankScoreboard(entries).map((entry, index) => ({ ...entry, placement: index + 1 }));
  }

  private resetPlayersForNewMatch(): void {
    for (const [sessionId, player] of this.state.players) {
      const sim = this.sims.get(sessionId);
      if (!sim) continue;

      player.kills = 0;
      player.deaths = 0;
      player.damageDealt = 0;
      player.respawnAtMs = 0;
      this.respawn(sessionId, sim, player);
    }
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  private handleFire(
    client: Client,
    sim: PlayerSimulation,
    shotSeq: number,
    direction: Vec3,
    aiming: boolean,
  ): void {
    const shooter = this.state.players.get(client.sessionId);
    if (!shooter) return;

    const nowMs = this.serverClockMs;
    const rejection = sim.tryConsumeShot(
      shotSeq,
      nowMs,
      shooter.alive,
      this.match.isRunning,
      FIRE_RATE_GRACE_MS,
    );
    if (rejection) {
      if (rejection === 'emptyMagazine') {
        client.send(ServerMessage.Notice, {
          level: 'info',
          code: 'emptyMagazine',
          message: 'Magazine empty',
        });
      }
      // Ammo state is replicated, so the client corrects itself; no further reply needed.
      return;
    }

    // Firing interrupts a reload rather than being blocked by it, which matches the
    // input the player actually gave (they pressed fire).
    sim.cancelReload(shooter);
    // Shooting removes spawn protection: it cannot be used as a free-damage window.
    shooter.spawnProtectedUntilMs = 0;

    const others: CombatParticipant[] = [];
    for (const [sessionId, state] of this.state.players) {
      const otherSim = this.sims.get(sessionId);
      if (!otherSim) continue;
      others.push({ sim: otherSim, state });
    }

    const resolution = resolveFire({
      shooter: { sim, state: shooter },
      others,
      index: this.colliders,
      nowMs,
      direction,
      aiming,
      shotSeq,
    });

    this.broadcast(ServerMessage.Shot, {
      shooterId: client.sessionId,
      weaponId: sim.weaponId,
      shotSeq,
      origin: resolution.origin,
      endPoints: resolution.endPoints,
      impactNormals: resolution.impactNormals,
      serverTimeMs: nowMs,
    });

    for (const hit of resolution.hits) {
      const victim = this.state.players.get(hit.targetId);
      if (!victim) continue;

      const applied = applyHit(hit, victim, nowMs);
      if (!applied) continue;

      shooter.damageDealt += Math.round(applied.damage);

      client.send(ServerMessage.HitConfirmed, {
        targetId: applied.targetId,
        damage: Math.round(applied.damage),
        headshot: applied.headshot,
        killed: applied.killed,
        point: applied.point,
      });

      const victimClient = this.clientFor(hit.targetId);
      victimClient?.send(ServerMessage.Damaged, {
        attackerId: client.sessionId,
        attackerName: shooter.displayName,
        damage: Math.round(applied.damage),
        headshot: applied.headshot,
        attackerPosition: {
          x: sim.movement.position.x,
          y: sim.movement.position.y + PLAYER_EYE_HEIGHT,
          z: sim.movement.position.z,
        },
        health: applied.health,
        shield: applied.shield,
      });

      if (applied.killed) {
        this.eliminate(hit.targetId, victim, shooter, applied.headshot);
      }
    }

    sim.syncTo(shooter);
  }

  /** Records an elimination. Guarded by `alive` so a victim can only die once. */
  private eliminate(
    victimId: string,
    victim: PlayerState,
    attacker: PlayerState | null,
    headshot: boolean,
  ): void {
    if (!victim.alive) return;

    const nowMs = this.serverClockMs;
    victim.alive = false;
    victim.health = 0;
    victim.shield = 0;
    victim.deaths += 1;
    victim.reloading = false;
    victim.reloadEndsAtMs = 0;
    victim.respawnAtMs = nowMs + this.rules.respawnDelayMs;
    victim.spawnProtectedUntilMs = 0;

    const victimSim = this.sims.get(victimId);
    victimSim?.clearInputQueue();

    if (attacker && attacker.id !== victimId) {
      attacker.kills += 1;
    }

    this.broadcast(ServerMessage.Kill, {
      attackerId: attacker?.id ?? '',
      attackerName: attacker?.displayName ?? 'The Rift',
      victimId,
      victimName: victim.displayName,
      weaponId: attacker
        ? (this.sims.get(attacker.id)?.weaponId ?? DEFAULT_WEAPON_ID)
        : DEFAULT_WEAPON_ID,
      headshot,
      serverTimeMs: nowMs,
    });
  }

  private respawn(sessionId: string, sim: PlayerSimulation, player: PlayerState): void {
    const nowMs = this.serverClockMs;
    const spawn = this.pickSpawn(sessionId);

    sim.respawnAt(spawn.position, nowMs);
    player.alive = true;
    player.yaw = spawn.yaw;
    player.pitch = 0;
    player.respawnAtMs = 0;
    player.spawnProtectedUntilMs = nowMs + SPAWN_PROTECTION_MS;
    PlayerSimulation.resetVitals(player);
    sim.syncTo(player);

    this.clientFor(sessionId)?.send(ServerMessage.Respawned, {
      playerId: sessionId,
      position: spawn.position,
      yaw: spawn.yaw,
      spawnProtectionUntilMs: player.spawnProtectedUntilMs,
    });

    this.sendReconcile(sessionId, sim, player);
  }

  private sendReconcile(sessionId: string, sim: PlayerSimulation, player: PlayerState): void {
    this.clientFor(sessionId)?.send(ServerMessage.Reconcile, {
      lastProcessedSeq: sim.lastProcessedSeq,
      position: { x: player.x, y: player.y, z: player.z },
      velocity: { x: player.vx, y: player.vy, z: player.vz },
      grounded: player.grounded,
      serverTimeMs: this.serverClockMs,
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private clientFor(sessionId: string): Client | undefined {
    return this.clients.find((client) => client.sessionId === sessionId);
  }

  private pickSpawn(excludeSessionId?: string): { position: Vec3; yaw: number } {
    const occupied: Vec3[] = [];
    for (const [sessionId, player] of this.state.players) {
      if (sessionId === excludeSessionId) continue;
      if (!player.alive) continue;
      occupied.push({ x: player.x, y: player.y, z: player.z });
    }
    return selectSpawnPoint(this.arena.spawnPoints, occupied);
  }

  /** Appends a numeric suffix when a name is already taken, so the kill feed stays readable. */
  private uniqueDisplayName(name: string): string {
    const taken = new Set([...this.state.players.values()].map((player) => player.displayName));
    if (!taken.has(name)) return name;
    for (let suffix = 2; suffix < 100; suffix++) {
      const candidate = `${name.slice(0, 13)}(${suffix})`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${name.slice(0, 12)}${Math.floor(Math.random() * 900 + 100)}`;
  }

  /** Diagnostics: how much simulated time this room has accumulated. */
  get uptimeMs(): number {
    return this.accumulatedRealMs;
  }
}
