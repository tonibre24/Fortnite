import {
  AUDIO_BUS_GAIN,
  AUDIO_MAX_IMPACT_VOICES,
  AUDIO_MAX_PICKUP_VOICES,
  AUDIO_MAX_SHOT_VOICES,
  AUDIO_MAX_STEP_VOICES,
  AUDIO_MAX_UI_VOICES,
  AUDIO_STEP_DISTANCE,
  AUDIO_STEP_RANGE,
  AUDIO_STORM_FADE,
  AUDIO_STORM_GAIN,
  AUDIO_WIND_FULL_SPEED,
  AUDIO_WIND_GAIN,
  EventType,
  ItemKind,
  MoveMode,
  RoundPhase,
  WeaponClass,
  busPosition,
  clamp,
  unpackWeapon,
  vec3,
  type GameEvent,
  type LootItem,
  type RoundState,
  type Vec3,
} from '@br/shared';
import { AudioSystem } from './AudioSystem.js';
import type { RenderedRemote } from '../game/RemoteInterpolator.js';

/**
 * Turns game state into sound.
 *
 * Everything discrete arrives as a server event; everything continuous - the
 * bus, the glider, the storm - is a level recomputed each frame from state the
 * client already has. Nothing here reaches back into the simulation.
 */
export class GameAudio {
  private readonly audio: AudioSystem;
  /** Distance each body has travelled since its last footstep. */
  private readonly stepAccumulator = new Map<number, number>();
  private readonly lastSeen = new Map<number, Vec3>();
  private previousLoot = new Map<number, LootItem>();
  private lastStormPhase = -1;
  private lastRoundPhase = -1;
  private lastMapSeed = 0;
  private announcedWin = false;
  private readonly busPos = vec3();
  private readonly stormPoint = vec3();

  constructor() {
    this.audio = new AudioSystem({
      shot: AUDIO_MAX_SHOT_VOICES,
      impact: AUDIO_MAX_IMPACT_VOICES,
      step: AUDIO_MAX_STEP_VOICES,
      pickup: AUDIO_MAX_PICKUP_VOICES,
      ui: AUDIO_MAX_UI_VOICES,
    });
  }

  get system(): AudioSystem {
    return this.audio;
  }

  get volume(): number {
    return this.audio.masterVolume;
  }

  setVolume(value: number): void {
    this.audio.setVolume(value);
  }

  unlock(): void {
    void this.audio.unlock();
  }

  dispose(): void {
    this.audio.dispose();
  }

  // ----------------------------------------------------------------- events

  /** One server event, spatialised when it happened somewhere. */
  handleEvent(event: GameEvent, selfId: number): void {
    switch (event.type) {
      case EventType.Shot:
        this.weaponFire(event.weapon, event.shooterId === selfId, {
          x: event.x,
          y: event.y,
          z: event.z,
        });
        break;
      case EventType.Hit:
        // Confirmation for the shooter, so it belongs at the listener, not at
        // the victim - it is feedback about your own aim.
        this.audio.tone('ui', { gain: 1 }, 'sine', event.headshot ? 1500 : 1250, event.headshot ? 2300 : 1600, 0.05, 0.3);
        if (event.headshot) {
          this.audio.tone('ui', { gain: 1 }, 'sine', 2100, 2600, 0.05, 0.24, 0.05);
        }
        break;
      case EventType.Damaged:
        this.audio.noise('impact', { gain: 1, ducks: true }, 0.13, 420, 0.4, 'lowpass');
        this.audio.tone('impact', { gain: 1 }, 'triangle', 210, 120, 0.12, 0.24);
        break;
      case EventType.Kill:
        if (event.victimId === selfId) {
          // Downward pair: you went out.
          this.audio.tone('ui', { gain: 1 }, 'triangle', 520, 300, 0.16, 0.3);
          this.audio.tone('ui', { gain: 1 }, 'triangle', 330, 180, 0.24, 0.26, 0.12);
        } else if (event.killerId === selfId) {
          this.audio.tone('ui', { gain: 1 }, 'triangle', 520, 780, 0.1, 0.3);
          this.audio.tone('ui', { gain: 1 }, 'triangle', 780, 1040, 0.14, 0.26, 0.1);
        }
        break;
    }
  }

