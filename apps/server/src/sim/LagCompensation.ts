import {
  LAG_COMPENSATION_HISTORY_MS,
  LAG_COMPENSATION_MAX_MS,
  clamp,
  lerpVec3,
  type Vec3,
} from '@riftfront/shared';

export interface PositionSample {
  timeMs: number;
  position: Vec3;
  alive: boolean;
}

/**
 * Bounded per-player position history used to rewind the world when resolving
 * hitscan shots.
 *
 * The buffer is hard-capped by both age and entry count so a long-lived room cannot
 * grow memory without bound, and so a client cannot request an arbitrarily deep rewind.
 */
export class PositionHistory {
  private readonly samples: PositionSample[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 128) {
    this.maxEntries = maxEntries;
  }

  record(timeMs: number, position: Vec3, alive: boolean): void {
    this.samples.push({ timeMs, position: { x: position.x, y: position.y, z: position.z }, alive });

    const cutoff = timeMs - LAG_COMPENSATION_HISTORY_MS;
    while (this.samples.length > 0 && this.samples[0].timeMs < cutoff) {
      this.samples.shift();
    }
    while (this.samples.length > this.maxEntries) {
      this.samples.shift();
    }
  }

  get size(): number {
    return this.samples.length;
  }

  clear(): void {
    this.samples.length = 0;
  }

  /**
   * Position at `targetTimeMs`, interpolated between the two surrounding samples.
   * Falls back to the newest sample when the requested time is outside the buffer.
   */
  sampleAt(targetTimeMs: number): PositionSample | null {
    if (this.samples.length === 0) return null;

    const newest = this.samples[this.samples.length - 1];
    if (targetTimeMs >= newest.timeMs) return newest;

    const oldest = this.samples[0];
    if (targetTimeMs <= oldest.timeMs) return oldest;

    for (let i = this.samples.length - 1; i > 0; i--) {
      const after = this.samples[i];
      const before = this.samples[i - 1];
      if (targetTimeMs >= before.timeMs && targetTimeMs <= after.timeMs) {
        const span = after.timeMs - before.timeMs;
        const t = span <= 0 ? 0 : (targetTimeMs - before.timeMs) / span;
        return {
          timeMs: targetTimeMs,
          position: lerpVec3(before.position, after.position, t),
          // A player counts as hittable only if they were alive at both ends of the span.
          alive: before.alive && after.alive,
        };
      }
    }

    return newest;
  }
}

/**
 * How far back the world is rewound for a given shooter: half their round-trip time
 * plus the client's interpolation delay, clamped to the configured maximum.
 */
export function rewindAmountMs(rttMs: number, interpolationDelayMs: number): number {
  return clamp(rttMs / 2 + interpolationDelayMs, 0, LAG_COMPENSATION_MAX_MS);
}
