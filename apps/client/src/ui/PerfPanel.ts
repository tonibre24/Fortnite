import { el, setHidden, setText } from './dom.js';

/**
 * Development performance panel (F3).
 *
 * Shows the numbers that actually matter while tuning a networked game: render rate,
 * measured round-trip time, how many entities and effects are live, and how far client
 * prediction is drifting from the server.
 */

export interface PerfSample {
  fps: number;
  frameTimeMs: number;
  pingMs: number;
  players: number;
  entities: number;
  activeEffects: number;
  pooledEffects: number;
  serverTickHz: number;
  pendingInputs: number;
  reconcileCorrections: number;
  lastReconcileError: number;
  drawCalls: number;
}

interface Row {
  value: HTMLElement;
  format: (sample: PerfSample) => string;
}

export class PerfPanel {
  readonly root: HTMLElement;
  private readonly rows: Row[] = [];
  private frameAccumulatorMs = 0;
  private framesSinceUpdate = 0;
  private smoothedFps = 60;

  constructor(visible: boolean) {
    const definitions: [string, (sample: PerfSample) => string][] = [
      ['FPS', (s) => `${s.fps.toFixed(0)} (${s.frameTimeMs.toFixed(1)} ms)`],
      ['Ping', (s) => `${s.pingMs.toFixed(0)} ms`],
      ['Server tick', (s) => `${s.serverTickHz.toFixed(0)} Hz`],
      ['Players', (s) => String(s.players)],
      ['Entities', (s) => String(s.entities)],
      ['Effects', (s) => `${s.activeEffects} / ${s.pooledEffects}`],
      ['Draw calls', (s) => String(s.drawCalls)],
      ['Pending input', (s) => String(s.pendingInputs)],
      ['Corrections', (s) => `${s.reconcileCorrections} (${s.lastReconcileError.toFixed(2)} m)`],
    ];

    const body = definitions.map(([label, format]) => {
      const value = el('span', { text: '—' });
      this.rows.push({ value, format });
      return el('div', { class: 'row' }, [el('span', { text: label }), value]);
    });

    this.root = el('div', { class: 'perf-panel', hidden: !visible }, [
      el('h3', { text: 'Performance' }),
      ...body,
    ]);
  }

  setVisible(visible: boolean): void {
    setHidden(this.root, !visible);
  }

  get isVisible(): boolean {
    return !this.root.hidden;
  }

  toggle(): boolean {
    this.setVisible(this.root.hidden);
    return this.isVisible;
  }

  /** Feeds a frame time; the panel refreshes its text about four times a second. */
  update(frameTimeMs: number, sample: Omit<PerfSample, 'fps' | 'frameTimeMs'>): void {
    // Smoothing keeps the readout legible instead of flickering every frame.
    const instantFps = frameTimeMs > 0 ? 1000 / frameTimeMs : this.smoothedFps;
    this.smoothedFps = this.smoothedFps * 0.9 + instantFps * 0.1;

    this.frameAccumulatorMs += frameTimeMs;
    this.framesSinceUpdate += 1;
    if (this.root.hidden || this.frameAccumulatorMs < 250) return;

    const averageFrameMs = this.frameAccumulatorMs / this.framesSinceUpdate;
    this.frameAccumulatorMs = 0;
    this.framesSinceUpdate = 0;

    const full: PerfSample = {
      ...sample,
      fps: this.smoothedFps,
      frameTimeMs: averageFrameMs,
    };
    for (const row of this.rows) setText(row.value, row.format(full));
  }

  dispose(): void {
    this.rows.length = 0;
    this.root.remove();
  }
}
