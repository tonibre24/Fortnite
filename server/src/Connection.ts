import type { WebSocket } from 'ws';

export const ConnState = {
  Pending: 0,
  Playing: 1,
  Closed: 2,
} as const;

/** One websocket and everything the server tracks per connected client. */
export class Connection {
  state: number = ConnState.Pending;
  playerId = 0;
  name = '';
  lastPacketTime: number;

  constructor(
    readonly socket: WebSocket,
    now: number,
  ) {
    this.lastPacketTime = now;
  }

  send(data: ArrayBuffer): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(data, { binary: true });
  }

  close(): void {
    this.state = ConnState.Closed;
    try {
      this.socket.close();
    } catch {
      // Socket already torn down; nothing to do.
    }
  }
}
