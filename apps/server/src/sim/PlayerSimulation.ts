import {
  DEFAULT_WEAPON_ID,
  FIXED_DT,
  INPUT_AIM,
  INPUT_SPRINT,
  KILL_PLANE_Y,
  MAX_COMMANDS_PER_SECOND,
  MAX_HEALTH,
  MAX_SHIELD,
  MAX_STEP_DISTANCE,
  MAX_MESSAGES_PER_SECOND,
  SPEED_VALIDATION_TOLERANCE,
  WEAPONS,
  WEAPON_IDS,
  RateLimiter,
  createMovementState,
  fireIntervalMs,
  getWeapon,
  hasButton,
  horizontalDistance,
  maxSpeedForInput,
  stepMovement,
  type ColliderIndex,
  type InputCommand,
  type MovementState,
  type Vec3,
  type WeaponId,
} from '@riftfront/shared';
import type { PlayerState } from '../schema/PlayerState.js';
import { PositionHistory } from './LagCompensation.js';

/** Per-weapon ammunition, tracked server-side only. */
interface AmmoState {
  magazine: number;
  reserve: number;
}

export type FireRejection =
  'notAlive' | 'matchNotRunning' | 'staleSequence' | 'rateLimited' | 'reloading' | 'emptyMagazine';

export type ReloadRejection = 'notAlive' | 'alreadyReloading' | 'magazineFull' | 'noReserve';

/**
 * Server-side runtime for one connected player.
 *
 * This object owns everything the client must never see or control: the input queue,
 * ammunition, fire-rate timers, rate limiters and rewind history. The replicated
 * `PlayerState` is a projection of it, refreshed once per tick.
 */
export class PlayerSimulation {
  readonly sessionId: string;
  readonly movement: MovementState;
  readonly history = new PositionHistory();

  private readonly inputQueue: InputCommand[] = [];
  private readonly ammo = new Map<WeaponId, AmmoState>();
  private readonly commandLimiter: RateLimiter;
  private readonly messageLimiter: RateLimiter;

  lastProcessedSeq = 0;
  lastShotSeq = -1;
  lastShotAtMs = -Infinity;
  lastWeaponSwitchAtMs = -Infinity;
  weaponId: WeaponId = DEFAULT_WEAPON_ID;

  rttMs = 0;
  /** Set when the server had to force-correct the client (teleport, out of bounds). */
  needsForcedReconcile = false;
  /** Rejected-message counter, surfaced in logs to spot misbehaving clients. */
  rejectedMessages = 0;

  private latestButtons = 0;
  private latestMoveMagnitude = 0;

  constructor(sessionId: string, spawnPosition: Vec3, nowMs: number) {
    this.sessionId = sessionId;
    this.movement = createMovementState(spawnPosition, nowMs);
    this.commandLimiter = new RateLimiter(MAX_COMMANDS_PER_SECOND, MAX_COMMANDS_PER_SECOND, nowMs);
    this.messageLimiter = new RateLimiter(MAX_MESSAGES_PER_SECOND, MAX_MESSAGES_PER_SECOND, nowMs);
    this.resetAmmo();
  }

  // -------------------------------------------------------------------------
  // Ammunition
  // -------------------------------------------------------------------------

  resetAmmo(): void {
    this.ammo.clear();
    for (const id of WEAPON_IDS) {
      const weapon = WEAPONS[id];
      this.ammo.set(id, { magazine: weapon.magazineSize, reserve: weapon.reserveAmmo });
    }
  }

  ammoFor(weaponId: WeaponId): AmmoState {
    const existing = this.ammo.get(weaponId);
    if (existing) return existing;
    const weapon = WEAPONS[weaponId];
    const created = { magazine: weapon.magazineSize, reserve: weapon.reserveAmmo };
    this.ammo.set(weaponId, created);
    return created;
  }

  get currentAmmo(): AmmoState {
    return this.ammoFor(this.weaponId);
  }

  // -------------------------------------------------------------------------
  // Message budgets
  // -------------------------------------------------------------------------

