import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  AUDIO_DEFAULT_VOLUME,
  AUDIO_MAX_SHOT_VOICES,
  AUDIO_VOLUME_KEY,
} from '@br/shared';

/**
 * A Web Audio stub good enough to exercise the graph bookkeeping.
 *
 * The point is not to verify what anything sounds like - that needs ears - but
 * that the voice budget holds, that nodes are retired, and that the volume
 * survives a reload. Those are the parts that break silently in a real game.
 */
class FakeParam {
  value = 0;
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}

class FakeNode {
  connected: FakeNode[] = [];
  disconnected = false;
  connect(target: FakeNode): FakeNode {
    this.connected.push(target);
    return target;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
  onended: (() => void) | null = null;
  started = false;
  /** True only for an immediate stop() - which is how a voice gets stolen. */
  stopped = false;
  scheduledStop: number | null = null;
  start(): void {
    this.started = true;
  }
  stop(when?: number): void {
    if (when === undefined) this.stopped = true;
    else this.scheduledStop = when;
  }
  /** Standing in for the browser firing onended once the voice finishes. */
  finish(): void {
    this.onended?.();
  }
}

class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  stopped = false;
  scheduledStop: number | null = null;
  start(): void {}
  stop(when?: number): void {
    if (when === undefined) this.stopped = true;
    else this.scheduledStop = when;
  }
  finish(): void {
    this.onended?.();
  }
}

class FakeContext {
  state: 'running' | 'suspended' = 'running';
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeNode();
  listener = {
    positionX: new FakeParam(),
    positionY: new FakeParam(),
    positionZ: new FakeParam(),
    forwardX: new FakeParam(),
    forwardY: new FakeParam(),
    forwardZ: new FakeParam(),
    upX: new FakeParam(),
    upY: new FakeParam(),
    upZ: new FakeParam(),
  };
  readonly oscillators: FakeOscillator[] = [];
  readonly sources: FakeBufferSource[] = [];
  readonly panners: FakeNode[] = [];

