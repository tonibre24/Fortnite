import { WebSocketServer, type WebSocket } from 'ws';
import {
  CONNECTION_TIMEOUT_MS,
  DEFAULT_PORT,
  MAX_PLAYERS,
  MsgType,
  PROTOCOL_VERSION,
  TICK_MS,
  KickReason,
  decodeClientMessage,
  encodeKick,
  encodePong,
  encodeWelcome,
} from '@br/shared';
import { Connection, ConnState } from './Connection.js';
import { TickLoop } from './TickLoop.js';

export interface GameServerOptions {
  port?: number;
  seed?: number;
  /** >1 runs the tick loop faster than real time; the simulation dt is unchanged. */
  timeScale?: number;
  log?: (message: string) => void;
}

export interface ServerError {
  message: string;
  stack: string;
}

/** Maximum ticks the loop may run back-to-back while catching up after a stall. */
const MAX_CATCHUP_TICKS = 5;

export class GameServer {
  readonly seed: number;
  readonly timeScale: number;

  private readonly log: (message: string) => void;
  private readonly requestedPort: number;
  private wss: WebSocketServer | null = null;
  private readonly loop: TickLoop;
  private readonly connections = new Set<Connection>();
  private readonly byPlayerId = new Map<number, Connection>();
  private readonly freeIds: number[] = [];
  private currentTick = 0;

  readonly errors: ServerError[] = [];

  constructor(options: GameServerOptions = {}) {
    this.requestedPort = options.port ?? DEFAULT_PORT;
    this.seed = (options.seed ?? 0x5eed1234) >>> 0;
    this.timeScale = options.timeScale ?? 1;
    this.log = options.log ?? ((m) => console.log(m));

    for (let id = MAX_PLAYERS; id >= 1; id--) this.freeIds.push(id);

    this.loop = new TickLoop(
      TICK_MS / this.timeScale,
      () => this.step(),
      MAX_CATCHUP_TICKS,
      (err) => this.recordError(err),
    );
  }

  get tick(): number {
    return this.currentTick;
  }

  get playerCount(): number {
    return this.byPlayerId.size;
  }

  get tickStats() {
    return this.loop.stats;
  }

  get averageTickMs(): number {
    return this.loop.averageDurationMs;
  }

  /** Drops accumulated tick counters so a benchmark can exclude warm-up. */
  resetStats(): void {
    this.loop.resetStats();
    this.errors.length = 0;
  }

  /** Starts listening. Resolves with the actually bound port (0 => ephemeral). */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.requestedPort });
      this.wss = wss;
      wss.on('connection', (socket) => this.onConnection(socket));
      wss.on('error', (err) => {
        this.recordError(err);
        reject(err);
      });
      wss.on('listening', () => {
        const address = wss.address();
        const port = typeof address === 'object' && address !== null ? address.port : this.requestedPort;
        this.loop.start();
        this.log(`server listening on ws://localhost:${port} (seed ${this.seed}, ${this.timeScale}x)`);
        resolve(port);
      });
    });
  }

  async stop(): Promise<void> {
    this.loop.stop();
    for (const conn of [...this.connections]) conn.close();
    this.connections.clear();
    this.byPlayerId.clear();
    const wss = this.wss;
    if (!wss) return;
    this.wss = null;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  private recordError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.errors.push({ message: error.message, stack: error.stack ?? '' });
    this.log(`error: ${error.message}`);
  }

  private onConnection(socket: WebSocket): void {
    const conn = new Connection(socket, performance.now());
    this.connections.add(conn);

    socket.binaryType = 'arraybuffer';
    socket.on('message', (data: ArrayBuffer | Buffer | Buffer[]) => {
      try {
        this.onMessage(conn, toUint8(data));
      } catch (err) {
        this.recordError(err);
      }
    });
    socket.on('close', () => this.dropConnection(conn));
    socket.on('error', () => this.dropConnection(conn));
  }

  private onMessage(conn: Connection, bytes: Uint8Array): void {
    if (conn.state === ConnState.Closed) return;
    conn.lastPacketTime = performance.now();

    const msg = decodeClientMessage(bytes);
    if (msg === null) {
      this.kick(conn, KickReason.BadMessage);
      return;
    }

    switch (msg.type) {
      case MsgType.Join: {
        if (conn.state !== ConnState.Pending) return;
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.kick(conn, KickReason.BadProtocol);
          return;
        }
        const id = this.freeIds.pop();
        if (id === undefined) {
          this.kick(conn, KickReason.ServerFull);
          return;
        }
        conn.playerId = id;
        conn.name = msg.name.slice(0, 24) || `player${id}`;
        conn.state = ConnState.Playing;
        this.byPlayerId.set(id, conn);
        conn.send(encodeWelcome(id, this.seed, this.currentTick, performance.now()));
        this.log(`+ ${conn.name} joined as #${id} (${this.byPlayerId.size} online)`);
        break;
      }
      case MsgType.Ping: {
        conn.send(encodePong(msg.clientTime, performance.now(), this.currentTick));
        break;
      }
    }
  }

  private kick(conn: Connection, reason: number): void {
    conn.send(encodeKick(reason));
    this.dropConnection(conn);
  }

  private dropConnection(conn: Connection): void {
    if (!this.connections.delete(conn)) return;
    if (conn.playerId !== 0) {
      this.byPlayerId.delete(conn.playerId);
      this.freeIds.push(conn.playerId);
      this.log(`- ${conn.name} left (${this.byPlayerId.size} online)`);
    }
    conn.close();
  }

  private step(): void {
    this.currentTick += 1;

    const now = performance.now();
    const timeout = CONNECTION_TIMEOUT_MS / this.timeScale;
    for (const conn of [...this.connections]) {
      if (now - conn.lastPacketTime > timeout) {
        this.kick(conn, KickReason.Timeout);
      }
    }
  }
}

function toUint8(data: ArrayBuffer | Buffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