  /** Global per-connection message budget, checked before any payload parsing. */
  allowMessage(nowMs: number): boolean {
    const allowed = this.messageLimiter.tryConsume(1, nowMs);
    if (!allowed) this.rejectedMessages++;
    return allowed;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * Queues validated input commands. Out-of-order and replayed sequences are dropped,
   * and the total command rate is capped so a client cannot fast-forward its own
   * simulation by flooding the server.
   */
  enqueueInput(commands: readonly InputCommand[], nowMs: number, maxQueue: number): number {
    let accepted = 0;
    for (const command of commands) {
      if (command.seq <= this.lastProcessedSeq) continue;
      if (
        this.inputQueue.length > 0 &&
        command.seq <= this.inputQueue[this.inputQueue.length - 1].seq
      ) {
        continue;
      }
      if (!this.commandLimiter.tryConsume(1, nowMs)) {
        this.rejectedMessages++;
        break;
      }
      if (this.inputQueue.length >= maxQueue) {
        // Queue overflow means the client is ahead of the server; drop the oldest so
        // the player keeps responding to their most recent input.
        this.inputQueue.shift();
      }
      this.inputQueue.push(command);
      accepted++;
    }
    return accepted;
  }

  get queuedInputCount(): number {
    return this.inputQueue.length;
  }

  /** Most recent yaw/pitch the client reported, used for aiming when idle. */
  get latestButtonState(): number {
    return this.latestButtons;
  }

  /**
   * Steps at most `maxCommands` queued inputs. Stepping a bounded number per tick is
   * the primary defence against speed hacking: extra commands simply wait.
   */
  simulate(
    index: ColliderIndex,
    maxCommands: number,
    frozen: boolean,
  ): { processed: number; violations: number } {
    let processed = 0;
    let violations = 0;

    while (processed < maxCommands) {
      const command = this.inputQueue.shift();
      if (!command) break;

      const before = { ...this.movement.position };
      stepMovement(this.movement, command, FIXED_DT, index, { frozen });

      // Server-side sanity check on its own output. A step larger than physically
      // possible means either a bug or a collider gap; either way the player is
      // snapped back and the client is told to re-sync.
      const travelled = horizontalDistance(before, this.movement.position);
      const allowed = maxSpeedForInput(command.buttons) * FIXED_DT * SPEED_VALIDATION_TOLERANCE;
      if (travelled > Math.max(allowed, MAX_STEP_DISTANCE)) {
        this.movement.position.x = before.x;
        this.movement.position.z = before.z;
        this.movement.velocity.x = 0;
        this.movement.velocity.z = 0;
        this.needsForcedReconcile = true;
        violations++;
      }

      this.lastProcessedSeq = command.seq;
      this.latestButtons = command.buttons;
      this.latestMoveMagnitude = Math.hypot(command.moveX, command.moveZ);
      this.movement.position.y = Math.max(this.movement.position.y, KILL_PLANE_Y - 10);
      processed++;
    }

    return { processed, violations };
  }

  clearInputQueue(): void {
    this.inputQueue.length = 0;
  }

  // -------------------------------------------------------------------------
  // Combat gating
  // -------------------------------------------------------------------------

  /**
   * Server-side fire-rate, ammunition and replay validation. Returns the rejection
   * reason, or null when the shot is legal (in which case ammo is consumed).
   */
  tryConsumeShot(
    shotSeq: number,
    nowMs: number,
    alive: boolean,
    matchRunning: boolean,
    graceMs: number,
  ): FireRejection | null {
    if (!alive) return 'notAlive';
    if (!matchRunning) return 'matchNotRunning';
    // Strictly increasing sequence: blocks replayed and duplicated fire messages.
    if (shotSeq <= this.lastShotSeq) return 'staleSequence';

    const weapon = getWeapon(this.weaponId);
    const minInterval = fireIntervalMs(weapon) - graceMs;
    if (nowMs - this.lastShotAtMs < minInterval) return 'rateLimited';

    const ammo = this.currentAmmo;
    if (ammo.magazine <= 0) return 'emptyMagazine';

    ammo.magazine -= 1;
    this.lastShotSeq = shotSeq;
    this.lastShotAtMs = nowMs;
    return null;
  }

  /** Begins a reload if one is legal. Returns the rejection reason otherwise. */
  tryStartReload(nowMs: number, alive: boolean, state: PlayerState): ReloadRejection | null {
    if (!alive) return 'notAlive';
    if (state.reloading) return 'alreadyReloading';

    const weapon = getWeapon(this.weaponId);
    const ammo = this.currentAmmo;
    if (ammo.magazine >= weapon.magazineSize) return 'magazineFull';
    if (ammo.reserve <= 0) return 'noReserve';

    state.reloading = true;
    state.reloadEndsAtMs = nowMs + weapon.reloadDurationMs;
    return null;
  }

  /** Completes a reload that has run its course. */
  finishReloadIfDue(nowMs: number, state: PlayerState): boolean {
    if (!state.reloading || nowMs < state.reloadEndsAtMs) return false;

    const weapon = getWeapon(this.weaponId);
    const ammo = this.currentAmmo;
    const needed = weapon.magazineSize - ammo.magazine;
    const transferred = Math.min(needed, ammo.reserve);
    ammo.magazine += transferred;
    ammo.reserve -= transferred;
    state.reloading = false;
    state.reloadEndsAtMs = 0;
    return true;
  }

  cancelReload(state: PlayerState): void {
    state.reloading = false;
    state.reloadEndsAtMs = 0;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  respawnAt(position: Vec3, nowMs: number): void {
    this.movement.position = { x: position.x, y: position.y, z: position.z };
    this.movement.velocity = { x: 0, y: 0, z: 0 };
    this.movement.grounded = false;
    this.movement.lastJumpAtMs = -Infinity;
    this.movement.lastGroundedAtMs = this.movement.timeMs;
    this.weaponId = DEFAULT_WEAPON_ID;
    this.resetAmmo();
    this.lastShotAtMs = -Infinity;
    this.clearInputQueue();
    this.history.clear();
    this.history.record(nowMs, this.movement.position, true);
  }

  /** Copies the authoritative simulation into the replicated schema object. */
  syncTo(state: PlayerState): void {
    state.x = this.movement.position.x;
    state.y = this.movement.position.y;
    state.z = this.movement.position.z;
    state.vx = this.movement.velocity.x;
    state.vy = this.movement.velocity.y;
    state.vz = this.movement.velocity.z;
    state.grounded = this.movement.grounded;
    state.lastProcessedInputSeq = this.lastProcessedSeq;
    state.weaponId = this.weaponId;

    const ammo = this.currentAmmo;
    state.magazine = ammo.magazine;
    state.reserve = ammo.reserve;

    state.moving = this.latestMoveMagnitude > 0.05 && state.alive;
    state.sprinting = hasButton(this.latestButtons, INPUT_SPRINT) && state.moving;
    state.aiming = hasButton(this.latestButtons, INPUT_AIM);
    state.ping = Math.min(9999, Math.round(this.rttMs));
  }

  /** Restores full vitals on the replicated state. */
  static resetVitals(state: PlayerState): void {
    state.health = MAX_HEALTH;
    state.shield = MAX_SHIELD;
    state.reloading = false;
    state.reloadEndsAtMs = 0;
  }
}
