/**
 * Drift-corrected fixed-step loop. `setInterval` accumulates error and stalls
 * under load, so the next deadline is tracked explicitly and missed ticks are
 * either caught up (bounded) or abandoned.
 */
export interface TickStats {
  ticks: number;
  totalDurationMs: number;
  maxDurationMs: number;
  /** Ticks the loop was too slow to run on time and had to skip entirely. */
  droppedTicks: number;
}

export class TickLoop {
  readonly stats: TickStats = {
    ticks: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    droppedTicks: 0,
  };

  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextDeadline = 0;
  private running = false;

  constructor(
    private readonly intervalMs: number,
    private readonly onTick: () => void,
    private readonly maxCatchUpTicks: number,
    private readonly onError: (err: unknown) => void,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  get averageDurationMs(): number {
    return this.stats.ticks === 0 ? 0 : this.stats.totalDurationMs / this.stats.ticks;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextDeadline = performance.now();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (!this.running) return;
    const delay = Math.max(0, this.nextDeadline - performance.now());
    this.timer = setTimeout(this.run, delay);
  }

  /** Clears counters so a measurement window can exclude process warm-up. */
  resetStats(): void {
    this.stats.ticks = 0;
    this.stats.totalDurationMs = 0;
    this.stats.maxDurationMs = 0;
    this.stats.droppedTicks = 0;
  }

  private run = (): void => {
    if (!this.running) return;
    let steps = 0;
    while (performance.now() >= this.nextDeadline) {
      if (steps >= this.maxCatchUpTicks) {
        // Too far behind to catch up. Abandon the backlog in whole ticks so the
        // loop stays phase-aligned instead of spiralling, and count the loss.
        const behind = performance.now() - this.nextDeadline;
        const skipped = Math.floor(behind / this.intervalMs) + 1;
        this.stats.droppedTicks += skipped;
        this.nextDeadline += skipped * this.intervalMs;
        break;
      }
      const start = performance.now();
      try {
        this.onTick();
      } catch (err) {
        this.onError(err);
      }
      const duration = performance.now() - start;
      this.stats.ticks += 1;
      this.stats.totalDurationMs += duration;
      if (duration > this.stats.maxDurationMs) this.stats.maxDurationMs = duration;
      this.nextDeadline += this.intervalMs;
      steps += 1;
    }
    this.schedule();
  };
}
