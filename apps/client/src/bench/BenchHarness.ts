import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import '@babylonjs/core/Materials/standardMaterial';
import '@babylonjs/core/Meshes/Builders/boxBuilder';
import '@babylonjs/core/Meshes/Builders/sphereBuilder';
import '@babylonjs/core/Meshes/Builders/cylinderBuilder';

import {
  ColliderIndex,
  FIXED_DT,
  MATCH_MAX_PLAYERS,
  PLAYER_EYE_HEIGHT,
  createMovementState,
  directionFromAngles,
  getArena,
  mulberry32,
  stepMovement,
  type InputCommand,
  type MovementState,
  type Vec3,
} from '@riftfront/shared';

import { Avatar } from '../render/Avatar.js';
import { buildAvatarRig, type AvatarRig } from '../render/AvatarRig.js';
import { RiftField } from '../render/RiftField.js';
import { CameraRig } from '../render/CameraRig.js';
import { EffectsSystem } from '../render/Effects.js';
import { Environment } from '../render/Environment.js';
import { RenderStats } from '../render/RenderStats.js';
import { buildProps } from '../render/Props.js';
import { buildDecorPlan } from '../render/decorPlan.js';
import { buildArenaScenery } from '../render/SceneBuilder.js';

/**
 * Scripted rendering benchmark.
 *
 * Builds exactly the scene the game builds — same environment, same arena, same props,
 * same pooled VFX — then fills it with `players` synthetic bots that walk the arena and
 * fire continuously, and measures the frame time distribution.
 *
 * The headline number is the **1% low frame time**: the 99th percentile of the frame
 * time samples. Averages hide the stalls that players actually feel, and a shader
 * compile or a pool resize shows up there and nowhere else.
 *
 * The harness deliberately runs the *full* movement simulation for every bot. The real
 * client only simulates the local player and interpolates the other nineteen, so this
 * over-states the CPU cost rather than flattering it.
 */

export interface BenchOptions {
  /** Number of visible players, local player included. */
  players: number;
  /** Fire weapons and spawn the full VFX load every frame. */
  vfx: boolean;
  /** Sun shadow map. The first quality lever. */
  shadows: boolean;
  /** Decorative props, terrain and outer landscape. */
  props: boolean;
  /** Rift boundary shader. */
  storm: boolean;
  /**
   * `player` measures what the game actually renders: the over-the-shoulder rig, with
   * everything behind the camera culled. `overview` parks a wide static camera above the
   * arena so nothing is culled — a strictly harder frame, and the one used for
   * screenshots because it shows the whole map. `boundary` looks out across the wall at
   * the rift field, which is the only way to check that effect without playing.
   */
  camera: 'player' | 'overview' | 'boundary';
}

export const DEFAULT_BENCH_OPTIONS: BenchOptions = {
  players: 20,
  vfx: true,
  shadows: true,
  props: true,
  storm: true,
  camera: 'player',
};

export interface BenchResult {
  frames: number;
  durationMs: number;
  averageMs: number;
  medianMs: number;
  /** 99th percentile frame time — the "1% low". */
  onePercentLowMs: number;
  /** 99.9th percentile; catches single-frame stalls. */
  worstMs: number;
  /**
   * Time spent on the CPU inside the frame callback — simulation, animation and command
   * submission — excluding whatever the rasteriser does afterwards. This is the part of
   * the budget that scales with player count, and the part that is roughly the same on
   * any GPU, so it is the number to trust when the host has no hardware renderer.
   */
  cpuAverageMs: number;
  cpuOnePercentLowMs: number;
  fpsFromOnePercentLow: number;
  averageFps: number;
  drawCalls: number;
  triangles: number;
  textureBytes: number;
  activeMeshes: number;
  renderWidth: number;
  renderHeight: number;
  renderer: string;
}

/** A synthetic player: walks a seeded circuit and fires on a fixed cadence. */
interface Bot {
  id: string;
  state: MovementState;
  avatar: Avatar;
  yaw: number;
  targetYaw: number;
  turnAtMs: number;
  fireAtMs: number;
  sprinting: boolean;
  aiming: boolean;
}

const BOT_FIRE_INTERVAL_MS = 105;

export class BenchHarness {
  readonly engine: Engine;
  readonly scene: Scene;

  private readonly colliders = new ColliderIndex(getArena().colliders);
  private readonly environment: Environment;
  private readonly scenery: ReturnType<typeof buildArenaScenery>;
  private readonly props: ReturnType<typeof buildProps> | null;
  private readonly avatarRig: AvatarRig;
  private readonly rift: RiftField | null;
  private readonly effects: EffectsSystem;
  private readonly cameraRig: CameraRig;
  private readonly stats: RenderStats;
  private readonly bots: Bot[] = [];

  private readonly command: InputCommand = {
    seq: 0,
    moveX: 0,
    moveZ: 1,
    yaw: 0,
    pitch: 0,
    buttons: 0,
  };
  private readonly scratchOrigin: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchEnd: Vec3 = { x: 0, y: 0, z: 0 };

