import type { SocketLike } from '../client/src/net/Connection.js';
import { MsgType, Rng } from '@br/shared';

type Direction = 'in' | 'out';

interface Delivery {
  at: number;
  action: () => void;
}

export interface LaggyOptions {
  /** One-way delay is half of this. Already scaled to wall-clock by the caller. */
  latencyMs: number;
  jitterMs: number;
  lossPercent: number;
  seed: number;
}

/**
 * Wraps a real WebSocket and adds one-way delay, jitter and (optional) loss in
 * both directions. Delivery order is kept monotonic so jitter behaves like
 * queueing delay rather than reordering, which a TCP-based transport cannot do.
 */
export class LaggySocket implements SocketLike {
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  private readonly inner: WebSocket;
  private readonly rng: Rng;
  private readonly opts: LaggyOptions;
  private readonly queues: Record<Direction, Delivery[]> = { in: [], out: [] };
  private readonly timers: Record<Direction, ReturnType<typeof setTimeout> | null> = {
    in: null,
    out: null,
  };
  private closed = false;

  constructor(url: string, opts: LaggyOptions) {
    this.opts = opts;
    this.rng = new Rng(opts.seed);
    this.inner = new WebSocket(url);
    this.inner.binaryType = 'arraybuffer';

    this.inner.onopen = () => this.onopen?.();
    this.inner.onclose = () => {
      this.closed = true;
      this.clearTimers();
      this.onclose?.();
    };
    this.inner.onerror = () => this.onerror?.();
    this.inner.onmessage = (event: MessageEvent) => {
      const data = event.data as ArrayBuffer;
      this.deliverLater('in', () => this.onmessage?.({ data }), data);
    };
  }

  get readyState(): number {
    return this.inner.readyState;
  }

  send(data: ArrayBuffer): void {
    this.deliverLater(
      'out',
      () => {
        if (this.inner.readyState === WebSocket.OPEN) this.inner.send(data);
      },
      data,
    );
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    this.inner.close();
  }

  private deliverLater(direction: Direction, action: () => void, data: ArrayBuffer): void {
    if (this.closed) return;
    if (this.opts.lossPercent > 0 && isDroppable(data) && this.rng.next() * 100 < this.opts.lossPercent) {
      return;
    }

    const oneWay = this.opts.latencyMs / 2;
    const jitter = this.rng.next() * this.opts.jitterMs;
    const queue = this.queues[direction];
    const last = queue[queue.length - 1];
    // Never schedule ahead of something already queued: a stream transport
    // cannot reorder, and one setTimeout per message would, because timer
    // delays are truncated to whole milliseconds.
    const at = Math.max(performance.now() + oneWay + jitter, last?.at ?? 0);
    queue.push({ at, action });
    if (queue.length === 1) this.schedule(direction);
  }

  /** One timer per direction, draining the queue strictly in order. */
  private schedule(direction: Direction): void {
    const queue = this.queues[direction];
    const head = queue[0];
    if (head === undefined || this.closed) return;
    this.timers[direction] = setTimeout(
      () => {
        this.timers[direction] = null;
        if (this.closed) return;
        const now = performance.now();
        while (queue.length > 0 && queue[0]!.at <= now) queue.shift()!.action();
        this.schedule(direction);
      },
      Math.max(0, head.at - performance.now()),
    );
  }

  private clearTimers(): void {
    for (const direction of ['in', 'out'] as const) {
      const timer = this.timers[direction];
      if (timer !== null) clearTimeout(timer);
      this.timers[direction] = null;
      this.queues[direction].length = 0;
    }
  }
}

/**
 * The real transport is WebSocket over TCP and cannot lose anything. The loss
 * knob is fault injection aimed at the per-tick flow, where recovery is the
 * client's job: input redundancy repairs a lost command, and a stale delta
 * baseline forces a full resend. Dropping the handshake instead would only test
 * whether a client that never sent a join can play, so it is left alone.
 */
function isDroppable(data: ArrayBuffer): boolean {
  if (data.byteLength === 0) return false;
  const type = new Uint8Array(data)[0];
  return type === MsgType.Input || type === MsgType.Snapshot;
}
