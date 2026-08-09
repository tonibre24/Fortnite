import { el, setClass, setHidden, setText } from './dom.js';

import { formatBytes } from '../render/RenderStats.js';

/**
 * Performance overlay, toggled with F3.
 *
 * Two groups of numbers. The renderer group — fps, frame time, draw calls, triangles and
 * texture memory — is what the 60 fps at 1080p budget is managed against, and the first
 * four of those are the ones that move when someone adds a prop type or an effect. The
 * network group is what matters when the game feels wrong but the frame rate is fine.
 *
 * The frame time readout carries a budget marker, because "14.2 ms" only means something
 * next to the 16.67 ms it has to fit inside.
 */

/** One frame at 60 Hz. */
const FRAME_BUDGET_MS = 1000 / 60;

export interface PerfSample {
  fps: number;
  frameTimeMs: number;
  /** 99th percentile frame time over the last few seconds — the "1% low". */
  onePercentLowMs: number;
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
  triangles: number;
  textureBytes: number;
  textureCount: number;
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

  /**
   * A ring of recent frame times for the 1% low.
   *
   * Four seconds at 60 Hz. Allocated once and written in place: a panel that allocates
   * would perturb the very number it exists to report.
   */
  private readonly history = new Float32Array(240);
  private readonly sorted = new Float32Array(240);
  private historyCursor = 0;
  private historyFilled = 0;
  private onePercentLowMs = 0;

  constructor(visible: boolean) {
    const definitions: [string, (sample: PerfSample) => string][] = [
      ['FPS', (s) => s.fps.toFixed(0)],
      ['Frame time', (s) => `${s.frameTimeMs.toFixed(1)} / ${FRAME_BUDGET_MS.toFixed(1)} ms`],
      ['1% low', (s) => `${s.onePercentLowMs.toFixed(1)} ms`],
      ['Draw calls', (s) => String(s.drawCalls)],
      ['Triangles', (s) => s.triangles.toLocaleString('en-US')],
      ['Texture memory', (s) => `${formatBytes(s.textureBytes)} (${s.textureCount})`],
      ['Ping', (s) => `${s.pingMs.toFixed(0)} ms`],
      ['Server tick', (s) => `${s.serverTickHz.toFixed(0)} Hz`],
      ['Players', (s) => String(s.players)],
      ['Entities', (s) => String(s.entities)],
      ['Effects', (s) => `${s.activeEffects} / ${s.pooledEffects}`],
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

  /**
   * Feeds a frame time; the panel refreshes its text about four times a second.
   *
   * Frame times are recorded even while the panel is hidden, so pressing F3 after a
   * stutter still shows the 1% low that caused it rather than starting from scratch.
   */
  update(
    frameTimeMs: number,
    sample: Omit<PerfSample, 'fps' | 'frameTimeMs' | 'onePercentLowMs'>,
  ): void {
    // Smoothing keeps the readout legible instead of flickering every frame.
    const instantFps = frameTimeMs > 0 ? 1000 / frameTimeMs : this.smoothedFps;
    this.smoothedFps = this.smoothedFps * 0.9 + instantFps * 0.1;

    this.history[this.historyCursor] = frameTimeMs;
    this.historyCursor = (this.historyCursor + 1) % this.history.length;
    if (this.historyFilled < this.history.length) this.historyFilled += 1;

    this.frameAccumulatorMs += frameTimeMs;
    this.framesSinceUpdate += 1;
    if (this.root.hidden || this.frameAccumulatorMs < 250) return;

    const averageFrameMs = this.frameAccumulatorMs / this.framesSinceUpdate;
    this.frameAccumulatorMs = 0;
    this.framesSinceUpdate = 0;
    this.onePercentLowMs = this.computeOnePercentLow();

    const full: PerfSample = {
      ...sample,
      fps: this.smoothedFps,
      frameTimeMs: averageFrameMs,
      onePercentLowMs: this.onePercentLowMs,
    };
    for (const row of this.rows) setText(row.value, row.format(full));
    setClass(this.root, 'over-budget', this.onePercentLowMs > FRAME_BUDGET_MS);
  }

  /** 99th percentile of the retained history, computed on the panel's refresh cadence. */
  private computeOnePercentLow(): number {
    if (this.historyFilled === 0) return 0;
    this.sorted.set(this.history.subarray(0, this.historyFilled));
    const slice = this.sorted.subarray(0, this.historyFilled);
    slice.sort();
    return slice[Math.min(slice.length - 1, Math.floor(slice.length * 0.99))];
  }

  dispose(): void {
    this.rows.length = 0;
    this.root.remove();
  }
}
