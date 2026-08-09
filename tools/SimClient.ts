import {
  Button,
  EventType,
  MAX_PITCH,
  PLAYER_EYE_HEIGHT,
  PLAYER_HEIGHT,
  Rng,
  TICK_MS,
  clamp,
  dequantizeYaw,
  distance,
  quantizePitch,
  quantizeYaw,
} from '@br/shared';
import { GameClient, type InputSample, type InputSource } from '../client/src/game/GameClient.js';
import { LaggySocket } from './LaggySocket.js';

export interface SimClientOptions {
  url: string;
  name: string;
  seed: number;
  timeScale: number;
  latencyMs: number;
  jitterMs: number;
  lossPercent: number;
}

/** Ticks a bot holds a movement decision before rerolling it. */
const DECISION_MIN_TICKS = 6;
const DECISION_MAX_TICKS = 30;
const JUMP_CHANCE = 0.08;
const SPRINT_CHANCE = 0.45;
const TURN_RATE = 2.5;
/** How far a bot will engage. */
const ENGAGE_RANGE = 90;
/** Radians of aim error, so bots miss like players do. */
const AIM_ERROR = 0.05;

/**
 * Randomized input that looks enough like a player to exercise every code path:
 * strafing, sprinting, jumping, turning, and standing still.
 */
class BotInput implements InputSource {
  private buttons = 0;
  private yaw = 0;
  private pitch = 0;
  private turn = 0;
  private ticksLeft = 0;
  private client: GameClient | null = null;

  constructor(private readonly rng: Rng) {
    this.yaw = rng.range(-Math.PI, Math.PI);
  }

  attach(client: GameClient): void {
    this.client = client;
  }

  adoptLook(yawQ: number): void {
    this.yaw = dequantizeYaw(yawQ);
  }

  sample(): InputSample {
    if (this.ticksLeft <= 0) this.reroll();
    this.ticksLeft -= 1;

    // Engaging beats wandering. Aiming at the interpolated position - what the
    // bot can actually see - is what puts lag compensation under test: the
    // server has to rewind to agree that the shot connected.
    const target = this.nearestTarget();
    if (target !== null) {
      this.yaw = target.yaw;
      this.pitch = target.pitch;
      return {
        buttons: (this.buttons & ~Button.Sprint) | Button.Fire,
        yawQ: quantizeYaw(this.yaw),
        pitchQ: quantizePitch(this.pitch),
      };
    }

    this.yaw += this.turn * (TICK_MS / 1000);
    this.pitch = clamp(this.pitch, -MAX_PITCH, MAX_PITCH);

    return {
      buttons: this.buttons,
      yawQ: quantizeYaw(this.yaw),
      pitchQ: quantizePitch(this.pitch),
    };
  }

  private nearestTarget(): { yaw: number; pitch: number } | null {
    const client = this.client;
    if (client === null || !client.ready || !client.alive) return null;

    const self = client.predictor.state.pos;
    const eyeY = self.y + PLAYER_EYE_HEIGHT;
    let bestDistSq = ENGAGE_RANGE * ENGAGE_RANGE;
    let bestX = 0;
    let bestY = 0;
    let bestZ = 0;
    let found = false;

    for (const remote of client.remotes.values()) {
      if (!remote.alive) continue;
      const dx = remote.x - self.x;
      const dz = remote.z - self.z;
      const distSq = dx * dx + dz * dz;
      if (distSq >= bestDistSq) continue;
      bestDistSq = distSq;
      bestX = dx;
      bestY = remote.y + PLAYER_HEIGHT * 0.6 - eyeY;
      bestZ = dz;
      found = true;
    }
    if (!found) return null;

    const horizontal = Math.hypot(bestX, bestZ) || 1e-6;
    return {
      yaw: Math.atan2(-bestX, -bestZ) + this.rng.range(-AIM_ERROR, AIM_ERROR),
      pitch: clamp(
        Math.atan2(bestY, horizontal) + this.rng.range(-AIM_ERROR, AIM_ERROR),
        -MAX_PITCH,
        MAX_PITCH,
      ),
    };
  }

  private reroll(): void {
    const rng = this.rng;
    this.ticksLeft = rng.int(DECISION_MIN_TICKS, DECISION_MAX_TICKS);
    this.turn = rng.range(-TURN_RATE, TURN_RATE);
    this.pitch = rng.range(-MAX_PITCH * 0.6, MAX_PITCH * 0.6);

    let buttons = 0;
    if (rng.bool(0.75)) buttons |= rng.bool(0.8) ? Button.Forward : Button.Back;
    if (rng.bool(0.4)) buttons |= rng.bool() ? Button.Left : Button.Right;
    if (rng.bool(SPRINT_CHANCE)) buttons |= Button.Sprint;
    if (rng.bool(JUMP_CHANCE)) buttons |= Button.Jump;
    this.buttons = buttons;
  }
}

/**
 * A fake player. It drives the real GameClient - the same prediction,
 * reconciliation and interpolation the browser runs - over a transport with
 * artificial latency, jitter and loss.
 */
