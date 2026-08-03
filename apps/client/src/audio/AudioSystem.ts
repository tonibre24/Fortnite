import { clamp } from '@riftfront/shared';

/**
 * Procedural audio.
 *
 * Every sound is synthesised at runtime with the Web Audio API — there are no audio
 * files to download, decode, licence or fail to load. That satisfies the "must remain
 * functional when audio assets fail" requirement structurally rather than with a
 * fallback path, and keeps the bundle free of third-party assets.
 *
 * If the Web Audio API is unavailable or the context cannot be resumed, every method
 * becomes a no-op and the game continues silently.
 */

export type SoundName =
  | 'rifleShot'
  | 'shotgunShot'
  | 'reloadStart'
  | 'reloadEnd'
  | 'dryFire'
  | 'hitConfirm'
  | 'headshotConfirm'
  | 'takeDamage'
  | 'elimination'
  | 'countdownTick'
  | 'countdownGo'
  | 'matchWin'
  | 'matchLose'
  | 'respawn';

interface AudioBus {
  context: AudioContext;
  master: GainNode;
  effects: GainNode;
}

export class AudioSystem {
  private bus: AudioBus | null = null;
  private available = true;
  private masterVolume = 0.7;
  private effectsVolume = 0.8;
  private disposed = false;
  /** Rate limit so a full-auto burst cannot spawn hundreds of oscillators per second. */
  private lastPlayedAt = new Map<SoundName, number>();

  constructor(options: { masterVolume: number; effectsVolume: number }) {
    this.masterVolume = clamp(options.masterVolume, 0, 1);
    this.effectsVolume = clamp(options.effectsVolume, 0, 1);
  }

