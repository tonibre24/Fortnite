import { Client, type Room } from 'colyseus.js';
import {
  ClientMessage,
  FIXED_DT_MS,
  INPUT_SPRINT,
  PLAYER_EYE_HEIGHT,
  PROTOCOL_VERSION,
  ServerMessage,
  normalizeVec3,
  type DamagedPayload,
  type HitConfirmedPayload,
  type KillPayload,
  type MatchEndedPayload,
  type MatchStateView,
  type PlayerView,
  type ShotPayload,
  type Vec3,
  type WelcomePayload,
} from '@riftfront/shared';

export interface BotEvents {
  welcome: WelcomePayload[];
  shots: ShotPayload[];
  hits: HitConfirmedPayload[];
  damaged: DamagedPayload[];
  kills: KillPayload[];
  matchEnded: MatchEndedPayload[];
}

/**
 * A headless client used by the integration suite.
 *
 * It speaks the real protocol over a real WebSocket: same message types, same
 * validation path, same 60 Hz input cadence as the browser client. It intentionally
 * performs no prediction — it reads its own position back from replicated state, so a
 * passing test proves the *server* moved the player.
 */
export class BotClient {
  readonly events: BotEvents = {
    welcome: [],
    shots: [],
    hits: [],
    damaged: [],
    kills: [],
    matchEnded: [],
  };

  private inputSeq = 0;
  private shotSeq = 0;
  private yaw = 0;
  private pitch = 0;
  private disposed = false;

  private constructor(
    readonly room: Room,
    readonly displayName: string,
  ) {
    this.registerHandlers();
  }

  static async create(
    httpUrl: string,
    displayName: string,
    roomCode: string,
    mode: 'create' | 'join',
  ): Promise<BotClient> {
    const client = new Client(httpUrl);
    const options = { displayName, protocolVersion: PROTOCOL_VERSION, roomCode };
    const room =
      mode === 'create'
        ? await client.joinOrCreate('match', options)
        : await client.join('match', options);
    const bot = new BotClient(room, displayName);
    await bot.waitUntilStateReady();
    return bot;
  }

  /**
   * Resolves once the first state patch has been decoded. Colyseus builds `room.state`
   * from the reflected schema after the handshake, so it is briefly undefined.
   */
  async waitUntilStateReady(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.room.state as unknown as MatchStateView | undefined;
      if (state?.players?.get(this.sessionId)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`${this.displayName}: room state was not ready within ${timeoutMs}ms`);
  }

  private registerHandlers(): void {
    this.room.onMessage(ServerMessage.Welcome, (payload: WelcomePayload) => {
      this.events.welcome.push(payload);
    });
    this.room.onMessage(ServerMessage.Shot, (payload: ShotPayload) => {
      this.events.shots.push(payload);
    });
    this.room.onMessage(ServerMessage.HitConfirmed, (payload: HitConfirmedPayload) => {
      this.events.hits.push(payload);
    });
    this.room.onMessage(ServerMessage.Damaged, (payload: DamagedPayload) => {
      this.events.damaged.push(payload);
    });
    this.room.onMessage(ServerMessage.Kill, (payload: KillPayload) => {
      this.events.kills.push(payload);
    });
    this.room.onMessage(ServerMessage.MatchEnded, (payload: MatchEndedPayload) => {
      this.events.matchEnded.push(payload);
    });
    // Messages the bot does not care about still need a sink, otherwise colyseus.js
    // logs a warning for every unhandled type.
    this.room.onMessage(ServerMessage.Pong, () => undefined);
    this.room.onMessage(ServerMessage.Respawned, () => undefined);
    this.room.onMessage(ServerMessage.Reconcile, () => undefined);
    this.room.onMessage(ServerMessage.MatchStarted, () => undefined);
    this.room.onMessage(ServerMessage.Notice, () => undefined);
  }

  get state(): MatchStateView {
    return this.room.state;
  }

  get sessionId(): string {
    return this.room.sessionId;
  }

  get self(): PlayerView | undefined {
    return this.state.players.get(this.sessionId);
  }

  get position(): Vec3 {
    const self = this.self;
    return self ? { x: self.x, y: self.y, z: self.z } : { x: 0, y: 0, z: 0 };
  }

  others(): PlayerView[] {
    const result: PlayerView[] = [];
    this.state.players.forEach((player, key) => {
      if (key !== this.sessionId) result.push(player);
    });
    return result;
  }

  /** Sends a single 60 Hz input command. */
  sendInput(moveX: number, moveZ: number, buttons = 0): void {
    if (this.disposed) return;
    this.inputSeq++;
    this.room.send(ClientMessage.Input, {
      commands: [
        {
          seq: this.inputSeq,
          moveX,
          moveZ,
          yaw: this.yaw,
          pitch: this.pitch,
          buttons,
        },
      ],
      clientTimeMs: Date.now() % 1_000_000,
    });
  }

  fireAt(target: Vec3): void {
    if (this.disposed) return;
    const origin = this.position;
    const direction = normalizeVec3({
      x: target.x - origin.x,
      y: target.y - (origin.y + PLAYER_EYE_HEIGHT),
      z: target.z - origin.z,
    });
    this.shotSeq++;
    this.room.send(ClientMessage.Fire, {
      shotSeq: this.shotSeq,
      direction,
      inputSeq: this.inputSeq,
      aiming: true,
      clientTimeMs: Date.now() % 1_000_000,
    });
  }

  reload(): void {
    if (!this.disposed) this.room.send(ClientMessage.Reload, {});
  }

  /** Points the bot at a world position (used both for movement and aiming). */
  faceTowards(target: Vec3): void {
    const origin = this.position;
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    this.yaw = Math.atan2(dx, dz);

    const horizontal = Math.hypot(dx, dz);
    const dy = target.y + 1.0 - (origin.y + PLAYER_EYE_HEIGHT);
    this.pitch = -Math.atan2(dy, Math.max(0.001, horizontal));
  }

  /** Raw yaw control, used to nudge the bot around geometry it is stuck on. */
  setYaw(yaw: number): void {
    this.yaw = yaw;
  }

  get currentYaw(): number {
    return this.yaw;
  }

  get aimDirection(): Vec3 {
    return normalizeVec3({
      x: Math.sin(this.yaw) * Math.cos(this.pitch),
      y: -Math.sin(this.pitch),
      z: Math.cos(this.yaw) * Math.cos(this.pitch),
    });
  }

  sprintButtons(): number {
    return INPUT_SPRINT;
  }

  async leave(consented = true): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.room.leave(consented);
  }
}

export const INPUT_INTERVAL_MS = FIXED_DT_MS;
