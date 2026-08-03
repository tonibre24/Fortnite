import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { type Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Scene } from '@babylonjs/core/scene';
import type { Vec3 } from '@riftfront/shared';

/**
 * Pooled combat effects: tracers, muzzle flashes and impact sparks.
 *
 * Every effect comes from a fixed-size pool allocated once at startup. Nothing is
 * created or destroyed during play, so a long match cannot accumulate meshes, materials
 * or GC pressure. When a pool is exhausted the oldest live effect is recycled, which
 * degrades gracefully instead of stuttering.
 */

interface PooledEffect {
  mesh: Mesh;
  /** Remaining lifetime in seconds; <= 0 means free. */
  remaining: number;
  lifetime: number;
  startScale: Vector3;
}

interface PoolConfig {
  count: number;
  build: (index: number) => Mesh;
}

class EffectPool {
  private readonly entries: PooledEffect[] = [];
  private cursor = 0;

  constructor(config: PoolConfig) {
    for (let i = 0; i < config.count; i++) {
      const mesh = config.build(i);
      mesh.setEnabled(false);
      mesh.isPickable = false;
      mesh.doNotSyncBoundingInfo = true;
      this.entries.push({
        mesh,
        remaining: 0,
        lifetime: 1,
        startScale: mesh.scaling.clone(),
      });
    }
  }

  /** Returns a free entry, recycling the oldest live one when the pool is saturated. */
  acquire(lifetimeSeconds: number): PooledEffect {
    for (let i = 0; i < this.entries.length; i++) {
      const index = (this.cursor + i) % this.entries.length;
      const entry = this.entries[index];
      if (entry.remaining <= 0) {
        this.cursor = (index + 1) % this.entries.length;
        entry.remaining = lifetimeSeconds;
        entry.lifetime = lifetimeSeconds;
        entry.mesh.setEnabled(true);
        return entry;
      }
    }

    const entry = this.entries[this.cursor];
    this.cursor = (this.cursor + 1) % this.entries.length;
    entry.remaining = lifetimeSeconds;
    entry.lifetime = lifetimeSeconds;
    entry.mesh.setEnabled(true);
    return entry;
  }

  update(dtSeconds: number, onTick: (entry: PooledEffect, progress: number) => void): void {
    for (const entry of this.entries) {
      if (entry.remaining <= 0) continue;
      entry.remaining -= dtSeconds;
      if (entry.remaining <= 0) {
        entry.mesh.setEnabled(false);
        continue;
      }
      onTick(entry, 1 - entry.remaining / entry.lifetime);
    }
  }

  get liveCount(): number {
    let count = 0;
    for (const entry of this.entries) if (entry.remaining > 0) count++;
    return count;
  }

  get capacity(): number {
    return this.entries.length;
  }

  dispose(): void {
    for (const entry of this.entries) entry.mesh.dispose(false, false);
    this.entries.length = 0;
  }
}

const TRACER_POOL_SIZE = 64;
const FLASH_POOL_SIZE = 16;
const IMPACT_POOL_SIZE = 48;

const TRACER_LIFETIME = 0.07;
const FLASH_LIFETIME = 0.045;
const IMPACT_LIFETIME = 0.28;

export class EffectsSystem {
  private readonly tracers: EffectPool;
  private readonly flashes: EffectPool;
  private readonly impacts: EffectPool;
  private readonly materials: StandardMaterial[] = [];
  private disposed = false;

  constructor(private readonly scene: Scene) {
    const tracerMat = this.material('fx-tracer', '#ffe9a8', 1);
    const flashMat = this.material('fx-flash', '#fff3c4', 1);
    const worldImpactMat = this.material('fx-impact-world', '#ffd08a', 1);
    const bloodImpactMat = this.material('fx-impact-player', '#ff5d6c', 1);

    this.tracers = new EffectPool({
      count: TRACER_POOL_SIZE,
      build: (i) => {
        const mesh = MeshBuilder.CreateBox(
          `tracer-${i}`,
          { width: 0.05, height: 0.05, depth: 1 },
          this.scene,
        );
        mesh.material = tracerMat;
        mesh.rotationQuaternion = Quaternion.Identity();
        return mesh;
      },
    });

    this.flashes = new EffectPool({
      count: FLASH_POOL_SIZE,
      build: (i) => {
        const mesh = MeshBuilder.CreateSphere(
          `flash-${i}`,
          { diameter: 0.42, segments: 4 },
          this.scene,
        );
        mesh.material = flashMat;
        return mesh;
      },
    });

    // Two impact flavours share one pool; the material is swapped on acquire.
    this.impacts = new EffectPool({
      count: IMPACT_POOL_SIZE,
      build: (i) => {
        const mesh = MeshBuilder.CreateBox(`impact-${i}`, { size: 0.16 }, this.scene);
        mesh.material = i % 2 === 0 ? worldImpactMat : bloodImpactMat;
        mesh.rotationQuaternion = Quaternion.Identity();
        return mesh;
      },
    });

    this.worldImpactMaterial = worldImpactMat;
    this.playerImpactMaterial = bloodImpactMat;
  }