  createGain(): FakeNode & { gain: FakeParam } {
    const node = new FakeNode() as FakeNode & { gain: FakeParam };
    node.gain = new FakeParam();
    return node;
  }
  createOscillator(): FakeOscillator {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  }
  createBufferSource(): FakeBufferSource {
    const node = new FakeBufferSource();
    this.sources.push(node);
    return node;
  }
  createBiquadFilter(): FakeNode & { type: string; frequency: FakeParam; Q: FakeParam } {
    const node = new FakeNode() as FakeNode & { type: string; frequency: FakeParam; Q: FakeParam };
    node.type = 'lowpass';
    node.frequency = new FakeParam();
    node.Q = new FakeParam();
    return node;
  }
  createPanner(): FakeNode & Record<string, unknown> {
    const node = new FakeNode() as FakeNode & Record<string, unknown>;
    node.positionX = new FakeParam();
    node.positionY = new FakeParam();
    node.positionZ = new FakeParam();
    this.panners.push(node);
    return node;
  }
  createBuffer(_channels: number, frames: number): { getChannelData(): Float32Array } {
    const data = new Float32Array(frames);
    return { getChannelData: () => data };
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

let context: FakeContext;
const store = new Map<string, string>();

beforeEach(() => {
  context = new FakeContext();
  vi.stubGlobal('window', {
    AudioContext: function (this: unknown) {
      return context;
    } as unknown as typeof AudioContext,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.clear();
});

async function makeSystem() {
  const { AudioSystem } = await import('../client/src/audio/AudioSystem.js');
  const system = new AudioSystem({
    shot: AUDIO_MAX_SHOT_VOICES,
    impact: 4,
    step: 3,
    pickup: 3,
    ui: 2,
  });
  await system.unlock();
  return system;
}

describe('audio voice budget', () => {
  it('never exceeds the cap for a category', async () => {
    const system = await makeSystem();
    for (let i = 0; i < 40; i++) {
      system.tone('shot', {}, 'square', 200, 100, 0.05, 0.3);
    }
    expect(system.activeVoices('shot')).toBeLessThanOrEqual(AUDIO_MAX_SHOT_VOICES);
  });

  /**
   * Stealing the oldest rather than refusing the newest is what keeps the shot
   * you just took audible when twenty players are firing.
   */
  it('steals the oldest voice rather than dropping the newest', async () => {
    const system = await makeSystem();
    for (let i = 0; i < AUDIO_MAX_SHOT_VOICES + 3; i++) {
      system.tone('shot', {}, 'square', 200, 100, 0.05, 0.3);
    }
    const stopped = context.oscillators.filter((o) => o.stopped).length;
    expect(stopped).toBe(3);
    // The three most recent are still running.
    expect(context.oscillators.slice(-AUDIO_MAX_SHOT_VOICES).every((o) => !o.stopped)).toBe(true);
  });

  it('keeps categories independent', async () => {
    const system = await makeSystem();
    for (let i = 0; i < 20; i++) system.tone('shot', {}, 'square', 200, 100, 0.05, 0.3);
    system.tone('ui', {}, 'sine', 900, 900, 0.05, 0.3);
    expect(system.activeVoices('ui')).toBe(1);
    expect(system.activeVoices('shot')).toBeLessThanOrEqual(AUDIO_MAX_SHOT_VOICES);
  });

  it('frees the slot once a voice ends', async () => {
    const system = await makeSystem();
    system.tone('shot', {}, 'square', 200, 100, 0.05, 0.3);
    expect(system.activeVoices('shot')).toBe(1);
    for (const oscillator of context.oscillators) oscillator.finish();
    expect(system.activeVoices('shot')).toBe(0);
  });

  it('spatialises only sounds that carry a position', async () => {
    const system = await makeSystem();
    system.tone('shot', {}, 'square', 200, 100, 0.05, 0.3);
    expect(context.panners).toHaveLength(0);
    system.tone('shot', { at: { x: 10, y: 2, z: -4 } }, 'square', 200, 100, 0.05, 0.3);
    expect(context.panners).toHaveLength(1);
    expect((context.panners[0] as unknown as { positionX: FakeParam }).positionX.value).toBe(10);
  });

  /**
   * Each positional voice owns its panner. Sharing one per category meant the
   * first overlapping sound to finish disconnected the panner the others were
   * still playing through, cutting them off mid-shot.
   */
  it('does not tear down a panner another voice is still using', async () => {
    const system = await makeSystem();
    system.tone('shot', { at: { x: 1, y: 0, z: 0 } }, 'square', 200, 100, 0.05, 0.3);
    system.tone('shot', { at: { x: 9, y: 0, z: 0 } }, 'square', 200, 100, 0.05, 0.3);
    expect(context.panners).toHaveLength(2);

    // The first voice ends; the second is still sounding.
    context.oscillators[0]!.finish();
    expect(context.panners[0]!.disconnected).toBe(true);
    expect(context.panners[1]!.disconnected).toBe(false);

    context.oscillators[1]!.finish();
    expect(context.panners[1]!.disconnected).toBe(true);
  });

  it('survives a missing Web Audio implementation', async () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } });
    const { AudioSystem } = await import('../client/src/audio/AudioSystem.js');
    const system = new AudioSystem({ shot: 4, impact: 4, step: 3, pickup: 3, ui: 2 });
    await system.unlock();
    expect(system.running).toBe(false);
    // Must stay a no-op rather than throwing into the frame loop.
    expect(() => system.tone('shot', {}, 'square', 200, 100, 0.05, 0.3)).not.toThrow();
    expect(() => system.setBed('storm', 0.5, { x: 0, y: 0, z: 0 })).not.toThrow();
  });
});

describe('master volume', () => {
  it('defaults when nothing is stored', async () => {
    const system = await makeSystem();
    expect(system.masterVolume).toBe(AUDIO_DEFAULT_VOLUME);
  });

  it('persists and reloads', async () => {
    const system = await makeSystem();
    system.setVolume(0.25);
    expect(store.get(AUDIO_VOLUME_KEY)).toBe('0.25');

    const { AudioSystem } = await import('../client/src/audio/AudioSystem.js');
    const reloaded = new AudioSystem({ shot: 4, impact: 4, step: 3, pickup: 3, ui: 2 });
    expect(reloaded.masterVolume).toBe(0.25);
  });

  it('clamps out-of-range values', async () => {
    const system = await makeSystem();
    system.setVolume(4);
    expect(system.masterVolume).toBe(1);
    system.setVolume(-2);
    expect(system.masterVolume).toBe(0);
  });
});
