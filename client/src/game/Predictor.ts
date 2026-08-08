import {
  RECONCILE_EPSILON,
  RECONCILE_SMOOTH_TIME,
  RECONCILE_SNAP_DISTANCE,
  TICK_DT,
  clonePlayerState,
  copyPlayerState,
  createPlayerState,
  distance,
  lerp,
  stepMovement,
  type CollisionWorld,
  type InputCommand,
  type PlayerState,
  type Vec3,
} from '@br/shared';

/**
 * Client-side prediction and server reconciliation for the local player.
 *
 * The local player is simulated immediately from local input so movement has no
 * input lag. Every command is kept until the server confirms it. When a
 * snapshot arrives the predicted state is thrown away, replaced with the
 * server's, and the still-unconfirmed commands are replayed on top. Because the
 * server and this class run the identical `stepMovement` over identical
 * float32-exact state, that replay normally reproduces the prediction exactly
 * and the correction is zero.
 */
export class Predictor {
  readonly state: PlayerState = createPlayerState(0);
  readonly pending: InputCommand[] = [];

  /** Position before the most recent predicted tick, for inter-tick rendering. */
  private readonly previousPos: Vec3 = { x: 0, y: 0, z: 0 };
  /** Residual of the last correction, decayed to zero so corrections do not pop. */
  private readonly smoothing: Vec3 = { x: 0, y: 0, z: 0 };

  initialized = false;
  /** Distance between prediction and replayed authority at the last snapshot. */
  lastError = 0;
  maxError = 0;
  totalError = 0;
  reconcileCount = 0;
  correctionCount = 0;

  reset(authoritative: PlayerState): void {
    copyPlayerState(this.state, authoritative);
    this.previousPos.x = this.state.pos.x;
    this.previousPos.y = this.state.pos.y;
    this.previousPos.z = this.state.pos.z;
    this.smoothing.x = 0;
    this.smoothing.y = 0;
    this.smoothing.z = 0;
    this.pending.length = 0;
    this.initialized = true;
  }

  /** Simulates one command locally and remembers it for later replay. */
  applyCommand(cmd: InputCommand, world: CollisionWorld): void {
    this.previousPos.x = this.state.pos.x;
    this.previousPos.y = this.state.pos.y;
    this.previousPos.z = this.state.pos.z;
    this.pending.push(cmd);
    stepMovement(this.state, cmd, world, TICK_DT);
  }

  reconcile(authoritative: PlayerState, lastProcessedSeq: number, world: CollisionWorld): void {
    if (!this.initialized) {
      this.reset(authoritative);
      return;
    }

    while (this.pending.length > 0 && this.pending[0]!.seq <= lastProcessedSeq) {
      this.pending.shift();
    }

    const before = clonePlayerState(this.state);
    copyPlayerState(this.state, authoritative);
    for (const cmd of this.pending) {
      stepMovement(this.state, cmd, world, TICK_DT);
    }

    const error = distance(before.pos, this.state.pos);
    this.lastError = error;
    this.totalError += error;
    this.reconcileCount += 1;
    if (error > this.maxError) this.maxError = error;

    if (error <= RECONCILE_EPSILON) {
      // Prediction was exact. Keep rendering interpolation continuous.
      this.previousPos.x = before.pos.x;
      this.previousPos.y = before.pos.y;
      this.previousPos.z = before.pos.z;
      return;
    }

    this.correctionCount += 1;
    if (error > RECONCILE_SNAP_DISTANCE) {
      // Too far wrong to hide - teleport rather than slide across the map.
      this.smoothing.x = 0;
      this.smoothing.y = 0;
      this.smoothing.z = 0;
    } else {
      // Carry the visual position forward from where it already was and let it
      // decay onto the corrected path over the next few frames.
      this.smoothing.x += before.pos.x - this.state.pos.x;
      this.smoothing.y += before.pos.y - this.state.pos.y;
      this.smoothing.z += before.pos.z - this.state.pos.z;
    }
    this.previousPos.x = this.state.pos.x;
    this.previousPos.y = this.state.pos.y;
    this.previousPos.z = this.state.pos.z;
  }

  /** Exponentially relaxes the correction residual. `dt` is in seconds. */
  decaySmoothing(dt: number): void {
    const factor = Math.exp(-dt / RECONCILE_SMOOTH_TIME);
    this.smoothing.x *= factor;
    this.smoothing.y *= factor;
    this.smoothing.z *= factor;
  }

  /**
   * Where to draw the local player. `alpha` is the fraction of the way from the
   * previous predicted tick to the current one, which keeps a 20 Hz simulation
   * looking smooth at display refresh rates.
   */
  renderPosition(alpha: number, out: Vec3): Vec3 {
    out.x = lerp(this.previousPos.x, this.state.pos.x, alpha) + this.smoothing.x;
    out.y = lerp(this.previousPos.y, this.state.pos.y, alpha) + this.smoothing.y;
    out.z = lerp(this.previousPos.z, this.state.pos.z, alpha) + this.smoothing.z;
    return out;
  }

  get averageError(): number {
    return this.reconcileCount === 0 ? 0 : this.totalError / this.reconcileCount;
  }
}