  /**
   * Weapon voices differ in body rather than in pitch alone: a shotgun is a
   * long low noise burst, an SMG a short bright tick, so they stay
   * distinguishable when several overlap.
   */
  private weaponFire(packed: number, self: boolean, at: Vec3): void {
    const weapon = unpackWeapon(packed);
    const cls = weapon === null ? WeaponClass.Pistol : weapon.cls;
    // Your own gun is not a point in the world, it is in your hands.
    const options = { at: self ? undefined : at, gain: self ? 1 : 0.9, ducks: true };

    switch (cls) {
      case WeaponClass.Shotgun:
        this.audio.noise('shot', options, 0.22, 900, 0.75, 'lowpass');
        this.audio.tone('shot', options, 'sawtooth', 110, 32, 0.16, 0.42);
        break;
      case WeaponClass.Rifle:
        this.audio.noise('shot', options, 0.09, 1800, 0.55, 'bandpass');
        this.audio.tone('shot', options, 'square', 160, 55, 0.07, 0.3);
        break;
      case WeaponClass.Smg:
        this.audio.noise('shot', options, 0.05, 2600, 0.36, 'bandpass');
        this.audio.tone('shot', options, 'square', 220, 90, 0.04, 0.2);
        break;
      default:
        this.audio.noise('shot', options, 0.07, 1400, 0.42, 'bandpass');
        this.audio.tone('shot', options, 'square', 190, 70, 0.05, 0.26);
        break;
    }
  }

  // --------------------------------------------------------------- per frame

  /**
   * Continuous state: footsteps, the beds, and anything detected by diffing
   * one snapshot against the last.
   */
  update(
    selfId: number,
    selfPos: Vec3,
    selfVelY: number,
    selfMode: number,
    selfOnGround: boolean,
    alive: boolean,
    remotes: ReadonlyMap<number, RenderedRemote>,
    loot: ReadonlyMap<number, LootItem>,
    round: RoundState,
  ): void {
    if (!this.audio.running) {
      this.previousLoot = new Map(loot);
      return;
    }

    this.trackRound(round, selfId);
    this.trackLoot(loot, selfPos);
    this.footsteps(selfId, selfPos, selfOnGround, alive, remotes);
    this.beds(selfPos, selfVelY, selfMode, round);
  }

  /** New round, storm phase change, and the victory sting. */
  private trackRound(round: RoundState, selfId: number): void {
    if (round.mapSeed !== this.lastMapSeed) {
      this.lastMapSeed = round.mapSeed;
      this.lastStormPhase = -1;
      this.announcedWin = false;
      // A fresh field of loot is not two hundred pickups.
      this.previousLoot.clear();
    }

    if (round.phase === RoundPhase.Playing && round.stormPhase !== this.lastStormPhase) {
      if (this.lastStormPhase >= 0) {
        // Two rising blips: the circle is about to move.
        this.audio.tone('ui', { gain: 1 }, 'sine', 660, 660, 0.12, 0.3);
        this.audio.tone('ui', { gain: 1 }, 'sine', 880, 880, 0.18, 0.32, 0.16);
      }
      this.lastStormPhase = round.stormPhase;
    }

    if (round.phase !== this.lastRoundPhase) {
      this.lastRoundPhase = round.phase;
      if (round.phase === RoundPhase.Bus) this.announcedWin = false;
    }

    if (round.phase === RoundPhase.Ended && round.winnerId === selfId && !this.announcedWin) {
      this.announcedWin = true;
      const notes = [523, 659, 784, 1047];
      notes.forEach((hz, index) => {
        this.audio.tone('ui', { gain: 1 }, 'triangle', hz, hz, 0.22, 0.3, index * 0.11);
      });
    }
  }

  /**
   * Loot that vanished since the last snapshot was picked up or opened, and the
   * snapshot says where it was - so other players' looting is audible too,
   * without the protocol needing an event for it.
   */
  private trackLoot(loot: ReadonlyMap<number, LootItem>, selfPos: Vec3): void {
    for (const [id, item] of this.previousLoot) {
      if (loot.has(id)) continue;
      const dx = item.x - selfPos.x;
      const dy = item.y - selfPos.y;
      const dz = item.z - selfPos.z;
      if (dx * dx + dy * dy + dz * dz > AUDIO_STEP_RANGE * AUDIO_STEP_RANGE) continue;
      const at = { x: item.x, y: item.y, z: item.z };
      if (item.kind === ItemKind.Chest) {
        // Hinge creak into a wooden thunk.
        this.audio.noise('pickup', { at, gain: 1 }, 0.18, 700, 0.3, 'bandpass');
        this.audio.tone('pickup', { at, gain: 1 }, 'triangle', 300, 120, 0.16, 0.26, 0.1);
      } else {
        // Rarity lifts the pitch, so a gold drop sounds like one.
        const hz = 620 + item.rarity * 110;
        this.audio.tone('pickup', { at, gain: 1 }, 'sine', hz, hz * 1.5, 0.08, 0.24);
      }
    }
    this.previousLoot = new Map(loot);
  }

