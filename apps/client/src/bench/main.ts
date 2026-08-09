import {
  BenchHarness,
  DEFAULT_BENCH_OPTIONS,
  type BenchOptions,
  type BenchResult,
} from './BenchHarness.js';

/**
 * Entry point for `bench.html`.
 *
 * The page exposes `window.riftfrontBench` so a driver (`scripts/benchmark.mjs`) can run
 * a measured pass and read the result back out. Opening the page by hand runs the same
 * pass and prints the result on screen, which is the fastest way to eyeball the scene.
 */

export interface BenchApi {
  run: (
    config?: Partial<BenchOptions> & { frames?: number; warmupFrames?: number },
  ) => Promise<BenchResult>;
  /** Builds the scene and renders it continuously without measuring — for screenshots. */
  preview: (config?: Partial<BenchOptions>) => void;
  dispose: () => void;
}

declare global {
  interface Window {
    riftfrontBench?: BenchApi;
  }
}

function readOptions(overrides: Partial<BenchOptions> = {}): BenchOptions {
  const params = new URLSearchParams(window.location.search);
  const flag = (name: keyof BenchOptions, fallback: boolean): boolean => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    return raw !== '0' && raw !== 'false';
  };

  const requestedCamera = params.get('camera');
  const camera =
    requestedCamera === 'overview' || requestedCamera === 'boundary'
      ? requestedCamera
      : DEFAULT_BENCH_OPTIONS.camera;

  return {
    players: Number(params.get('players') ?? DEFAULT_BENCH_OPTIONS.players),
    camera,
    vfx: flag('vfx', DEFAULT_BENCH_OPTIONS.vfx),
    shadows: flag('shadows', DEFAULT_BENCH_OPTIONS.shadows),
    props: flag('props', DEFAULT_BENCH_OPTIONS.props),
    storm: flag('storm', DEFAULT_BENCH_OPTIONS.storm),
    ...overrides,
  };
}

function boot(): void {
  const canvas = document.getElementById('bench-canvas') as HTMLCanvasElement | null;
  const output = document.getElementById('bench-output');
  if (!canvas) throw new Error('bench canvas missing');

  let harness: BenchHarness | null = null;
  let previewHandle = 0;

  const build = (overrides: Partial<BenchOptions>): BenchHarness => {
    harness?.dispose();
    harness = new BenchHarness(canvas, readOptions(overrides));
    // Exposed for ad-hoc renderer debugging from the devtools console (bench page only).
    (window as unknown as { __benchScene?: unknown }).__benchScene = harness.scene;
    return harness;
  };

  window.riftfrontBench = {
    run: async (config = {}) => {
      const { frames = 600, warmupFrames = 90, ...overrides } = config;
      const active = build(overrides);
      const result = await active.run({ frames, warmupFrames });
      if (output) output.textContent = JSON.stringify(result, null, 2);
      return result;
    },
    preview: (overrides = {}) => {
      const active = build(overrides);
      cancelAnimationFrame(previewHandle);
      const tick = (): void => {
        active.step(1000 / 60);
        previewHandle = requestAnimationFrame(tick);
      };
      tick();
    },
    dispose: () => {
      cancelAnimationFrame(previewHandle);
      harness?.dispose();
      harness = null;
    },
  };

  // Opened by hand rather than driven: render continuously so the scene can be inspected.
  if (new URLSearchParams(window.location.search).get('auto') === '1') {
    window.riftfrontBench.preview();
  }
}

boot();
