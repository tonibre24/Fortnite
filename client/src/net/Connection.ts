import {
  KICK_TEXT,
  MsgType,
  PING_INTERVAL_MS,
  decodeServerMessage,
  encodeJoin,
  encodePing,
  type WelcomeMsg,
} from '@br/shared';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * The slice of the WebSocket API this client uses. The sim harness supplies an
 * implementation that adds artificial latency, jitter and loss.
 */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: ArrayBuffer): void;
  close(): void;
}

export interface ConnectionHandlers {
  onStatus?: (status: ConnectionStatus, detail: string) => void;
  onWelcome?: (msg: WelcomeMsg) => void;
}

export interface ConnectionOptions {
  url: string;
  name: string;
  handlers?: ConnectionHandlers;
  /** Matches the server's accelerated clock when running under the sim harness. */
  timeScale?: number;
  /** Overridable so tests can inject a lossy/laggy transport. */
  createSocket?: (url: string) => SocketLike;
}

/**
 * Browser/Node agnostic socket wrapper. Node 22 ships the WHATWG WebSocket
 * global, so the headless sim harness drives this exact class rather than a
 * reimplementation - the netcode under test is the netcode that ships.
 */
export class Connection {
  status: ConnectionStatus = 'connecting';
  playerId = 0;
  mapSeed = 0;
  serverTick = 0;
  /** Smoothed round-trip time in milliseconds. */
  rttMs = 0;
  /** localTime + serverTimeOffset ~= server clock. Taken from the best RTT sample. */
  serverTimeOffset = 0;

  private socket: SocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private bestRtt = Number.POSITIVE_INFINITY;
  private readonly handlers: ConnectionHandlers;
  private readonly timeScale: number;
  private closedByUs = false;

  constructor(private readonly options: ConnectionOptions) {
    this.handlers = options.handlers ?? {};
    this.timeScale = options.timeScale ?? 1;
  }

  connect(): void {
    this.setStatus('connecting', this.options.url);
    const create = this.options.createSocket ?? ((url: string) => new WebSocket(url) as SocketLike);
    const socket = create(this.options.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.send(encodeJoin(this.options.name));
      this.sendPing();
      this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS / this.timeScale);
    };
    socket.onmessage = (event) => {
      this.onMessage(event.data);
    };
    socket.onclose = () => {
      this.teardown(this.closedByUs ? 'closed' : 'connection lost');
    };
    socket.onerror = () => {
      this.teardown('socket error');
    };
  }

  close(): void {
    this.closedByUs = true;
    this.socket?.close();
    this.teardown('closed');
  }

  send(data: ArrayBuffer): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(data);
  }

  private onMessage(data: ArrayBuffer): void {
    const msg = decodeServerMessage(data);
    if (msg === null) return;

    switch (msg.type) {
      case MsgType.Welcome: {
        this.playerId = msg.playerId;
        this.mapSeed = msg.mapSeed;
        this.serverTick = msg.tick;
        this.setStatus('connected', `#${msg.playerId}`);
        this.handlers.onWelcome?.(msg);
        break;
      }
      case MsgType.Pong: {
        const now = performance.now();
        const rtt = now - msg.clientTime;
        this.rttMs = this.rttMs === 0 ? rtt : this.rttMs * 0.8 + rtt * 0.2;
        // Only the lowest-latency samples give a trustworthy clock offset.
        if (rtt <= this.bestRtt) {
          this.bestRtt = rtt;
          this.serverTimeOffset = msg.serverTime + rtt / 2 - now;
        }
        this.serverTick = msg.tick;
        break;
      }
      case MsgType.Kick: {
        this.closedByUs = true;
        this.teardown(`kicked: ${KICK_TEXT[msg.reason] ?? 'unknown reason'}`);
        this.socket?.close();
        break;
      }
    }
  }

  private sendPing(): void {
    this.send(encodePing(performance.now()));
  }

  private teardown(detail: string): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.status !== 'disconnected') this.setStatus('disconnected', detail);
  }

  private setStatus(status: ConnectionStatus, detail: string): void {
    this.status = status;
    this.handlers.onStatus?.(status, detail);
  }
}
