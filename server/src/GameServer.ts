import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CONNECTION_TIMEOUT_MS,
  DEFAULT_PORT,
  MAX_PLAYERS,
  MsgType,
  PROTOCOL_VERSION,
  TICK_MS,
  WS_PATH,
  KickReason,
  decodeClientMessage,
  encodeKick,
  encodePong,
  encodeWelcome,
} from '@br/shared';
import { Connection, ConnState } from './Connection.js';
import { StaticFiles } from './StaticFiles.js';
import { TickLoop } from './TickLoop.js';
import { World } from './World.js';

export interface GameServerOptions {
  port?: number;
  seed?: number;
  /** >1 runs the tick loop faster than real time; the simulation dt is unchanged. */
  timeScale?: number;
  log?: (message: string) => void;
  /**
   * Directory of built client files to serve alongside the WebSocket. Omitted in
   * dev, where Vite serves the client and proxies the socket here, and in the
   * sim, which has no browser at all.
   */
  clientDir?: string;
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
  private readonly staticFiles: StaticFiles | null;
  private wss: WebSocketServer | null = null;
  private http: HttpServer | null = null;
  private readonly loop: TickLoop;
  private readonly connections = new Set<Connection>();
  private readonly byPlayerId = new Map<number, Connection>();
  private readonly freeIds: number[] = [];
  readonly world: World;

  readonly errors: ServerError[] = [];

  constructor(options: GameServerOptions = {}) {
    this.requestedPort = options.port ?? DEFAULT_PORT;
    this.seed = (options.seed ?? 0x5eed1234) >>> 0;
    this.timeScale = options.timeScale ?? 1;
    this.log = options.log ?? ((m) => console.log(m));
    this.staticFiles = options.clientDir === undefined ? null : new StaticFiles(options.clientDir);

    this.world = new World(this.seed);
    // Taken from the front and returned to the back, so an id is only reused
    // once every other id has been. Handing a departing player's id straight to
    // the next joiner would let a remote's interpolation buffer blend the two
    // into one body sliding across the map.
    for (let id = 1; id <= MAX_PLAYERS; id++) this.freeIds.push(id);

    this.loop = new TickLoop(
      TICK_MS / this.timeScale,
      () => this.step(),
      MAX_CATCHUP_TICKS,
      (err) => this.recordError(err),
    );
  }

  get tick(): number {
    return this.world.tick;
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
    this.world.starvationSteps = 0;
    this.world.pickupCount = 0;
    this.world.killCount = 0;
    for (const player of this.world.players.values()) player.droppedCommands = 0;
  }

  /**
   * Starts listening. Resolves with the actually bound port (0 => ephemeral).
   *
   * The WebSocket rides on the same HTTP server as the static files, on its own
   * path, so a deployment is one port and one origin - the shape a tunnel or any
   * reverse proxy wants.
   */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const http = createServer((req, res) => {
        void this.onRequest(req, res);
      });
      this.http = http;

      const wss = new WebSocketServer({ server: http, path: WS_PATH });
      this.wss = wss;
      wss.on('connection', (socket) => this.onConnection(socket));
      wss.on('error', (err) => this.recordError(err));

      http.on('error', (err) => {
        this.recordError(err);
        reject(err);
      });
      http.listen(this.requestedPort, () => {
        const address = http.address();
        const port = typeof address === 'object' && address !== null ? address.port : this.requestedPort;
        this.loop.start();
        const what = this.staticFiles === null ? `${WS_PATH} only` : `game + ${WS_PATH}`;
        this.log(`server listening on http://localhost:${port} (${what}, seed ${this.seed}, ${this.timeScale}x)`);
        resolve(port);
      });
    });
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (this.staticFiles !== null && (await this.staticFiles.handle(req, res))) return;
    } catch (err) {
      this.recordError(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  }

  async stop(): Promise<void> {
    this.loop.stop();
    for (const conn of [...this.connections]) conn.close();
    this.connections.clear();
    this.byPlayerId.clear();

    const wss = this.wss;
    const http = this.http;
    this.wss = null;
    this.http = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
    // Closing the ws server leaves the HTTP server listening, so it has to be
    // shut down explicitly or the port stays held.
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
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
        const id = this.freeIds.shift();
        if (id === undefined) {
          this.kick(conn, KickReason.ServerFull);
          return;
        }
        conn.playerId = id;
        conn.name = msg.name.slice(0, 24) || `player${id}`;
        conn.state = ConnState.Playing;
        this.byPlayerId.set(id, conn);
        this.world.addPlayer(id, conn.name);
        conn.send(encodeWelcome(id, this.seed, this.world.mapHash, this.world.tick, performance.now()));
        this.log(`+ ${conn.name} joined as #${id} (${this.byPlayerId.size} online)`);
        break;
      }
      case MsgType.Ping: {
        conn.send(encodePong(msg.clientTime, performance.now(), this.world.tick));
        break;
      }
      case MsgType.Input: {
        if (conn.state !== ConnState.Playing) return;
        const player = this.world.players.get(conn.playerId);
        if (player === undefined) return;
        player.enqueue(msg.commands);
        // Only ever move the baseline forward; a stale ack would make the
        // server delta against something the client has already replaced.
        if (msg.ackTick > player.ackedTick) player.ackedTick = msg.ackTick;
        break;
      }
    }
  }

  private kick(conn: Connection, reason: number): void {
    conn.send(encodeKick(reason));
    this.dropConnection(conn);
  }

  /**
   * Removes a player the moment their socket goes away, mid-round or not.
   *
   * Taking them straight out of the world is what keeps the round honest: the
   * next snapshot carries their id in its removal list so every client drops
   * them, the alive count falls, and a round that is down to its last player
   * ends on the very next tick instead of waiting on someone who is never
   * coming back.
   */
  private dropConnection(conn: Connection): void {
    if (!this.connections.delete(conn)) return;
    const id = conn.playerId;
    if (id !== 0) {
      conn.playerId = 0;
      this.byPlayerId.delete(id);
      this.world.removePlayer(id);
      this.freeIds.push(id);
      this.log(`- ${conn.name} left (${this.byPlayerId.size} online)`);
    }
    conn.close();
  }

  private step(): void {
    const now = performance.now();
    const timeout = CONNECTION_TIMEOUT_MS / this.timeScale;
    for (const conn of [...this.connections]) {
      if (now - conn.lastPacketTime > timeout) {
        this.kick(conn, KickReason.Timeout);
      }
    }

    this.world.step();

    // Copied, because a send that fails drops the connection and mutates the
    // map we would otherwise be iterating.
    for (const conn of [...this.byPlayerId.values()]) {
      const player = this.world.players.get(conn.playerId);
      if (player === undefined) continue;
      conn.send(this.world.snapshotFor(player));
    }
  }
}

function toUint8(data: ArrayBuffer | Buffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
