import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import { getArena, mulberry32, type MaterialKey, type Vec3 } from '@riftfront/shared';
import { SURFACES, VFX, hexToRgb } from './palette.js';
import { SurfaceLookup } from './surfaceLookup.js';

/**
 * Pooled combat VFX: tracers, muzzle flashes, impact sparks and surface dust.
 *
 * ## Allocation
 *
 * Everything — geometry, materials, transforms, colours, the random stream — is created
 * once in the constructor. The per-frame path only writes numbers into `Float32Array`s
 * that already exist, using a handful of scratch `Vector3`/`Quaternion`/`Matrix` objects
 * held as fields. No object of any kind is constructed inside `update()` or the spawn
 * methods, so a five-minute firefight produces exactly zero garbage from this module.
 *
 * ## Draw calls
 *
 * Each effect type is one mesh drawn with thin instances: one draw call, whether two
 * particles are alive or two hundred. Dead slots are parked with a zero-scale matrix,
 * which the GPU discards as degenerate triangles — far cheaper than resizing the buffer.
 *
 * ## Colour
 *
 * Impacts read the material of whatever they hit from `SurfaceLookup` and take that
 * surface's dust and spark colours, so shooting concrete, teal panelling and the rift
 * core all look different without a single extra material.
 */

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const FX_VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
#ifdef INSTANCES
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
#else
uniform mat4 world;
#endif
#ifdef INSTANCESCOLOR
attribute vec4 instanceColor;
#endif

uniform mat4 viewProjection;

varying vec4 vTint;
/** 0 at the instance's -Z end, 1 at its +Z end. Drives the tracer gradient. */
varying float vSpan;

void main() {
#ifdef INSTANCES
  mat4 finalWorld = mat4(world0, world1, world2, world3);
#else
  mat4 finalWorld = world;
#endif
#ifdef INSTANCESCOLOR
  vTint = instanceColor;
#else
  vTint = vec4(1.0);
#endif
  vSpan = position.z + 0.5;
  gl_Position = viewProjection * finalWorld * vec4(position, 1.0);
}
`;

const FX_FRAGMENT = /* glsl */ `
precision highp float;
varying vec4 vTint;
varying float vSpan;

uniform vec3 tailColour;
/** 0 for a uniform particle, 1 for a tracer that fades towards its tail. */
uniform float spanFade;

