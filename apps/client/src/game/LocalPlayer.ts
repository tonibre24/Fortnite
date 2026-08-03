import {
  FIXED_DT,
  createMovementState,
  stepMovement,
  type ColliderIndex,
  type InputCommand,
  type MovementState,
  type Vec3,
} from '@riftfront/shared';

/**
 * Client-side prediction and server reconciliation for the local player.
 *
 * The client runs the *same* `stepMovement` function as the server at the same fixed
 * timestep, so a correctly predicted frame reproduces the server's result exactly. Each
 * command is kept until the server acknowledges its sequence number; when the server's
 * authoritative position disagrees beyond tolerance, the client snaps to the server state
 * and replays every unacknowledged command on top of it.
 */

/** Position error tolerated before a correction is applied, in metres. */
const RECONCILE_POSITION_TOLERANCE = 0.06;
/** Beyond this the correction is applied instantly instead of being smoothed away. */
const HARD_SNAP_DISTANCE = 2.5;
/** Upper bound on retained commands (~2 s at 60 Hz). */
const MAX_PENDING_COMMANDS = 128;

export interface ReconcileStats {
  corrections: number;
  lastError: number;
  pendingCommands: number;
}

export class LocalPlayer {
  private state: MovementState;
  private readonly pending: InputCommand[] = [];
  private sequence = 0;

  /** Offset blended out over time so small corrections are invisible. */
  private readonly smoothing: Vec3 = { x: 0, y: 0, z: 0 };

  private corrections = 0;
  private lastError = 0;

  constructor(
    private readonly colliders: ColliderIndex,
    spawnPosition: Vec3,
  ) {
    this.state = createMovementState(spawnPosition);
  }

  /** Predicted position, including the residual smoothing offset used for rendering. */
  get renderPosition(): Vec3 {
    return {
      x: this.state.position.x + this.smoothing.x,
      y: this.state.position.y + this.smoothing.y,
      z: this.state.position.z + this.smoothing.z,
    };
  }

  /** Raw predicted position, without visual smoothing. Used for aiming and hit tests. */
  get simulatedPosition(): Vec3 {
    return { ...this.state.position };
  }

  get velocity(): Vec3 {
    return { ...this.state.velocity };
  }

  get grounded(): boolean {
    return this.state.grounded;
  }

  get stats(): ReconcileStats {
    return {
      corrections: this.corrections,
      lastError: this.lastError,
      pendingCommands: this.pending.length,
    };
  }

  /**
   * Steps one fixed simulation tick from the sampled input and returns the command that
   * must be sent to the server.
   */
  step(input: Omit<InputCommand, 'seq'>, frozen: boolean): InputCommand {
    this.sequence += 1;
    const command: InputCommand = { seq: this.sequence, ...input };

    stepMovement(this.state, command, FIXED_DT, this.colliders, { frozen });

    this.pending.push(command);
    if (this.pending.length > MAX_PENDING_COMMANDS) {
      // The server is unreachable or extremely far behind; the oldest commands can no
      // longer be reconciled, so drop them rather than growing without bound.
      this.pending.splice(0, this.pending.length - MAX_PENDING_COMMANDS);
    }

    return command;
  }

  /** Decays the smoothing offset. Called once per rendered frame. */
  updateSmoothing(dtSeconds: number): void {
    const factor = Math.exp(-dtSeconds * 14);
    this.smoothing.x *= factor;
    this.smoothing.y *= factor;
    this.smoothing.z *= factor;
    if (Math.abs(this.smoothing.x) < 0.001) this.smoothing.x = 0;
    if (Math.abs(this.smoothing.y) < 0.001) this.smoothing.y = 0;
    if (Math.abs(this.smoothing.z) < 0.001) this.smoothing.z = 0;
  }

  /**
   * Applies an authoritative snapshot.
   *
   * `lastProcessedSeq` tells us how much of our input the server has consumed; anything
   * newer is replayed on top of the authoritative state.
   */
  reconcile(authoritative: {
    position: Vec3;
    velocity: Vec3;
    grounded: boolean;
    lastProcessedSeq: number;
    frozen: boolean;
  }): void {
    // Drop acknowledged commands.
    while (this.pending.length > 0 && this.pending[0].seq <= authoritative.lastProcessedSeq) {
      this.pending.shift();
    }

    const predictedBefore = { ...this.state.position };

    // Rebuild from the server's truth, preserving our own simulated clock so timers
    // (jump cooldown, coyote time) stay continuous across a correction.
    const clockMs = this.state.timeMs;
    const lastJumpAtMs = this.state.lastJumpAtMs;
    const lastGroundedAtMs = this.state.lastGroundedAtMs;

    this.state.position = { ...authoritative.position };
    this.state.velocity = { ...authoritative.velocity };
    this.state.grounded = authoritative.grounded;
    this.state.timeMs = clockMs;
    this.state.lastJumpAtMs = lastJumpAtMs;
    this.state.lastGroundedAtMs = lastGroundedAtMs;

    for (const command of this.pending) {
      stepMovement(this.state, command, FIXED_DT, this.colliders, { frozen: authoritative.frozen });
    }

    const error = Math.hypot(
      this.state.position.x - predictedBefore.x,
      this.state.position.y - predictedBefore.y,
      this.state.position.z - predictedBefore.z,
    );
    this.lastError = error;

    if (error <= RECONCILE_POSITION_TOLERANCE) {
      // Within tolerance: keep rendering exactly where we were, no visible pop.
      this.smoothing.x = predictedBefore.x - this.state.position.x;
      this.smoothing.y = predictedBefore.y - this.state.position.y;
      this.smoothing.z = predictedBefore.z - this.state.position.z;
      return;
    }

    this.corrections += 1;
    if (error >= HARD_SNAP_DISTANCE) {
      // A teleport, respawn or anti-cheat correction: show it immediately.
      this.smoothing.x = 0;
      this.smoothing.y = 0;
      this.smoothing.z = 0;
      return;
    }

    // Medium correction: move to the authoritative result but blend the visual delta out.
    this.smoothing.x = predictedBefore.x - this.state.position.x;
    this.smoothing.y = predictedBefore.y - this.state.position.y;
    this.smoothing.z = predictedBefore.z - this.state.position.z;
  }

  /** Hard reset, used on respawn and when (re)joining a match. */
  teleport(position: Vec3): void {
    this.state = createMovementState(position, this.state.timeMs);
    this.pending.length = 0;
    this.smoothing.x = 0;
    this.smoothing.y = 0;
    this.smoothing.z = 0;
  }
}
