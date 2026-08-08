import type { SocketLike } from '../client/src/net/Connection.js';
import { Rng } from '@br/shared';

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
  private nextInboundAt = 0;
  private nextOutboundAt = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
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
      this.deliverLater('in', () => this.onmessage?.({ data }));
    };
  }

  get readyState(): number {
    return this.inner.readyState;
  }

  send(data: ArrayBuffer): void {
    this.deliverLater('out', () => {
      if (this.inner.readyState === WebSocket.OPEN) this.inner.send(data);
    });
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    this.inner.close();
  }

  private deliverLater(direction: 'in' | 'out', action: () => void): void {
    if (this.closed) return;
    if (this.opts.lossPercent > 0 && this.rng.next() * 100 < this.opts.lossPercent) return;

    const oneWay = this.opts.latencyMs / 2;
    const jitter = this.rng.next() * this.opts.jitterMs;
    const now = performance.now();
    const earliest = now + oneWay + jitter;
    const queue = direction === 'in' ? this.nextInboundAt : this.nextOutboundAt;
    const at = Math.max(earliest, queue);
    if (direction === 'in') this.nextInboundAt = at;
    else this.nextOutboundAt = at;

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) action();
    }, Math.max(0, at - now));
    this.timers.add(timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