void main() {
  // The head of a tracer is the bullet; the tail is where it came from. Fading colour
  // and alpha along the span is what turns a stretched box into a streak.
  vec3 colour = mix(tailColour, vTint.rgb, mix(1.0, vSpan, spanFade));
  float alpha = vTint.a * mix(1.0, 0.15 + 0.85 * vSpan * vSpan, spanFade);
  // Premultiplied output. The pools pair this with ALPHA_ONEONE (additive) or
  // ALPHA_PREMULTIPLIED (blended); using the plain SRC_ALPHA modes here would apply
  // alpha twice and crush every particle to black.
  gl_FragColor = vec4(colour * alpha, alpha);
}
`;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Two perpendicular quads spanning local Z — a streak that reads from any angle. */
function buildCrossQuad(scene: Scene, name: string): Mesh {
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = [
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5,
    0.5, 0, -0.5, 0.5,
  ];
  data.indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  data.applyToMesh(mesh, false);
  return mesh;
}

/** A six-triangle octahedron: the cheapest thing that still reads as volume. */
function buildOctahedron(scene: Scene, name: string): Mesh {
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = [0, 0.5, 0, 0, -0.5, 0, 0.5, 0, 0, -0.5, 0, 0, 0, 0, 0.5, 0, 0, -0.5];
  data.indices = [0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 4, 2, 1, 3, 4, 1, 5, 3, 1, 2, 5];
  data.applyToMesh(mesh, false);
  return mesh;
}

/** A four-point star plus a forward spike: the muzzle flash silhouette. */
function buildFlashGeometry(scene: Scene, name: string): Mesh {
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = [
    // Star in the XY plane, facing along Z.
    -0.5, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, -0.5, 0,
    // Spike down the barrel.
    0, 0, 1.0, 0.22, 0, 0, -0.22, 0, 0, 0, 0.22, 0, 0, -0.22, 0,
  ];
  data.indices = [0, 2, 1, 0, 1, 3, 4, 5, 7, 4, 7, 6, 4, 6, 8, 4, 8, 5];
  data.applyToMesh(mesh, false);
  return mesh;
}

// ---------------------------------------------------------------------------
// Particle pool
// ---------------------------------------------------------------------------

interface PoolOptions {
  capacity: number;
  geometry: Mesh;
  material: ShaderMaterial;
  /** Metres per second squared applied to velocity, positive is downwards. */
  gravity: number;
  /** Air resistance per second. */
  drag: number;
}

/**
 * A fixed-size particle pool backed by structure-of-arrays typed buffers.
 *
 * The struct-of-arrays layout is not premature: it is what lets the whole update loop
 * run without touching a single JS object, which is the difference between a steady
 * frame time and a GC spike every few seconds during sustained fire.
 */
class ParticlePool {
  readonly mesh: Mesh;
  private readonly capacity: number;
  private readonly gravity: number;
  private readonly drag: number;

  private readonly remaining: Float32Array;
  private readonly lifetime: Float32Array;
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly rotation: Float32Array;
  private readonly scaleFrom: Float32Array;
  private readonly scaleTo: Float32Array;
  private readonly baseAlpha: Float32Array;

  private readonly matrices: Float32Array;
  private readonly colours: Float32Array;

  private readonly scratchScale = new Vector3();
  private readonly scratchRotation = new Quaternion();
  private readonly scratchPosition = new Vector3();
  private readonly scratchMatrix = new Matrix();

  private cursor = 0;
  private live = 0;
  private dirty = true;

  constructor(scene: Scene, name: string, options: PoolOptions) {
    this.capacity = options.capacity;
    this.gravity = options.gravity;
    this.drag = options.drag;

    this.remaining = new Float32Array(this.capacity);
    this.lifetime = new Float32Array(this.capacity).fill(1);
    this.position = new Float32Array(this.capacity * 3);
    this.velocity = new Float32Array(this.capacity * 3);
    this.rotation = new Float32Array(this.capacity * 4);
    this.scaleFrom = new Float32Array(this.capacity * 3);
    this.scaleTo = new Float32Array(this.capacity * 3);
    this.baseAlpha = new Float32Array(this.capacity);
    this.matrices = new Float32Array(this.capacity * 16);
    this.colours = new Float32Array(this.capacity * 4);

    this.mesh = options.geometry;
    this.mesh.name = name;
    this.mesh.material = options.material;
    this.mesh.isPickable = false;
    this.mesh.receiveShadows = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = true;
    // Left in the default rendering group deliberately. Babylon clears the depth buffer
    // between groups, so promoting VFX to group 1 would draw every spark and tracer
    // straight through the walls. Alpha blending already puts them after the opaque pass.
    this.mesh.thinInstanceSetBuffer('matrix', this.matrices, 16, false);
    this.mesh.thinInstanceSetBuffer('color', this.colours, 4, false);
    void scene;
  }

  /**
   * Claims a slot, recycling the oldest live particle when saturated.
   * Returns the slot index; the caller fills in its transform via the setters below.
   */
  acquire(lifetimeSeconds: number): number {
    let slot = -1;
    for (let i = 0; i < this.capacity; i++) {
      const index = (this.cursor + i) % this.capacity;
      if (this.remaining[index] <= 0) {
        slot = index;
        break;
      }
    }
    if (slot < 0) slot = this.cursor;

    this.cursor = (slot + 1) % this.capacity;
    if (this.remaining[slot] <= 0) this.live++;
    this.remaining[slot] = lifetimeSeconds;
    this.lifetime[slot] = lifetimeSeconds;
    this.velocity[slot * 3] = 0;
    this.velocity[slot * 3 + 1] = 0;
    this.velocity[slot * 3 + 2] = 0;
    this.dirty = true;
    return slot;
  }

  setPosition(slot: number, x: number, y: number, z: number): void {
    this.position[slot * 3] = x;
    this.position[slot * 3 + 1] = y;
    this.position[slot * 3 + 2] = z;
  }

  setVelocity(slot: number, x: number, y: number, z: number): void {
    this.velocity[slot * 3] = x;
    this.velocity[slot * 3 + 1] = y;
    this.velocity[slot * 3 + 2] = z;
  }

  setRotation(slot: number, quaternion: Quaternion): void {
    this.rotation[slot * 4] = quaternion.x;
    this.rotation[slot * 4 + 1] = quaternion.y;
    this.rotation[slot * 4 + 2] = quaternion.z;
    this.rotation[slot * 4 + 3] = quaternion.w;
  }

  setScale(slot: number, fromX: number, fromY: number, fromZ: number, growth: number): void {
    this.scaleFrom[slot * 3] = fromX;
    this.scaleFrom[slot * 3 + 1] = fromY;
    this.scaleFrom[slot * 3 + 2] = fromZ;
    this.scaleTo[slot * 3] = fromX * growth;
    this.scaleTo[slot * 3 + 1] = fromY * growth;
    this.scaleTo[slot * 3 + 2] = fromZ * growth;
  }

  setColour(slot: number, r: number, g: number, b: number, alpha: number): void {
    this.colours[slot * 4] = r;
    this.colours[slot * 4 + 1] = g;
    this.colours[slot * 4 + 2] = b;
    this.colours[slot * 4 + 3] = alpha;
    this.baseAlpha[slot] = alpha;
  }

  update(dtSeconds: number): void {
    if (this.live === 0) {
      if (this.dirty) this.flush();
      return;
    }

    const dragFactor = Math.max(0, 1 - this.drag * dtSeconds);

    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.remaining[slot] <= 0) continue;

      this.remaining[slot] -= dtSeconds;
      if (this.remaining[slot] <= 0) {
        this.live--;
        // Park the slot: a zero matrix collapses the instance to a point, which the
        // rasteriser rejects without ever shading a fragment.
        this.matrices.fill(0, slot * 16, slot * 16 + 16);
        this.colours[slot * 4 + 3] = 0;
        continue;
      }

      const progress = 1 - this.remaining[slot] / this.lifetime[slot];
      const p = slot * 3;

      this.velocity[p + 1] -= this.gravity * dtSeconds;
      this.velocity[p] *= dragFactor;
      this.velocity[p + 1] *= dragFactor;
      this.velocity[p + 2] *= dragFactor;
      this.position[p] += this.velocity[p] * dtSeconds;
      this.position[p + 1] += this.velocity[p + 1] * dtSeconds;
      this.position[p + 2] += this.velocity[p + 2] * dtSeconds;

      this.scratchScale.set(
        this.scaleFrom[p] + (this.scaleTo[p] - this.scaleFrom[p]) * progress,
        this.scaleFrom[p + 1] + (this.scaleTo[p + 1] - this.scaleFrom[p + 1]) * progress,
        this.scaleFrom[p + 2] + (this.scaleTo[p + 2] - this.scaleFrom[p + 2]) * progress,
      );
      const r = slot * 4;
      this.scratchRotation.set(
        this.rotation[r],
        this.rotation[r + 1],
        this.rotation[r + 2],
        this.rotation[r + 3],
      );
      this.scratchPosition.set(this.position[p], this.position[p + 1], this.position[p + 2]);
      Matrix.ComposeToRef(
        this.scratchScale,
        this.scratchRotation,
        this.scratchPosition,
        this.scratchMatrix,
      );
      this.scratchMatrix.copyToArray(this.matrices, slot * 16);

      // Fade out on a curve rather than linearly; a linear fade reads as a hard cut.
      const fade = 1 - progress;
      this.colours[r + 3] = this.baseAlpha[slot] * fade * fade;
    }

    this.flush();
  }

  private flush(): void {
    this.mesh.thinInstanceBufferUpdated('matrix');
    this.mesh.thinInstanceBufferUpdated('color');
    this.dirty = false;
  }

  get liveCount(): number {
    return this.live;
  }

  get poolCapacity(): number {
    return this.capacity;
  }

  dispose(): void {
    this.mesh.dispose(false, false);
  }
}

// ---------------------------------------------------------------------------
// Effects system
// ---------------------------------------------------------------------------

const TRACER_CAPACITY = 160;
const FLASH_CAPACITY = 40;
const SPARK_CAPACITY = 256;
const DUST_CAPACITY = 144;

const TRACER_LIFETIME = 0.075;
const FLASH_LIFETIME = 0.055;
const SPARK_LIFETIME = 0.32;
const DUST_LIFETIME = 0.55;

/** Sparks and dust per world impact. Kept low: readability beats spectacle in a shooter. */
const SPARKS_PER_IMPACT = 5;
const DUST_PER_IMPACT = 3;

/** Beyond this range a tracer has faded to its floor alpha. */
const TRACER_FADE_RANGE = 70;

export class EffectsSystem {
  private readonly tracers: ParticlePool;
  private readonly flashes: ParticlePool;
  private readonly sparks: ParticlePool;
  private readonly dust: ParticlePool;
  private readonly materials: ShaderMaterial[] = [];
  private readonly surfaces: SurfaceLookup;

  /** Pre-resolved surface colours, so no hex parsing happens during play. */
  private readonly dustColours = new Map<MaterialKey, { r: number; g: number; b: number }>();
  private readonly sparkColours = new Map<MaterialKey, { r: number; g: number; b: number }>();
  private readonly bloodSpark = hexToRgb(VFX.bloodSpark);
  private readonly bloodDust = hexToRgb(VFX.bloodDust);
  private readonly muzzleCore = hexToRgb(VFX.muzzleCore);
  private readonly tracerNear = hexToRgb(VFX.tracerNear);

  // Scratch state. Allocated once; reused by every spawn and every frame.
  private readonly scratchFrom = new Vector3();
  private readonly scratchTo = new Vector3();
  private readonly scratchDelta = new Vector3();
  private readonly scratchDirection = new Vector3();
  private readonly scratchQuaternion = new Quaternion();
  private readonly scratchForward = new Vector3(0, 0, 1);
  private readonly random: () => number;

  private disposed = false;

  constructor(scene: Scene) {
    this.surfaces = new SurfaceLookup(getArena());
    // A seeded stream rather than Math.random: identical spark fans on every client, and
    // no dependence on the host's RNG implementation.
    this.random = mulberry32(0x9e3779b9);

    for (const key of Object.keys(SURFACES) as MaterialKey[]) {
      this.dustColours.set(key, hexToRgb(SURFACES[key].dust));
      this.sparkColours.set(key, hexToRgb(SURFACES[key].spark));
    }

    const additive = this.material(scene, 'fx-additive', Constants.ALPHA_ONEONE, 0);
    const streak = this.material(scene, 'fx-streak', Constants.ALPHA_ONEONE, 1);
    const smoke = this.material(scene, 'fx-smoke', Constants.ALPHA_PREMULTIPLIED, 0);

    this.tracers = new ParticlePool(scene, 'fx-tracers', {
      capacity: TRACER_CAPACITY,
      geometry: buildCrossQuad(scene, 'fx-tracer-geometry'),
      material: streak,
      gravity: 0,
      drag: 0,
    });
    this.flashes = new ParticlePool(scene, 'fx-flashes', {
      capacity: FLASH_CAPACITY,
      geometry: buildFlashGeometry(scene, 'fx-flash-geometry'),
      material: additive,
      gravity: 0,
      drag: 0,
    });
    this.sparks = new ParticlePool(scene, 'fx-sparks', {
      capacity: SPARK_CAPACITY,
      geometry: buildCrossQuad(scene, 'fx-spark-geometry'),
      material: additive,
      gravity: 16,
      drag: 2.4,
    });
    this.dust = new ParticlePool(scene, 'fx-dust', {
      capacity: DUST_CAPACITY,
      geometry: buildOctahedron(scene, 'fx-dust-geometry'),
      material: smoke,
      gravity: -1.4,
      drag: 3.2,
    });
  }

  private material(
    scene: Scene,
    name: string,
    blendMode: number,
    spanFade: number,
  ): ShaderMaterial {
    const material = new ShaderMaterial(
      name,
      scene,
      { vertexSource: FX_VERTEX, fragmentSource: FX_FRAGMENT },
      {
        attributes: ['position'],
        uniforms: ['viewProjection', 'world', 'tailColour', 'spanFade'],
        needAlphaBlending: true,
        needAlphaTesting: false,
      },
    );
    material.setColor3('tailColour', Color3.FromHexString(VFX.tracerFar));
    material.setFloat('spanFade', spanFade);
    material.alphaMode = blendMode;
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.freeze();
    this.materials.push(material);
    return material;
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /**
   * A shot trail between two world points.
   *
   * Long shots arrive dimmer than close ones: a tracer that stays at full brightness for
   * 70 m draws the eye away from the target and makes every exchange look the same.
   */
  spawnTracer(from: Vec3, to: Vec3): void {
    if (this.disposed) return;

    this.scratchFrom.set(from.x, from.y, from.z);
    this.scratchTo.set(to.x, to.y, to.z);
    this.scratchTo.subtractToRef(this.scratchFrom, this.scratchDelta);
    const length = this.scratchDelta.length();
    if (length < 0.1) return;

    this.scratchDirection.copyFrom(this.scratchDelta).scaleInPlace(1 / length);
    Quaternion.FromUnitVectorsToRef(
      this.scratchForward,
      this.scratchDirection,
      this.scratchQuaternion,
    );

    const slot = this.tracers.acquire(TRACER_LIFETIME);
    this.tracers.setPosition(
      slot,
      this.scratchFrom.x + this.scratchDelta.x * 0.5,
      this.scratchFrom.y + this.scratchDelta.y * 0.5,
      this.scratchFrom.z + this.scratchDelta.z * 0.5,
    );
    this.tracers.setRotation(slot, this.scratchQuaternion);
    this.tracers.setScale(slot, 0.07, 0.07, length, 1);
    const distanceFade = Math.max(0.3, 1 - length / TRACER_FADE_RANGE);
    this.tracers.setColour(
      slot,
      this.tracerNear.r,
      this.tracerNear.g,
      this.tracerNear.b,
      distanceFade,
    );
  }

  /** Muzzle flash at the weapon's barrel, oriented down the shot if one is supplied. */
  spawnMuzzleFlash(position: Vector3, direction?: Vec3): void {
    if (this.disposed) return;

    if (direction) {
      this.scratchDirection.set(direction.x, direction.y, direction.z);
      Quaternion.FromUnitVectorsToRef(
        this.scratchForward,
        this.scratchDirection,
        this.scratchQuaternion,
      );
    } else {
      this.scratchQuaternion.set(0, 0, 0, 1);
    }

    const slot = this.flashes.acquire(FLASH_LIFETIME);
    this.flashes.setPosition(slot, position.x, position.y, position.z);
    this.flashes.setRotation(slot, this.scratchQuaternion);
    const size = 0.22 + this.random() * 0.09;
    this.flashes.setScale(slot, size, size, size * 1.4, 2.2);
    this.flashes.setColour(slot, this.muzzleCore.r, this.muzzleCore.g, this.muzzleCore.b, 1);
  }

  /**
   * A bullet impact: a spark fan along the surface normal plus a dust puff in the colour
   * of whatever was hit. Player hits swap both for the blood palette.
   */
  spawnImpact(point: Vec3, normal: Vec3 | null, kind: 'world' | 'player'): void {
    if (this.disposed) return;

    const isPlayer = kind === 'player';
    const material = isPlayer ? null : this.surfaces.materialAt(point, normal);
    const spark = isPlayer
      ? this.bloodSpark
      : (this.sparkColours.get(material!) ?? this.bloodSpark);
    const dust = isPlayer ? this.bloodDust : (this.dustColours.get(material!) ?? this.bloodDust);

    const nx = normal?.x ?? 0;
    const ny = normal?.y ?? 1;
    const nz = normal?.z ?? 0;

    for (let i = 0; i < SPARKS_PER_IMPACT; i++) {
      const slot = this.sparks.acquire(SPARK_LIFETIME * (0.6 + this.random() * 0.7));
      this.sparks.setPosition(slot, point.x + nx * 0.03, point.y + ny * 0.03, point.z + nz * 0.03);

      // Scatter in a cone around the surface normal.
      const speed = 3.2 + this.random() * 4.4;
      const vx = nx * speed + (this.random() - 0.5) * speed * 1.3;
      const vy = ny * speed + (this.random() - 0.5) * speed * 1.3;
      const vz = nz * speed + (this.random() - 0.5) * speed * 1.3;
      this.sparks.setVelocity(slot, vx, vy, vz);

      // Stretch each spark along its own flight direction so it reads as a streak.
      const magnitude = Math.hypot(vx, vy, vz) || 1;
      this.scratchDirection.set(vx / magnitude, vy / magnitude, vz / magnitude);
      Quaternion.FromUnitVectorsToRef(
        this.scratchForward,
        this.scratchDirection,
        this.scratchQuaternion,
      );
      this.sparks.setRotation(slot, this.scratchQuaternion);
      this.sparks.setScale(slot, 0.035, 0.035, 0.18 + this.random() * 0.22, 0.4);
      this.sparks.setColour(slot, spark.r, spark.g, spark.b, 1);
    }

    for (let i = 0; i < DUST_PER_IMPACT; i++) {
      const slot = this.dust.acquire(DUST_LIFETIME * (0.7 + this.random() * 0.6));
      this.dust.setPosition(slot, point.x + nx * 0.05, point.y + ny * 0.05, point.z + nz * 0.05);
      const drift = 1.5;
      this.dust.setVelocity(
        slot,
        nx * drift + (this.random() - 0.5) * 1.4,
        ny * drift + (this.random() - 0.5) * 1.4,
        nz * drift + (this.random() - 0.5) * 1.4,
      );
      this.scratchQuaternion.set(this.random() - 0.5, this.random() - 0.5, this.random() - 0.5, 1);
      this.scratchQuaternion.normalize();
      this.dust.setRotation(slot, this.scratchQuaternion);
      const size = isPlayer ? 0.16 : 0.2 + this.random() * 0.14;
      this.dust.setScale(slot, size, size, size, 2.6);
      this.dust.setColour(slot, dust.r, dust.g, dust.b, isPlayer ? 0.75 : 0.55);
    }
  }

  update(dtSeconds: number): void {
    if (this.disposed) return;
    this.tracers.update(dtSeconds);
    this.flashes.update(dtSeconds);
    this.sparks.update(dtSeconds);
    this.dust.update(dtSeconds);
  }

  /** Live particle count, surfaced by the performance overlay. */
  get activeCount(): number {
    return (
      this.tracers.liveCount + this.flashes.liveCount + this.sparks.liveCount + this.dust.liveCount
    );
  }

  get pooledCapacity(): number {
    return (
      this.tracers.poolCapacity +
      this.flashes.poolCapacity +
      this.sparks.poolCapacity +
      this.dust.poolCapacity
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tracers.dispose();
    this.flashes.dispose();
    this.sparks.dispose();
    this.dust.dispose();
    for (const material of this.materials) {
      material.unfreeze();
      material.dispose();
    }
    this.materials.length = 0;
  }
}
