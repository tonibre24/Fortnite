import {
  AUDIO_BED_RAMP,
  AUDIO_DEFAULT_VOLUME,
  AUDIO_DUCK_ATTACK,
  AUDIO_DUCK_DEPTH,
  AUDIO_DUCK_RELEASE,
  AUDIO_MAX_DISTANCE,
  AUDIO_NOISE_LOOP_SECONDS,
  AUDIO_REF_DISTANCE,
  AUDIO_ROLLOFF,
  AUDIO_VOLUME_KEY,
  clamp,
} from '@br/shared';

/**
 * Procedural audio.
 *
 * Every sound is synthesised at runtime with the Web Audio API - there are no
 * files to download, decode, licence or fail to load, which keeps the "no
 * assets" rule intact for sound as well as for graphics.
 *
 * If the Web Audio API is missing or the context will not start, every method
 * turns into a no-op and the game runs silently rather than breaking.
 *
 * The graph:
 *
 *   one-shots ──────────────────┐
 *                               ├── master ── destination
 *   beds ── duck ───────────────┘
 *
 * One-shots bypass the ducking gain so that a gunshot is what pulls the storm
 * drone and engine down, not something that ducks itself.
 */

/** Categories exist so one can be capped without starving another. */
export type VoiceCategory = 'shot' | 'impact' | 'step' | 'pickup' | 'ui';

/** A continuous sound whose level is driven every frame. */
export type BedName = 'bus' | 'wind' | 'storm';

interface Bus {
  context: AudioContext;
  master: GainNode;
  duck: GainNode;
  beds: GainNode;
}

interface Voice {
  stop(): void;
}

interface Bed {
  gain: GainNode;
  panner: PannerNode | null;
  level: number;
}

export interface PlayOptions {
  /** World position; omitted for sounds that are simply "here". */
  at?: { x: number; y: number; z: number } | undefined;
  /** Scales the peak level, before any distance attenuation. */
  gain?: number;
  /** Ducks the beds for the length of the sound. */
  ducks?: boolean;
}

export class AudioSystem {
  private bus: Bus | null = null;
  private available = true;
  private disposed = false;
  private volume: number;
  /** Active voices per category, oldest first, so the oldest can be stolen. */
  private readonly voices = new Map<VoiceCategory, Voice[]>();
  private readonly caps = new Map<VoiceCategory, number>();
  private readonly beds = new Map<BedName, Bed>();
  private noiseLoop: AudioBuffer | null = null;
  private duckUntil = 0;

  constructor(caps: Record<VoiceCategory, number>) {
    for (const [category, cap] of Object.entries(caps)) {
      this.caps.set(category as VoiceCategory, cap);
    }
    this.volume = readStoredVolume();
  }

  get masterVolume(): number {
    return this.volume;
  }

  /** True once the context exists and is actually running. */
  get running(): boolean {
    return this.bus !== null && this.bus.context.state === 'running';
  }