  /**
   * Creates (or resumes) the audio context. Browsers require this to happen inside a
   * user gesture, so it is called from the first click on the landing screen.
   */
  async unlock(): Promise<void> {
    if (this.disposed || !this.available) return;

    try {
      if (!this.bus) {
        const Ctor: typeof AudioContext | undefined =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
          this.available = false;
          console.warn('[audio] Web Audio API unavailable; running without sound');
          return;
        }

        const context = new Ctor();
        const master = context.createGain();
        const effects = context.createGain();
        effects.connect(master);
        master.connect(context.destination);
        this.bus = { context, master, effects };
        this.applyVolumes();
      }

      if (this.bus.context.state === 'suspended') {
        await this.bus.context.resume();
      }
    } catch (error) {
      this.available = false;
      console.warn('[audio] could not initialise audio; running without sound', error);
    }
  }

  setVolumes(master: number, effects: number): void {
    this.masterVolume = clamp(master, 0, 1);
    this.effectsVolume = clamp(effects, 0, 1);
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.bus) return;
    this.bus.master.gain.value = this.masterVolume;
    this.bus.effects.gain.value = this.effectsVolume;
  }

  /**
   * Plays a synthesised sound. `intensity` scales the volume (used for distance
   * attenuation of other players' gunfire).
   */
  play(name: SoundName, intensity = 1): void {
    if (this.disposed || !this.available || !this.bus) return;
    if (this.masterVolume <= 0 || this.effectsVolume <= 0) return;

    const { context } = this.bus;
    if (context.state !== 'running') return;

    const now = context.currentTime;
    const minInterval = MIN_INTERVAL_MS[name] ?? 0;
    if (minInterval > 0) {
      const last = this.lastPlayedAt.get(name) ?? -Infinity;
      const nowMs = now * 1000;
      if (nowMs - last < minInterval) return;
      this.lastPlayedAt.set(name, nowMs);
    }

    const gain = clamp(intensity, 0, 1);
    if (gain <= 0.001) return;

    try {
      this.synthesise(name, now, gain);
    } catch (error) {
      console.warn(`[audio] failed to play ${name}`, error);
    }
  }

  // -------------------------------------------------------------------------
  // Synthesis
  // -------------------------------------------------------------------------

  private synthesise(name: SoundName, now: number, gain: number): void {
    switch (name) {
      case 'rifleShot':
        this.noiseBurst(now, 0.09, 1800, gain * 0.55, 'bandpass');
        this.tone(now, 'square', 160, 55, 0.07, gain * 0.3);
        break;

      case 'shotgunShot':
        this.noiseBurst(now, 0.22, 900, gain * 0.75, 'lowpass');
        this.tone(now, 'sawtooth', 110, 32, 0.16, gain * 0.42);
        break;

      case 'reloadStart':
        this.tone(now, 'square', 320, 240, 0.05, gain * 0.22);
        this.tone(now + 0.09, 'square', 260, 200, 0.05, gain * 0.2);
        break;

      case 'reloadEnd':
        this.tone(now, 'square', 420, 620, 0.07, gain * 0.26);
        break;

      case 'dryFire':
        this.tone(now, 'square', 900, 300, 0.035, gain * 0.18);
        break;

      case 'hitConfirm':
        this.tone(now, 'sine', 1250, 1600, 0.05, gain * 0.3);
        break;

      case 'headshotConfirm':
        this.tone(now, 'sine', 1500, 2300, 0.06, gain * 0.36);
        this.tone(now + 0.05, 'sine', 2100, 2600, 0.05, gain * 0.24);
        break;

      case 'takeDamage':
        this.noiseBurst(now, 0.13, 420, gain * 0.4, 'lowpass');
        this.tone(now, 'triangle', 210, 120, 0.12, gain * 0.24);
        break;

      case 'elimination':
        this.tone(now, 'triangle', 520, 780, 0.1, gain * 0.3);
        this.tone(now + 0.1, 'triangle', 780, 1040, 0.14, gain * 0.26);
        break;

      case 'countdownTick':
        this.tone(now, 'sine', 660, 660, 0.1, gain * 0.28);
        break;

      case 'countdownGo':
        this.tone(now, 'sine', 990, 990, 0.28, gain * 0.34);
        break;

      case 'respawn':
        this.tone(now, 'sine', 400, 900, 0.22, gain * 0.24);
        break;

      case 'matchWin':
        this.arpeggio(now, [523, 659, 784, 1047], gain * 0.3);
        break;

      case 'matchLose':
        this.arpeggio(now, [523, 440, 349, 262], gain * 0.26);
        break;

      default:
        break;
    }
  }

  private tone(
    startTime: number,
    type: OscillatorType,
    startHz: number,
    endHz: number,
    duration: number,
    peak: number,
  ): void {
    if (!this.bus) return;
    const { context, effects } = this.bus;

    const oscillator = context.createOscillator();
    const envelope = context.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startHz, startTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endHz), startTime + duration);

    envelope.gain.setValueAtTime(0.0001, startTime);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), startTime + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    oscillator.connect(envelope);
    envelope.connect(effects);
    oscillator.start(startTime);
    oscillator.stop(startTime + duration + 0.02);
    // Nodes disconnect themselves once stopped, so nothing accumulates.
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };
  }

  private noiseBurst(
    startTime: number,
    duration: number,
    filterHz: number,
    peak: number,
    filterType: BiquadFilterType,
  ): void {
    if (!this.bus) return;
    const { context, effects } = this.bus;

    const frameCount = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, frameCount, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frameCount; i++) {
      // Exponentially decaying white noise: a compact, convincing gunshot transient.
      const decay = 1 - i / frameCount;
      data[i] = (Math.random() * 2 - 1) * decay * decay;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;

    const filter = context.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterHz;
    filter.Q.value = filterType === 'bandpass' ? 1.2 : 0.7;

    const envelope = context.createGain();
    envelope.gain.value = peak;

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(effects);
    source.start(startTime);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      envelope.disconnect();
    };
  }

  private arpeggio(startTime: number, notes: number[], peak: number): void {
    notes.forEach((hz, index) => {
      this.tone(startTime + index * 0.11, 'triangle', hz, hz, 0.2, peak);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const bus = this.bus;
    this.bus = null;
    this.lastPlayedAt.clear();
    if (bus) {
      bus.effects.disconnect();
      bus.master.disconnect();
      void bus.context.close().catch(() => undefined);
    }
  }
}

/** Per-sound throttling in milliseconds; 0 means unthrottled. */
const MIN_INTERVAL_MS: Partial<Record<SoundName, number>> = {
  rifleShot: 40,
  shotgunShot: 60,
  hitConfirm: 45,
  headshotConfirm: 60,
  takeDamage: 120,
  dryFire: 220,
};
