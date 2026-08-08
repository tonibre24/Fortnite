import {
  INTERP_OFFSET_DRIFT,
  SNAPSHOT_BUFFER_SIZE,
  StateFlag,
  dequantizePitch,
  dequantizeYaw,
  lerp,
  lerpAngle,
  type PlayerState,
} from '@br/shared';

export interface RenderedRemote {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  shield: number;
  onGround: boolean;
}

interface BufferedSnapshot {
  tick: number;
  recvTime: number;
  players: Map<number, PlayerState>;
}

/**
 * Renders every remote player a fixed delay in the past, interpolating between
 * the two snapshots that straddle that moment. Trading a little latency for
 * smoothness is what stops other players from teleporting between the 20 Hz
 * updates - and unlike extrapolation, it never invents motion that did not
 * happen.
 */
export class RemoteInterpolator {
  private readonly buffer: BufferedSnapshot[] = [];
  /** localTime - tick * tickMs, tracking the earliest-arriving snapshot. */
  private offset = 0;
  private hasOffset = false;

  constructor(
    private readonly tickMs: number,
    private readonly delayMs: number,
    private readonly extrapolationLimitMs: number,
  ) {}

  get size(): number {
    return this.buffer.length;
  }

  add(tick: number, players: Map<number, PlayerState>, recvTime: number): void {
    // Snapshots arrive in order over a stream transport; ignore anything stale.
    const newest = this.buffer[this.buffer.length - 1];
    if (newest !== undefined && tick <= newest.tick) return;

    const sample = recvTime - tick * this.tickMs;
    if (!this.hasOffset) {
      this.offset = sample;
      this.hasOffset = true;
    } else if (sample < this.offset) {
      // A packet arrived earlier than our estimate - latency improved, trust it.
      this.offset = sample;
    } else {
      // Drift slowly the other way so a single lucky packet does not pin the
      // clock too early forever.
      this.offset += (sample - this.offset) * INTERP_OFFSET_DRIFT;
    }

    this.buffer.push({ tick, recvTime, players });
    while (this.buffer.length > SNAPSHOT_BUFFER_SIZE) this.buffer.shift();
  }

  /** Fills `out` with every remote player as they should be drawn right now. */
  sample(now: number, excludeId: number, out: Map<number, RenderedRemote>): void {
    out.clear();
    if (this.buffer.length === 0) return;

    const renderTick = (now - this.offset - this.delayMs) / this.tickMs;

    const oldest = this.buffer[0]!;
    if (renderTick <= oldest.tick) {
      this.emit(oldest.players, excludeId, out);
      return;
    }

    const newest = this.buffer[this.buffer.length - 1]!;
    if (renderTick >= newest.tick) {
      const previous = this.buffer[this.buffer.length - 2];
      const aheadMs = (renderTick - newest.tick) * this.tickMs;
      if (previous === undefined || aheadMs > this.extrapolationLimitMs) {
        this.emit(newest.players, excludeId, out);
      } else {
        // Briefly continue the last observed motion so a single late packet
        // does not visibly freeze everyone.
        const span = newest.tick - previous.tick;
        this.emitBlend(previous.players, newest.players, 1 + (renderTick - newest.tick) / span, excludeId, out);
      }
      return;
    }

    let index = this.buffer.length - 1;
    while (index > 0 && this.buffer[index]!.tick > renderTick) index -= 1;
    const a = this.buffer[index]!;
    const b = this.buffer[index + 1]!;
    const t = (renderTick - a.tick) / (b.tick - a.tick);
    this.emitBlend(a.players, b.players, t, excludeId, out);
  }

  private emit(players: Map<number, PlayerState>, excludeId: number, out: Map<number, RenderedRemote>): void {
    for (const [id, state] of players) {
      if (id === excludeId) continue;
      out.set(id, toRendered(state));
    }
  }

  private emitBlend(
    from: Map<number, PlayerState>,
    to: Map<number, PlayerState>,
    t: number,
    excludeId: number,
    out: Map<number, RenderedRemote>,
  ): void {
    // Membership follows the newer snapshot so joins and leaves land on time.
    for (const [id, next] of to) {
      if (id === excludeId) continue;
      const prev = from.get(id);
      if (prev === undefined) {
        out.set(id, toRendered(next));
        continue;
      }
      out.set(id, {
        id,
        x: lerp(prev.pos.x, next.pos.x, t),
        y: lerp(prev.pos.y, next.pos.y, t),
        z: lerp(prev.pos.z, next.pos.z, t),
        yaw: lerpAngle(dequantizeYaw(prev.yawQ), dequantizeYaw(next.yawQ), t),
        pitch: lerp(dequantizePitch(prev.pitchQ), dequantizePitch(next.pitchQ), t),
        health: next.health,
        shield: next.shield,
        onGround: (next.flags & StateFlag.OnGround) !== 0,
      });
    }
  }
}

function toRendered(state: PlayerState): RenderedRemote {
  return {
    id: state.id,
    x: state.pos.x,
    y: state.pos.y,
    z: state.pos.z,
    yaw: dequantizeYaw(state.yawQ),
    pitch: dequantizePitch(state.pitchQ),
    health: state.health,
    shield: state.shield,
    onGround: (state.flags & StateFlag.OnGround) !== 0,
  };
}