  /**
   * Creates or resumes the context. Browsers only allow this inside a user
   * gesture, so it is called from the first click or keypress on the page.
   */
  async unlock(): Promise<void> {
    if (this.disposed || !this.available) return;
    try {
      if (this.bus === null) {
        const Ctor: typeof AudioContext | undefined =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctor === undefined) {
          this.available = false;
          return;
        }

        const context = new Ctor();
        const master = context.createGain();
        const duck = context.createGain();
        const beds = context.createGain();
        beds.connect(duck);
        duck.connect(master);
        master.connect(context.destination);
        master.gain.value = this.volume;
        this.bus = { context, master, duck, beds };
      }
      if (this.bus.context.state === 'suspended') await this.bus.context.resume();
    } catch {
      this.available = false;
    }
  }

  setVolume(value: number): void {
    this.volume = clamp(value, 0, 1);
    if (this.bus !== null) this.bus.master.gain.value = this.volume;
    try {
      window.localStorage.setItem(AUDIO_VOLUME_KEY, String(this.volume));
    } catch {
      // Private browsing and disabled storage both throw; the slider still works
      // for this session, it just will not be remembered.
    }
  }

  /**
   * Points the listener at the camera. Without this every positional source
   * collapses to the middle and the direction information is lost.
   */
  setListener(
    pos: { x: number; y: number; z: number },
    forward: { x: number; y: number; z: number },
    up: { x: number; y: number; z: number },
  ): void {
    if (this.bus === null) return;
    const listener = this.bus.context.listener;
    const now = this.bus.context.currentTime;
    // Safari still only has the deprecated setters, so both paths are needed.
    if (listener.positionX !== undefined) {
      listener.positionX.setValueAtTime(pos.x, now);
      listener.positionY.setValueAtTime(pos.y, now);
      listener.positionZ.setValueAtTime(pos.z, now);
      listener.forwardX.setValueAtTime(forward.x, now);
      listener.forwardY.setValueAtTime(forward.y, now);
      listener.forwardZ.setValueAtTime(forward.z, now);
      listener.upX.setValueAtTime(up.x, now);
      listener.upY.setValueAtTime(up.y, now);
      listener.upZ.setValueAtTime(up.z, now);
      return;
    }
    const legacy = listener as unknown as {
      setPosition(x: number, y: number, z: number): void;
      setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
    };
    legacy.setPosition(pos.x, pos.y, pos.z);
    legacy.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }

  // ----------------------------------------------------------------- voices

  /**
   * Where a one-shot should connect, plus the panner it owns.
   *
   * The panner belongs to this voice alone and is disconnected when this voice
   * ends - sharing one per category would mean the first sound to finish tears
   * down the panner every other overlapping sound is still playing through.
   */
  private destinationFor(options: PlayOptions): { node: AudioNode; panner: PannerNode | null } | null {
    if (this.bus === null) return null;
    if (options.at === undefined) return { node: this.bus.master, panner: null };
    const panner = this.panner(options.at);
    if (panner === null) return { node: this.bus.master, panner: null };
    panner.connect(this.bus.master);
    return { node: panner, panner };
  }

  private panner(at: { x: number; y: number; z: number }): PannerNode | null {
    if (this.bus === null) return null;
    const panner = this.bus.context.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = AUDIO_REF_DISTANCE;
    panner.maxDistance = AUDIO_MAX_DISTANCE;
    panner.rolloffFactor = AUDIO_ROLLOFF;
    panner.positionX.value = at.x;
    panner.positionY.value = at.y;
    panner.positionZ.value = at.z;
    return panner;
  }

  /**
   * Registers a voice, stealing the oldest in the category when at the cap.
   * Stealing rather than dropping keeps the newest - and so most relevant -
   * sound audible when a firefight saturates the budget.
   */
  private admit(category: VoiceCategory, voice: Voice): boolean {
    const cap = this.caps.get(category) ?? 4;
    const active = this.voices.get(category) ?? [];
    while (active.length >= cap) {
      const oldest = active.shift();
      oldest?.stop();
    }
    active.push(voice);
    this.voices.set(category, active);
    return true;
  }

  private retire(category: VoiceCategory, voice: Voice): void {
    const active = this.voices.get(category);
    if (active === undefined) return;
    const index = active.indexOf(voice);
    if (index >= 0) active.splice(index, 1);
  }

  /** Number of voices currently sounding in a category, for tests and the HUD. */
  activeVoices(category: VoiceCategory): number {
    return this.voices.get(category)?.length ?? 0;
  }

  // ------------------------------------------------------------- primitives

  /** A pitched blip: the workhorse behind most of the discrete cues. */
  tone(
    category: VoiceCategory,
    options: PlayOptions,
    type: OscillatorType,
    startHz: number,
    endHz: number,
    duration: number,
    peak: number,
    delay = 0,
  ): void {
    if (this.bus === null || !this.running) return;
    const { context } = this.bus;
    const routing = this.destinationFor(options);
    if (routing === null) return;

    const start = context.currentTime + delay;
    const level = Math.max(0.0002, peak * (options.gain ?? 1));

    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startHz, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endHz), start + duration);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(level, start + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    oscillator.connect(envelope);
    envelope.connect(routing.node);

    const voice: Voice = {
      stop: () => {
        try {
          oscillator.stop();
        } catch {
          // Already stopped; nothing to do.
        }
      },
    };
    this.admit(category, voice);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
      routing.panner?.disconnect();
      this.retire(category, voice);
    };
    if (options.ducks === true) this.duck(duration);
  }

  /** Filtered, exponentially decaying white noise: every impact and transient. */
  noise(
    category: VoiceCategory,
    options: PlayOptions,
    duration: number,
    filterHz: number,
    peak: number,
    filterType: BiquadFilterType,
    delay = 0,
  ): void {
    if (this.bus === null || !this.running) return;
    const { context } = this.bus;
    const routing = this.destinationFor(options);
    if (routing === null) return;

    const start = context.currentTime + delay;
    const frames = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      const decay = 1 - i / frames;
      data[i] = (Math.random() * 2 - 1) * decay * decay;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterHz;
    filter.Q.value = filterType === 'bandpass' ? 1.2 : 0.7;
    const envelope = context.createGain();
    envelope.gain.value = peak * (options.gain ?? 1);

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(routing.node);

    const voice: Voice = {
      stop: () => {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      },
    };
    this.admit(category, voice);
    source.start(start);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      envelope.disconnect();
      routing.panner?.disconnect();
      this.retire(category, voice);
    };
    if (options.ducks === true) this.duck(duration);
  }

  // ------------------------------------------------------------------ beds

  /**
   * Sets the level of a continuous sound, creating it on first use.
   *
   * Beds are started once and then only gain-ramped, because starting and
   * stopping oscillators every frame is both audible as clicks and pointless
   * churn.
   */
  setBed(
    name: BedName,
    level: number,
    at?: { x: number; y: number; z: number } | undefined,
  ): void {
    if (this.bus === null || !this.running) return;
    const target = clamp(level, 0, 1);
    let bed = this.beds.get(name);
    if (bed === undefined) {
      // Nothing to do for a bed that has never sounded and is being silenced.
      if (target <= 0) return;
      const created = this.createBed(name, at !== undefined);
      if (created === null) return;
      this.beds.set(name, created);
      bed = created;
    }

    if (bed.panner !== null && at !== undefined) {
      bed.panner.positionX.value = at.x;
      bed.panner.positionY.value = at.y;
      bed.panner.positionZ.value = at.z;
    }
    if (Math.abs(bed.level - target) < 0.001) return;
    bed.level = target;
    const now = this.bus.context.currentTime;
    bed.gain.gain.cancelScheduledValues(now);
    bed.gain.gain.setTargetAtTime(target, now, AUDIO_BED_RAMP);
  }

  private createBed(name: BedName, positional: boolean): Bed | null {
    if (this.bus === null) return null;
    const { context, beds } = this.bus;
    const gain = context.createGain();
    gain.gain.value = 0;

    let panner: PannerNode | null = null;
    if (positional) {
      panner = this.panner({ x: 0, y: 0, z: 0 });
      if (panner !== null) {
        gain.connect(panner);
        panner.connect(beds);
      }
    }
    if (panner === null) gain.connect(beds);

    switch (name) {
      case 'bus':
        // A diesel drone: two detuned saws under a lowpass, plus rumble.
        this.bedOscillator(gain, 'sawtooth', 54, 260);
        this.bedOscillator(gain, 'sawtooth', 57.5, 260);
        this.bedOscillator(gain, 'sine', 27, 0);
        break;
      case 'wind':
        this.bedNoise(gain, 'bandpass', 900, 0.8);
        break;
      case 'storm':
        // Low and wide, so it reads as a wall rather than a point.
        this.bedNoise(gain, 'lowpass', 220, 0.5);
        this.bedOscillator(gain, 'sine', 44, 0);
        break;
    }
    return { gain, panner, level: 0 };
  }

  private bedOscillator(target: GainNode, type: OscillatorType, hz: number, filterHz: number): void {
    if (this.bus === null) return;
    const { context } = this.bus;
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.value = hz;
    if (filterHz > 0) {
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = filterHz;
      oscillator.connect(filter);
      filter.connect(target);
    } else {
      oscillator.connect(target);
    }
    oscillator.start();
  }

  private bedNoise(target: GainNode, type: BiquadFilterType, hz: number, q: number): void {
    if (this.bus === null) return;
    const { context } = this.bus;
    const source = context.createBufferSource();
    source.buffer = this.loopBuffer();
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = hz;
    filter.Q.value = q;
    source.connect(filter);
    filter.connect(target);
    source.start();
  }

  /** One shared noise buffer, reused by every looping bed. */
  private loopBuffer(): AudioBuffer | null {
    if (this.bus === null) return null;
    if (this.noiseLoop !== null) return this.noiseLoop;
    const { context } = this.bus;
    const frames = Math.floor(context.sampleRate * AUDIO_NOISE_LOOP_SECONDS);
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    this.noiseLoop = buffer;
    return buffer;
  }

  // ---------------------------------------------------------------- ducking

  /** Pulls the beds down under a loud one-shot, then lets them back up. */
  private duck(duration: number): void {
    if (this.bus === null) return;
    const { context, duck } = this.bus;
    const now = context.currentTime;
    const until = now + duration;
    // Overlapping shots extend the hold rather than restarting the envelope,
    // which would pump audibly during automatic fire.
    if (until <= this.duckUntil) return;
    this.duckUntil = until;
    duck.gain.cancelScheduledValues(now);
    duck.gain.setTargetAtTime(1 - AUDIO_DUCK_DEPTH, now, AUDIO_DUCK_ATTACK);
    duck.gain.setTargetAtTime(1, until, AUDIO_DUCK_RELEASE);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, active] of this.voices) for (const voice of active) voice.stop();
    this.voices.clear();
    this.beds.clear();
    const bus = this.bus;
    this.bus = null;
    if (bus !== null) void bus.context.close().catch(() => undefined);
  }
}

function readStoredVolume(): number {
  try {
    const raw = window.localStorage.getItem(AUDIO_VOLUME_KEY);
    if (raw === null) return AUDIO_DEFAULT_VOLUME;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clamp(parsed, 0, 1) : AUDIO_DEFAULT_VOLUME;
  } catch {
    return AUDIO_DEFAULT_VOLUME;
  }
}
