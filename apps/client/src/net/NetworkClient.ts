import { Client, type Room } from 'colyseus.js';
import {
  ClientMessage,
  INPUT_SEND_MS,
  MAX_COMMANDS_PER_BATCH,
  PROTOCOL_VERSION,
  ServerMessage,
  normalizeRoomCode,
  type DamagedPayload,
  type HitConfirmedPayload,
  type InputCommand,
  type KillPayload,
  type MatchEndedPayload,
  type MatchStartedPayload,
  type MatchStateView,
  type NoticePayload,
  type ReconcilePayload,
  type RespawnedPayload,
  type ShotPayload,
  type Vec3,
  type WeaponId,
  type WelcomePayload,
} from '@riftfront/shared';

/**
 * Transport layer.
 *
 * Owns the Colyseus room, batches outbound input, measures round-trip time and turns
 * connection failures into typed, player-readable errors. It deliberately knows nothing
 * about rendering or gameplay rules.
 */

export type ConnectionErrorCode =
  | 'serverUnavailable'
  | 'roomNotFound'
  | 'roomFull'
  | 'invalidRoomCode'
  | 'protocolMismatch'
  | 'timeout'
  | 'unknown';

export class ConnectionError extends Error {
  constructor(
    readonly code: ConnectionErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export interface NetworkHandlers {
  onWelcome?: (payload: WelcomePayload) => void;
  onShot?: (payload: ShotPayload) => void;
  onHitConfirmed?: (payload: HitConfirmedPayload) => void;
  onDamaged?: (payload: DamagedPayload) => void;
  onKill?: (payload: KillPayload) => void;
  onRespawned?: (payload: RespawnedPayload) => void;
  onMatchStarted?: (payload: MatchStartedPayload) => void;
  onMatchEnded?: (payload: MatchEndedPayload) => void;
  onReconcile?: (payload: ReconcilePayload) => void;
  onNotice?: (payload: NoticePayload) => void;
  onLeave?: (code: number) => void;
  onError?: (code: number, message: string) => void;
}

const CONNECT_TIMEOUT_MS = 12_000;
const PING_INTERVAL_MS = 1_000;

/** Colyseus close/error codes that carry a specific meaning for the player. */
const COLYSEUS_ROOM_NOT_FOUND = 4212;
const COLYSEUS_ROOM_FULL = 4213;
const COLYSEUS_AUTH_FAILED = 4216;

export class NetworkClient {
  private room: Room | null = null;
  private client: Client | null = null;
  private inputBuffer: InputCommand[] = [];
  private lastFlushMs = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private shotSequence = 0;
  private rttMs = 0;
  private serverTimeOffsetMs = 0;
  private disposed = false;

  constructor(
    private readonly serverUrl: string,
    private readonly handlers: NetworkHandlers,
  ) {}

  get isConnected(): boolean {
    return this.room !== null;
  }

  get roundTripMs(): number {
    return this.rttMs;
  }

  get sessionId(): string {
    return this.room?.sessionId ?? '';
  }

  get state(): MatchStateView | null {
    const state = this.room?.state as unknown as MatchStateView | undefined;
    return state?.players ? state : null;
  }

  /** Best estimate of the server's clock, used to align interpolation and timers. */
  get estimatedServerTimeMs(): number {
    return Date.now() + this.serverTimeOffsetMs;
  }

  // -------------------------------------------------------------------------
  // Matchmaking
  // -------------------------------------------------------------------------

  /** Asks the server to allocate a fresh room code. */
  async allocateRoomCode(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      throw new ConnectionError(
        'serverUnavailable',
        'Could not reach the game server. Is it running?',
        error,
      );
    }

    if (!response.ok) {
      throw new ConnectionError('unknown', `Server refused to create a room (${response.status}).`);
    }
    const body = (await response.json()) as { code?: string };
    const code = normalizeRoomCode(body.code);
    if (!code) {
      throw new ConnectionError('unknown', 'Server returned an unusable room code.');
    }
    return code;
  }

  async createRoom(displayName: string): Promise<string> {
    const code = await this.allocateRoomCode();
    await this.connect(displayName, code, 'create');
    return code;
  }

  async joinRoom(displayName: string, rawCode: string): Promise<string> {
    const code = normalizeRoomCode(rawCode);
    if (!code) {
      throw new ConnectionError('invalidRoomCode', 'Room codes are 5 letters or digits.');
    }

    // Checked up front so "room not found" is distinguishable from "server down".
    try {
      const probe = await fetch(`${this.serverUrl}/api/rooms/${code}`);
      if (probe.status === 404) {
        throw new ConnectionError('roomNotFound', `No match is running with code ${code}.`);
      }
      if (probe.status === 400) {
        throw new ConnectionError('invalidRoomCode', 'Room codes are 5 letters or digits.');
      }
    } catch (error) {
      if (error instanceof ConnectionError) throw error;
      throw new ConnectionError(
        'serverUnavailable',
        'Could not reach the game server. Is it running?',
        error,
      );
    }

    await this.connect(displayName, code, 'join');
    return code;
  }

  private async connect(
    displayName: string,
    roomCode: string,
    mode: 'create' | 'join',
  ): Promise<void> {
    this.client = new Client(this.serverUrl);
    const options = { displayName, protocolVersion: PROTOCOL_VERSION, roomCode };

    const attempt =
      mode === 'create'
        ? this.client.joinOrCreate('match', options)
        : this.client.join('match', options);

    let room: Room;
    try {
      room = await withTimeout(attempt, CONNECT_TIMEOUT_MS);
    } catch (error) {
      this.client = null;
      throw toConnectionError(error);
    }

    this.room = room;
    this.registerRoomHandlers(room);
    this.startPingLoop();
  }

  private registerRoomHandlers(room: Room): void {
    room.onMessage(ServerMessage.Welcome, (payload: WelcomePayload) => {
      this.serverTimeOffsetMs = payload.serverTimeMs - Date.now();
      this.handlers.onWelcome?.(payload);
    });

    room.onMessage(
      ServerMessage.Pong,
      (payload: { clientTimeMs: number; serverTimeMs: number }) => {
        const now = Date.now();
        const sample = now - payload.clientTimeMs;
        // Exponential moving average keeps the displayed ping steady under jitter.
        this.rttMs = this.rttMs === 0 ? sample : this.rttMs * 0.8 + sample * 0.2;
        this.serverTimeOffsetMs = payload.serverTimeMs + sample / 2 - now;
      },
    );

    room.onMessage(ServerMessage.Shot, (payload: ShotPayload) => this.handlers.onShot?.(payload));
    room.onMessage(ServerMessage.HitConfirmed, (payload: HitConfirmedPayload) =>
      this.handlers.onHitConfirmed?.(payload),
    );
    room.onMessage(ServerMessage.Damaged, (payload: DamagedPayload) =>
      this.handlers.onDamaged?.(payload),
    );
    room.onMessage(ServerMessage.Kill, (payload: KillPayload) => this.handlers.onKill?.(payload));
    room.onMessage(ServerMessage.Respawned, (payload: RespawnedPayload) =>
      this.handlers.onRespawned?.(payload),
    );
    room.onMessage(ServerMessage.MatchStarted, (payload: MatchStartedPayload) =>
      this.handlers.onMatchStarted?.(payload),
    );
    room.onMessage(ServerMessage.MatchEnded, (payload: MatchEndedPayload) =>
      this.handlers.onMatchEnded?.(payload),
    );
    room.onMessage(ServerMessage.Reconcile, (payload: ReconcilePayload) =>
      this.handlers.onReconcile?.(payload),
    );
    room.onMessage(ServerMessage.Notice, (payload: NoticePayload) =>
      this.handlers.onNotice?.(payload),
    );

    // A message type the client does not understand must never break the session.
    room.onMessage('*', (type) => {
      console.warn('[net] ignoring unrecognised server message', type);
    });

    room.onLeave((code) => {
      this.stopPingLoop();
      this.room = null;
      this.handlers.onLeave?.(code);
    });

    room.onError((code, message) => {
      this.handlers.onError?.(code, message ?? 'Unknown server error');
    });
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      this.room?.send(ClientMessage.Ping, { clientTimeMs: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Outbound gameplay messages
  // -------------------------------------------------------------------------

  /** Queues one simulated command; batches are flushed on a timer. */
  queueInput(command: InputCommand, nowMs: number): void {
    if (!this.room) return;
    this.inputBuffer.push(command);

    const due = nowMs - this.lastFlushMs >= INPUT_SEND_MS;
    if (due || this.inputBuffer.length >= MAX_COMMANDS_PER_BATCH) {
      this.flushInput(nowMs);
    }
  }

  flushInput(nowMs: number): void {
    if (!this.room || this.inputBuffer.length === 0) return;
    const commands = this.inputBuffer.splice(0, MAX_COMMANDS_PER_BATCH);
    this.lastFlushMs = nowMs;
    this.room.send(ClientMessage.Input, { commands, clientTimeMs: Math.round(nowMs) });
  }

  /**
   * Sends a fire intent and returns the shot sequence used, so the caller can derive the
   * identical deterministic spread the server will compute.
   */
  sendFire(direction: Vec3, aiming: boolean, inputSeq: number): number {
    if (!this.room) return -1;
    this.shotSequence += 1;
    this.room.send(ClientMessage.Fire, {
      shotSeq: this.shotSequence,
      direction,
      inputSeq,
      aiming,
      clientTimeMs: Date.now(),
    });
    return this.shotSequence;
  }

  sendReload(): void {
    this.room?.send(ClientMessage.Reload, {});
  }

  sendSwitchWeapon(weaponId: WeaponId): void {
    this.room?.send(ClientMessage.SwitchWeapon, { weaponId });
  }

  sendRespawnRequest(): void {
    this.room?.send(ClientMessage.RequestRespawn, {});
  }

  /** Shot sequences restart per connection, matching the server's per-player counter. */
  resetShotSequence(): void {
    this.shotSequence = 0;
  }

  async leave(): Promise<void> {
    this.stopPingLoop();
    const room = this.room;
    this.room = null;
    this.inputBuffer.length = 0;
    if (room) {
      try {
        await room.leave(true);
      } catch {
        // Already gone; nothing to clean up on the wire.
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.leave();
    this.client = null;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ConnectionError('timeout', 'The server did not respond in time.'));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function toConnectionError(error: unknown): ConnectionError {
  if (error instanceof ConnectionError) return error;

  const code = (error as { code?: number } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);

  if (code === COLYSEUS_ROOM_NOT_FOUND) {
    return new ConnectionError('roomNotFound', 'That match no longer exists.', error);
  }
  if (code === COLYSEUS_ROOM_FULL) {
    return new ConnectionError('roomFull', 'That match is full (8 players maximum).', error);
  }
  if (code === COLYSEUS_AUTH_FAILED || /protocol version/i.test(message)) {
    return new ConnectionError(
      'protocolMismatch',
      'This page is running an old version of the game. Reload to update.',
      error,
    );
  }
  if (/failed to fetch|networkerror|econnrefused|refused/i.test(message)) {
    return new ConnectionError(
      'serverUnavailable',
      'Could not reach the game server. Is it running?',
      error,
    );
  }

  return new ConnectionError('unknown', message || 'Could not join the match.', error);
}
