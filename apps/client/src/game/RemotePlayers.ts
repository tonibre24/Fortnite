import {
  INTERPOLATION_DELAY_MS,
  lerp,
  lerpAngle,
  type PlayerView,
  type Vec3,
} from '@riftfront/shared';

/**
 * Snapshot interpolation for remote players.
 *
 * The server broadcasts at 20 Hz while the client renders at 60+ Hz, so remote avatars
 * are rendered `INTERPOLATION_DELAY_MS` in the past and interpolated between the two
 * snapshots that bracket that time. The delay is what makes remote movement smooth
 * rather than a 20 Hz stutter, and it is the same delay the server compensates for when
 * rewinding hitscan shots.
 */

interface Snapshot {
  timeMs: number;
  position: Vec3;
  yaw: number;
  pitch: number;
  moving: boolean;
  sprinting: boolean;
  aiming: boolean;
  alive: boolean;
  /** Replicated so remote avatars can play the airborne poses, not just the ground ones. */
  grounded: boolean;
  verticalVelocity: number;
}

/** ~1.5 s of history at 20 Hz. Bounded so a long match cannot grow memory. */
const MAX_SNAPSHOTS = 32;
/** Beyond this gap the entity is teleported rather than interpolated (respawn, lag spike). */
const TELEPORT_DISTANCE = 6;

export interface InterpolatedTransform {
  position: Vec3;
  yaw: number;
  pitch: number;
  moving: boolean;
  sprinting: boolean;
  aiming: boolean;
  alive: boolean;
  grounded: boolean;
  verticalVelocity: number;
}

class RemoteEntity {
  private readonly snapshots: Snapshot[] = [];
  private lastRendered: InterpolatedTransform | null = null;

  record(player: PlayerView, serverTimeMs: number): void {
    const latest = this.snapshots[this.snapshots.length - 1];
    if (latest && latest.timeMs >= serverTimeMs) {
      // Duplicate or out-of-order patch: keep the newest values but do not add a sample.
      latest.position = { x: player.x, y: player.y, z: player.z };
      latest.yaw = player.yaw;
      latest.pitch = player.pitch;
      latest.alive = player.alive;
      latest.grounded = player.grounded;
      latest.verticalVelocity = player.vy;
      return;
    }

    this.snapshots.push({
      timeMs: serverTimeMs,
      position: { x: player.x, y: player.y, z: player.z },
      yaw: player.yaw,
      pitch: player.pitch,
      moving: player.moving,
      sprinting: player.sprinting,
      aiming: player.aiming,
      alive: player.alive,
      grounded: player.grounded,
      verticalVelocity: player.vy,
    });

    while (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
  }

  /** Interpolated transform at `renderTimeMs`, or null when no data has arrived yet. */
  sample(renderTimeMs: number): InterpolatedTransform | null {
    if (this.snapshots.length === 0) return this.lastRendered;

    if (this.snapshots.length === 1) {
      const only = this.snapshots[0];
      this.lastRendered = toTransform(only);
      return this.lastRendered;
    }

    const newest = this.snapshots[this.snapshots.length - 1];
    if (renderTimeMs >= newest.timeMs) {
      // Ahead of the buffer (a dropped packet): hold the last known pose rather than
      // extrapolating, which would produce rubber-banding on packet loss.
      this.lastRendered = toTransform(newest);
      return this.lastRendered;
    }

    const oldest = this.snapshots[0];
    if (renderTimeMs <= oldest.timeMs) {
      this.lastRendered = toTransform(oldest);
      return this.lastRendered;
    }

    for (let i = this.snapshots.length - 1; i > 0; i--) {
      const after = this.snapshots[i];
      const before = this.snapshots[i - 1];
      if (renderTimeMs < before.timeMs || renderTimeMs > after.timeMs) continue;

      const span = after.timeMs - before.timeMs;
      const t = span <= 0 ? 1 : (renderTimeMs - before.timeMs) / span;

      const jump = Math.hypot(
        after.position.x - before.position.x,
        after.position.y - before.position.y,
        after.position.z - before.position.z,
      );

      // A respawn or correction moved the entity a long way in one patch; snapping is
      // more readable than sliding a character across the arena.
      const position =
        jump > TELEPORT_DISTANCE
          ? after.position
          : {
              x: lerp(before.position.x, after.position.x, t),
              y: lerp(before.position.y, after.position.y, t),
              z: lerp(before.position.z, after.position.z, t),
            };

      this.lastRendered = {
        position,
        yaw: lerpAngle(before.yaw, after.yaw, t),
        pitch: lerp(before.pitch, after.pitch, t),
        moving: after.moving,
        sprinting: after.sprinting,
        aiming: after.aiming,
        alive: after.alive,
        grounded: after.grounded,
        verticalVelocity: after.verticalVelocity,
      };
      return this.lastRendered;
    }

    this.lastRendered = toTransform(newest);
    return this.lastRendered;
  }

  clear(): void {
    this.snapshots.length = 0;
    this.lastRendered = null;
  }

  get snapshotCount(): number {
    return this.snapshots.length;
  }
}

function toTransform(snapshot: Snapshot): InterpolatedTransform {
  return {
    position: snapshot.position,
    yaw: snapshot.yaw,
    pitch: snapshot.pitch,
    moving: snapshot.moving,
    sprinting: snapshot.sprinting,
    aiming: snapshot.aiming,
    alive: snapshot.alive,
    grounded: snapshot.grounded,
    verticalVelocity: snapshot.verticalVelocity,
  };
}

export class RemotePlayerBuffer {
  private readonly entities = new Map<string, RemoteEntity>();
  private latestServerTimeMs = 0;

  /** Feeds one replicated player into its history buffer. */
  record(playerId: string, player: PlayerView, serverTimeMs: number): void {
    let entity = this.entities.get(playerId);
    if (!entity) {
      entity = new RemoteEntity();
      this.entities.set(playerId, entity);
    }
    entity.record(player, serverTimeMs);
    this.latestServerTimeMs = Math.max(this.latestServerTimeMs, serverTimeMs);
  }

  /** The server time remote entities are rendered at. */
  get renderTimeMs(): number {
    return this.latestServerTimeMs - INTERPOLATION_DELAY_MS;
  }

  sample(playerId: string): InterpolatedTransform | null {
    return this.entities.get(playerId)?.sample(this.renderTimeMs) ?? null;
  }

  remove(playerId: string): void {
    this.entities.get(playerId)?.clear();
    this.entities.delete(playerId);
  }

  clear(): void {
    for (const entity of this.entities.values()) entity.clear();
    this.entities.clear();
    this.latestServerTimeMs = 0;
  }

  get trackedCount(): number {
    return this.entities.size;
  }

  /** Total buffered snapshots, surfaced by the performance panel. */
  get bufferedSnapshots(): number {
    let total = 0;
    for (const entity of this.entities.values()) total += entity.snapshotCount;
    return total;
  }
}