  private readonly overviewTarget = new Vector3(0, 2, 2);
  private readonly boundaryTarget = new Vector3(-70, 6, -74);

  private simulatedMs = 0;
  private lastCpuMs = 0;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly options: BenchOptions = DEFAULT_BENCH_OPTIONS,
  ) {
    this.engine = new Engine(canvas, true, {
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      stencil: false,
      failIfMajorPerformanceCaveat: false,
    });
    // The benchmark measures a fixed backbuffer size, never the device pixel ratio.
    this.engine.setHardwareScalingLevel(1);

    this.scene = new Scene(this.engine);
    this.scene.skipPointerMovePicking = true;

    this.environment = new Environment(this.scene);
    this.environment.setShadowsEnabled(options.shadows);

    const decor = options.props ? buildDecorPlan(getArena()) : null;
    this.scenery = buildArenaScenery(this.scene, getArena(), {
      environment: this.environment,
      skipVisualIds: decor ? new Set(decor.replacedVisualIds) : undefined,
    });
    this.props = decor ? buildProps(this.scene, decor, { environment: this.environment }) : null;
    this.effects = new EffectsSystem(this.scene);
    this.cameraRig = new CameraRig(this.scene, this.colliders);

    this.avatarRig = buildAvatarRig(this.scene);
    this.rift = options.storm ? new RiftField(this.scene) : null;
    this.stats = new RenderStats(this.scene);

    this.spawnBots(Math.max(1, Math.min(options.players, 64)));
  }

  private spawnBots(count: number): void {
    const arena = getArena();
    const random = mulberry32(0x51f7a9);

    for (let i = 0; i < count; i++) {
      // Spread bots over the spawn ring, then jitter so they do not stack.
      const spawn = arena.spawnPoints[i % arena.spawnPoints.length];
      const angle = (i / count) * Math.PI * 2;
      const radius = 6 + (i % Math.max(1, Math.ceil(count / MATCH_MAX_PLAYERS))) * 3;
      const position: Vec3 = {
        x: spawn.position.x * 0.7 + Math.cos(angle) * radius,
        y: spawn.position.y + 0.4,
        z: spawn.position.z * 0.7 + Math.sin(angle) * radius,
      };

      const id = `bench-bot-${i}`;
      this.bots.push({
        id,
        state: createMovementState(position),
        avatar: new Avatar(this.scene, id, {
          isLocal: i === 0,
          rig: this.avatarRig,
          environment: this.environment,
        }),
        yaw: spawn.yaw,
        targetYaw: spawn.yaw,
        turnAtMs: random() * 1200,
        fireAtMs: random() * BOT_FIRE_INTERVAL_MS,
        sprinting: i % 3 === 0,
        aiming: i % 5 === 0,
      });
    }
  }

  /** Advances the simulation and all visuals by one frame. */
  step(frameMs: number): void {
    if (this.disposed) return;
    const cpuStart = performance.now();
    const dtSeconds = frameMs / 1000;
    this.simulatedMs += frameMs;

    for (const bot of this.bots) {
      this.stepBot(bot, dtSeconds);
    }

    const local = this.bots[0];
    if (local) {
      this.environment.focus(local.state.position);
      this.rift?.update(dtSeconds, local.state.position);
      if (this.options.camera === 'overview' || this.options.camera === 'boundary') {
        this.applyStaticCamera();
      } else {
        this.cameraRig.update(
          {
            position: local.state.position,
            yaw: local.yaw,
            pitch: -0.08,
            aiming: local.aiming,
          },
          dtSeconds,
        );
      }
    }

    this.effects.update(dtSeconds);
    this.scene.render();
    this.lastCpuMs = performance.now() - cpuStart;
  }

  /** Fixed vantage points: the whole arena, or the rift boundary seen from inside it. */
  private applyStaticCamera(): void {
    const camera = this.cameraRig.camera;
    if (this.options.camera === 'boundary') {
      camera.position.set(-14, 13, -14);
      camera.setTarget(this.boundaryTarget);
      return;
    }
    camera.position.set(-38, 26, -40);
    camera.setTarget(this.overviewTarget);
  }

  private stepBot(bot: Bot, dtSeconds: number): void {
    if (this.simulatedMs >= bot.turnAtMs) {
      // A new heading every ~1.5 s keeps bots inside the arena and constantly re-poses
      // the avatars, so no frame gets to reuse last frame's animation work.
      bot.turnAtMs = this.simulatedMs + 900 + ((this.simulatedMs * 7919) % 1200);
      const towardsCentre = Math.atan2(-bot.state.position.x, -bot.state.position.z);
      const distance = Math.hypot(bot.state.position.x, bot.state.position.z);
      bot.targetYaw = distance > 22 ? towardsCentre : towardsCentre + Math.PI * 0.75;
    }

    // Turn smoothly towards the heading.
    const delta = Math.atan2(Math.sin(bot.targetYaw - bot.yaw), Math.cos(bot.targetYaw - bot.yaw));
    bot.yaw += delta * Math.min(1, dtSeconds * 3);

    this.command.seq += 1;
    this.command.moveX = 0;
    this.command.moveZ = 1;
    this.command.yaw = bot.yaw;
    this.command.pitch = 0;
    this.command.buttons = bot.sprinting ? 2 : 0;
    stepMovement(bot.state, this.command, FIXED_DT, this.colliders);

    bot.avatar.update({
      position: bot.state.position,
      yaw: bot.yaw,
      pitch: -0.05,
      moving: true,
      sprinting: bot.sprinting,
      aiming: bot.aiming,
      alive: true,
      grounded: bot.state.grounded,
      verticalVelocity: bot.state.velocity.y,
      dtSeconds,
    });

    if (this.options.vfx && this.simulatedMs >= bot.fireAtMs) {
      bot.fireAtMs = this.simulatedMs + BOT_FIRE_INTERVAL_MS;
      this.fireBot(bot);
    }
  }

  /** One full shot's worth of VFX: muzzle flash, tracer and a surface impact. */
  private fireBot(bot: Bot): void {
    const origin = this.scratchOrigin;
    origin.x = bot.state.position.x;
    origin.y = bot.state.position.y + PLAYER_EYE_HEIGHT;
    origin.z = bot.state.position.z;

    const direction = directionFromAngles(bot.yaw, -0.05);
    const hit = this.colliders.raycast(origin, direction, 90);
    const distance = hit ? hit.distance : 90;

    const end = this.scratchEnd;
    end.x = origin.x + direction.x * distance;
    end.y = origin.y + direction.y * distance;
    end.z = origin.z + direction.z * distance;

    this.effects.spawnTracer(origin, end);
    this.effects.spawnImpact(end, hit?.normal ?? null, 'world');
    this.effects.spawnMuzzleFlash(bot.avatar.getMuzzleWorldPosition(), direction);
  }

  /**
   * Runs the benchmark.
   *
   * `warmupFrames` are rendered and discarded first: the very first frames pay for
   * shader compilation and buffer uploads, and including them would make the 1% low a
   * measure of startup rather than of steady-state rendering.
   */
  async run(options: { frames: number; warmupFrames: number }): Promise<BenchResult> {
    const frameMs = 1000 / 60;

    for (let i = 0; i < options.warmupFrames; i++) {
      this.step(frameMs);
      await nextFrame();
    }

    const samples = new Float64Array(options.frames);
    const cpuSamples = new Float64Array(options.frames);
    let previous = performance.now();
    const startedAt = previous;

    for (let i = 0; i < options.frames; i++) {
      this.step(frameMs);
      cpuSamples[i] = this.lastCpuMs;
      await nextFrame();
      const now = performance.now();
      samples[i] = now - previous;
      previous = now;
    }

    const durationMs = performance.now() - startedAt;
    const counters = this.stats.sample(performance.now());

    const sorted = Array.from(samples).sort((a, b) => a - b);
    const cpuSorted = Array.from(cpuSamples).sort((a, b) => a - b);
    const percentileOf = (values: number[], p: number): number =>
      values[Math.min(values.length - 1, Math.floor(values.length * p))];
    const percentile = (p: number): number => percentileOf(sorted, p);
    const mean = (values: number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const averageMs = mean(sorted);
    const onePercentLowMs = percentile(0.99);

    return {
      frames: options.frames,
      durationMs,
      averageMs,
      medianMs: percentile(0.5),
      onePercentLowMs,
      worstMs: percentile(0.999),
      cpuAverageMs: mean(cpuSorted),
      cpuOnePercentLowMs: percentileOf(cpuSorted, 0.99),
      fpsFromOnePercentLow: 1000 / onePercentLowMs,
      averageFps: 1000 / averageMs,
      drawCalls: counters.drawCalls,
      triangles: counters.triangles,
      textureBytes: counters.textureBytes,
      activeMeshes: counters.activeMeshes,
      renderWidth: this.engine.getRenderWidth(),
      renderHeight: this.engine.getRenderHeight(),
      renderer: describeRenderer(this.engine),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const bot of this.bots) bot.avatar.dispose();
    this.bots.length = 0;
    this.stats.dispose();
    this.rift?.dispose();
    this.avatarRig.dispose();
    this.props?.dispose();
    this.effects.dispose();
    this.cameraRig.dispose();
    this.scenery.dispose();
    this.environment.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function describeRenderer(engine: Engine): string {
  const gl = engine._gl as WebGLRenderingContext | undefined;
  if (!gl) return 'unknown';
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const raw = info
    ? (gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as string)
    : (gl.getParameter(gl.RENDERER) as string);
  return raw ?? 'unknown';
}