  private readonly worldImpactMaterial: StandardMaterial;
  private readonly playerImpactMaterial: StandardMaterial;

  private material(name: string, hex: string, alpha: number): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    const colour = Color3.FromHexString(hex);
    material.emissiveColor = colour;
    material.diffuseColor = colour;
    material.disableLighting = true;
    material.alpha = alpha;
    material.backFaceCulling = false;
    this.materials.push(material);
    return material;
  }

  /** Draws a shot trail between two world points. */
  spawnTracer(from: Vec3, to: Vec3): void {
    if (this.disposed) return;
    const start = new Vector3(from.x, from.y, from.z);
    const end = new Vector3(to.x, to.y, to.z);
    const delta = end.subtract(start);
    const length = delta.length();
    if (length < 0.05) return;

    const entry = this.tracers.acquire(TRACER_LIFETIME);
    entry.mesh.position.copyFrom(start.add(end).scale(0.5));
    entry.mesh.scaling.set(1, 1, length);

    // Orient the unit-depth box along the shot direction.
    const direction = delta.scale(1 / length);
    const rotation = entry.mesh.rotationQuaternion ?? Quaternion.Identity();
    Quaternion.FromUnitVectorsToRef(Vector3.Forward(), direction, rotation);
    entry.mesh.rotationQuaternion = rotation;
    entry.startScale.set(1, 1, length);
  }

  spawnMuzzleFlash(position: Vector3): void {
    if (this.disposed) return;
    const entry = this.flashes.acquire(FLASH_LIFETIME);
    entry.mesh.position.copyFrom(position);
    entry.mesh.scaling.setAll(1);
    entry.startScale.setAll(1);
  }

  spawnImpact(point: Vec3, normal: Vec3 | null, kind: 'world' | 'player'): void {
    if (this.disposed) return;
    const entry = this.impacts.acquire(IMPACT_LIFETIME);
    entry.mesh.material = kind === 'player' ? this.playerImpactMaterial : this.worldImpactMaterial;

    const offset = normal ? new Vector3(normal.x, normal.y, normal.z).scale(0.06) : Vector3.Zero();
    entry.mesh.position.set(point.x + offset.x, point.y + offset.y, point.z + offset.z);
    entry.mesh.scaling.setAll(kind === 'player' ? 1.25 : 1);
    entry.startScale.copyFrom(entry.mesh.scaling);
  }

  update(dtSeconds: number): void {
    if (this.disposed) return;

    this.tracers.update(dtSeconds, (entry, progress) => {
      // Tracers thin out rather than shrinking lengthwise, which reads as a streak.
      const thickness = 1 - progress * 0.85;
      entry.mesh.scaling.set(thickness, thickness, entry.startScale.z);
    });

    this.flashes.update(dtSeconds, (entry, progress) => {
      entry.mesh.scaling.setAll(1 + progress * 1.6);
    });

    this.impacts.update(dtSeconds, (entry, progress) => {
      const scale = entry.startScale.x * (1 + progress * 2.2);
      entry.mesh.scaling.setAll(scale);
      entry.mesh.position.y += dtSeconds * 0.35;
    });
  }

  /** Live effect count, surfaced by the performance panel. */
  get activeCount(): number {
    return this.tracers.liveCount + this.flashes.liveCount + this.impacts.liveCount;
  }

  get pooledCapacity(): number {
    return this.tracers.capacity + this.flashes.capacity + this.impacts.capacity;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tracers.dispose();
    this.flashes.dispose();
    this.impacts.dispose();
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
  }
}