  /**
   * Steps are emitted per distance travelled rather than on a timer, so they
   * speed up with sprinting for free and never drift out of step with motion.
   */
  private footsteps(
    selfId: number,
    selfPos: Vec3,
    selfOnGround: boolean,
    alive: boolean,
    remotes: ReadonlyMap<number, RenderedRemote>,
  ): void {
    if (alive && selfOnGround) this.accumulate(selfId, selfPos, undefined);

    for (const remote of remotes.values()) {
      if (!remote.alive || !remote.onGround) {
        this.lastSeen.delete(remote.id);
        continue;
      }
      const dx = remote.x - selfPos.x;
      const dz = remote.z - selfPos.z;
      const dy = remote.y - selfPos.y;
      if (dx * dx + dy * dy + dz * dz > AUDIO_STEP_RANGE * AUDIO_STEP_RANGE) {
        this.lastSeen.delete(remote.id);
        continue;
      }
      this.accumulate(remote.id, { x: remote.x, y: remote.y, z: remote.z }, {
        x: remote.x,
        y: remote.y,
        z: remote.z,
      });
    }

    // Anyone who left the snapshot stops accumulating.
    for (const id of [...this.lastSeen.keys()]) {
      if (id !== selfId && !remotes.has(id)) {
        this.lastSeen.delete(id);
        this.stepAccumulator.delete(id);
      }
    }
  }

  private accumulate(id: number, pos: Vec3, at: Vec3 | undefined): void {
    const previous = this.lastSeen.get(id);
    if (previous === undefined) {
      this.lastSeen.set(id, { x: pos.x, y: pos.y, z: pos.z });
      return;
    }
    const dx = pos.x - previous.x;
    const dz = pos.z - previous.z;
    const travelled = Math.hypot(dx, dz);
    previous.x = pos.x;
    previous.y = pos.y;
    previous.z = pos.z;

    // A teleport (respawn, leaving the bus) must not fire a burst of steps.
    if (travelled > AUDIO_STEP_DISTANCE * 4) {
      this.stepAccumulator.set(id, 0);
      return;
    }

    const total = (this.stepAccumulator.get(id) ?? 0) + travelled;
    if (total < AUDIO_STEP_DISTANCE) {
      this.stepAccumulator.set(id, total);
      return;
    }
    this.stepAccumulator.set(id, 0);
    // Alternating pitch keeps a run from sounding like a machine.
    const high = Math.random() < 0.5;
    this.audio.noise('step', { at, gain: at === undefined ? 0.5 : 0.85 }, 0.05, high ? 420 : 320, 0.32, 'lowpass');
  }

  /** Levels for the three continuous sounds. */
  private beds(selfPos: Vec3, selfVelY: number, selfMode: number, round: RoundState): void {
    // The bus is audible from the ground as it passes, and surrounds you while
    // riding - the panner handles both, because riders sit at its position.
    if (round.phase === RoundPhase.Bus) {
      busPosition(round.mapSeed, round.phaseTick, this.busPos);
      this.audio.setBed('bus', AUDIO_BUS_GAIN, this.busPos);
    } else {
      this.audio.setBed('bus', 0);
    }

    const falling = selfMode === MoveMode.Freefall || selfMode === MoveMode.Glide;
    const speed = Math.abs(selfVelY);
    this.audio.setBed(
      'wind',
      falling ? AUDIO_WIND_GAIN * clamp(speed / AUDIO_WIND_FULL_SPEED, 0.15, 1) : 0,
    );

    if (round.phase !== RoundPhase.Playing || round.stormRadius <= 0) {
      this.audio.setBed('storm', 0);
      return;
    }
    // Placed at the nearest point on the wall, so it tells you which way is out.
    const dx = selfPos.x - round.stormX;
    const dz = selfPos.z - round.stormZ;
    const distance = Math.hypot(dx, dz);
    const scale = distance < 0.001 ? 0 : round.stormRadius / distance;
    this.stormPoint.x = distance < 0.001 ? round.stormX + round.stormRadius : round.stormX + dx * scale;
    this.stormPoint.y = selfPos.y;
    this.stormPoint.z = distance < 0.001 ? round.stormZ : round.stormZ + dz * scale;

    // Silent at the centre, full at the wall, and stays full once outside.
    const toWall = round.stormRadius - distance;
    const closeness = 1 - clamp(toWall / AUDIO_STORM_FADE, 0, 1);
    this.audio.setBed('storm', AUDIO_STORM_GAIN * closeness, this.stormPoint);
  }
}