function fmt(s: { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; flags: number; sinceGrounded: number }): string {
  return (
    `pos(${s.pos.x.toFixed(5)},${s.pos.y.toFixed(5)},${s.pos.z.toFixed(5)}) ` +
    `vel(${s.vel.x.toFixed(5)},${s.vel.y.toFixed(5)},${s.vel.z.toFixed(5)}) ` +
    `flags=${s.flags} since=${s.sinceGrounded}`
  );
}

export class SimClient {
  readonly errors: string[] = [];
  readonly client: GameClient;

  private timer: ReturnType<typeof setInterval> | null = null;

  shotsFired = 0;
  hitsLanded = 0;
  killsDealt = 0;

  constructor(private readonly options: SimClientOptions) {
    const rng = new Rng(options.seed);
    const bot = new BotInput(rng);
    // Latency is quoted in simulated time, so compress it like everything else.
    const wallLatency = options.latencyMs / options.timeScale;
    const wallJitter = options.jitterMs / options.timeScale;

    this.client = new GameClient({
      url: options.url,
      name: options.name,
      input: bot,
      timeScale: options.timeScale,
      createSocket: (url) =>
        new LaggySocket(url, {
          latencyMs: wallLatency,
          jitterMs: wallJitter,
          lossPercent: options.lossPercent,
          seed: options.seed ^ 0x9e3779b9,
        }),
      onStatus: (status, detail) => {
        if (status === 'disconnected' && detail !== 'closed') {
          this.errors.push(`${options.name}: ${detail}`);
        }
      },
    });

    bot.attach(this.client);

    this.client.predictor.onCorrection = (before, after, seq, pending) => {
      const d = distance(before.pos, after.pos);
      if (d <= this.worstDistance) return;
      this.worstDistance = d;
      const p = this.client.predictor.pending;
      const range = p.length === 0 ? 'none' : `${p[0]!.seq}..${p[p.length - 1]!.seq}`;
      this.worstCorrection =
        `${options.name} moved ${d.toFixed(4)} lastProcessed=${seq} replayed=${range} (${pending})\n` +
        `      predicted ${fmt(before)}\n` +
        `      authority ${fmt(after)}`;
    };
  }

  /** Details of the largest correction seen, for the report. */
  worstCorrection: string | null = null;
  private worstDistance = 0;

  get playerId(): number {
    return this.client.playerId;
  }

  get rttMs(): number {
    return this.client.connection.rttMs;
  }

  get maxPredictionError(): number {
    return this.client.predictor.maxError;
  }

  get averagePredictionError(): number {
    return this.client.predictor.averageError;
  }

  get corrections(): number {
    return this.client.predictor.correctionCount;
  }

  get reconciles(): number {
    return this.client.predictor.reconcileCount;
  }

  get snapshotsReceived(): number {
    return this.client.snapshotsReceived;
  }

  get snapshotsDropped(): number {
    return this.client.snapshotsDropped;
  }

  get mapHashMatches(): boolean {
    return this.client.mapHashMatches;
  }

  get bytesIn(): number {
    return this.client.connection.bytesIn;
  }

  /** Clears counters so the report covers the measured round, not the warm-up. */
  resetStats(): void {
    const p = this.client.predictor;
    p.lastError = 0;
    p.maxError = 0;
    p.totalError = 0;
    p.reconcileCount = 0;
    p.correctionCount = 0;
    this.worstCorrection = null;
    this.worstDistance = 0;
    this.client.snapshotsReceived = 0;
    this.client.snapshotsDropped = 0;
    this.client.snapshotsStale = 0;
    this.shotsFired = 0;
    this.hitsLanded = 0;
    this.killsDealt = 0;
    this.client.connection.bytesIn = 0;
    this.client.connection.packetsIn = 0;
    this.errors.length = 0;
  }

  get remoteCount(): number {
    return this.client.remotes.size;
  }

  get alive(): boolean {
    return this.client.ready && this.client.alive;
  }

  /** Drains queued events and folds them into the combat counters. */
  private consumeEvents(): void {
    for (const event of this.client.drainEvents()) {
      if (event.type === EventType.Shot && event.shooterId === this.playerId) this.shotsFired += 1;
      else if (event.type === EventType.Hit) {
        this.hitsLanded += 1;
        if (event.killed) this.killsDealt += 1;
      }
    }
  }

  /** Distance between our predicted position and the server's latest word on it. */
  positionErrorVersus(serverPos: { x: number; y: number; z: number }): number {
    return distance(this.client.predictor.state.pos, serverPos);
  }

  start(): void {
    this.client.connect();
    // Browsers drive this from requestAnimationFrame at display rate; a timer
    // faster than the tick rate reproduces that here.
    const frameMs = TICK_MS / this.options.timeScale / 3;
    this.timer = setInterval(() => {
      try {
        this.client.update(performance.now());
        this.consumeEvents();
      } catch (err) {
        this.errors.push(`${this.options.name}: ${err instanceof Error ? err.stack : String(err)}`);
      }
    }, frameMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.client.disconnect();
  }
}
