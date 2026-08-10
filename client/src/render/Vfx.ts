import * as THREE from 'three';
import {
  VFX_DUST_LIFETIME_MS,
  VFX_FLASH_LIFETIME_MS,
  VFX_MAX_DUST,
  VFX_MAX_FLASHES,
  VFX_MAX_SPARKS,
  VFX_SPARKS_PER_HIT,
  VFX_SPARK_LIFETIME_MS,
  VFX_SPARK_SPEED,
  GRAVITY,
} from '@br/shared';

/**
 * Combat effects.
 *
 * Every pool is allocated once here and then only written to. Nothing in this
 * file constructs a geometry, a material, a Vector3 or an array while a frame
 * is running - a muzzle flash that allocates is a muzzle flash that stutters
 * once the garbage collector notices, and full-auto fire is the worst possible
 * time for that.
 *
 * Each pool is one InstancedMesh, so the whole VFX system is three draw calls
 * no matter how much is happening.
 */

/** Scratch, reused by every emit call. Never returned or retained. */
const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchMatrix = new THREE.Matrix4();
const scratchColor = new THREE.Color();

/** Flat arrays rather than objects: no per-particle allocation, ever. */
interface Pool {
  mesh: THREE.InstancedMesh;
  /** Position, then velocity, three floats each. */
  position: Float32Array;
  velocity: Float32Array;
  /** Wall-clock time each slot dies at; zero means free. */
  expiry: Float64Array;
  born: Float64Array;
  color: Float32Array;
  size: Float32Array;
  next: number;
  capacity: number;
  lifetime: number;
}

function makePool(
  scene: THREE.Scene,
  geometry: THREE.BufferGeometry,
  capacity: number,
  lifetime: number,
  blending: THREE.Blending,
): Pool {
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    blending,
    // Instance colour carries the tint; the base must be white or it multiplies.
    color: 0xffffff,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = capacity;
  scene.add(mesh);

  const pool: Pool = {
    mesh,
    position: new Float32Array(capacity * 3),
    velocity: new Float32Array(capacity * 3),
    expiry: new Float64Array(capacity),
    born: new Float64Array(capacity),
    color: new Float32Array(capacity * 3),
    size: new Float32Array(capacity),
    next: 0,
    capacity,
    lifetime,
  };
  // Everything starts collapsed to nothing, so an untouched slot draws nothing.
  scratchMatrix.makeScale(0, 0, 0);
  for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, scratchMatrix);
  mesh.instanceMatrix.needsUpdate = true;
  return pool;
}

/** Claims the next slot, overwriting the oldest when the pool is saturated. */
function claim(pool: Pool, now: number): number {
  const index = pool.next;
  pool.next = (pool.next + 1) % pool.capacity;
  pool.born[index] = now;
  pool.expiry[index] = now + pool.lifetime;
  return index;
}

export class Vfx {
  private readonly flashes: Pool;
  private readonly sparks: Pool;
  private readonly dust: Pool;
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(scene: THREE.Scene) {
    // A flat quad billboarded to camera; cheaper than a sphere and it is a
    // flash, so it has no silhouette to preserve.
    const flashGeometry = new THREE.PlaneGeometry(1, 1);
    const sparkGeometry = new THREE.BoxGeometry(1, 1, 1);
    const dustGeometry = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(flashGeometry, sparkGeometry, dustGeometry);

    this.flashes = makePool(
      scene,
      flashGeometry,
      VFX_MAX_FLASHES,
      VFX_FLASH_LIFETIME_MS,
      THREE.AdditiveBlending,
    );
    this.sparks = makePool(
      scene,
      sparkGeometry,
      VFX_MAX_SPARKS,
      VFX_SPARK_LIFETIME_MS,
      THREE.AdditiveBlending,
    );
    this.dust = makePool(scene, dustGeometry, VFX_MAX_DUST, VFX_DUST_LIFETIME_MS, THREE.NormalBlending);
  }

  /** A muzzle flash at the barrel, pointing along the shot. */
  muzzleFlash(x: number, y: number, z: number, size: number, now: number): void {
    const i = claim(this.flashes, now);
    this.flashes.position[i * 3] = x;
    this.flashes.position[i * 3 + 1] = y;
    this.flashes.position[i * 3 + 2] = z;
    this.flashes.velocity[i * 3] = 0;
    this.flashes.velocity[i * 3 + 1] = 0;
    this.flashes.velocity[i * 3 + 2] = 0;
    this.flashes.size[i] = size;
    this.flashes.color[i * 3] = 1;
    this.flashes.color[i * 3 + 1] = 0.86;
    this.flashes.color[i * 3 + 2] = 0.55;
  }

  /**
   * Sparks and a dust puff where a shot landed.
   *
   * `surfaceColor` is the colour of whatever was hit, so stone throws grey
   * dust and grass throws green - it is the cheapest way to make an impact
   * read as belonging to the thing it hit.
   */
  impact(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    surfaceColor: number,
    now: number,
  ): void {
    scratchColor.setHex(surfaceColor);

    for (let s = 0; s < VFX_SPARKS_PER_HIT; s++) {
      const i = claim(this.sparks, now);
      this.sparks.position[i * 3] = x;
      this.sparks.position[i * 3 + 1] = y;
      this.sparks.position[i * 3 + 2] = z;
      // Scattered around the surface normal, biased outward.
      const spreadX = Math.random() * 2 - 1;
      const spreadY = Math.random() * 2 - 1;
      const spreadZ = Math.random() * 2 - 1;
      const speed = VFX_SPARK_SPEED * (0.4 + Math.random() * 0.6);
      this.sparks.velocity[i * 3] = (nx + spreadX * 0.8) * speed;
      this.sparks.velocity[i * 3 + 1] = (ny + spreadY * 0.8 + 0.4) * speed;
      this.sparks.velocity[i * 3 + 2] = (nz + spreadZ * 0.8) * speed;
      this.sparks.size[i] = 0.05 + Math.random() * 0.05;
      this.sparks.color[i * 3] = 1;
      this.sparks.color[i * 3 + 1] = 0.78;
      this.sparks.color[i * 3 + 2] = 0.42;
    }

    const d = claim(this.dust, now);
    this.dust.position[d * 3] = x + nx * 0.1;
    this.dust.position[d * 3 + 1] = y + ny * 0.1;
    this.dust.position[d * 3 + 2] = z + nz * 0.1;
    this.dust.velocity[d * 3] = nx * 0.6;
    this.dust.velocity[d * 3 + 1] = ny * 0.6 + 0.5;
    this.dust.velocity[d * 3 + 2] = nz * 0.6;
    this.dust.size[d] = 0.5;
    // Lightened, so the puff reads against the surface it came off.
    this.dust.color[d * 3] = Math.min(1, scratchColor.r * 1.4 + 0.15);
    this.dust.color[d * 3 + 1] = Math.min(1, scratchColor.g * 1.4 + 0.15);
    this.dust.color[d * 3 + 2] = Math.min(1, scratchColor.b * 1.4 + 0.15);
  }

  /**
   * Advances every live particle and writes the instance matrices.
   *
   * `dt` is in seconds. Billboarding uses the camera's quaternion directly
   * rather than a lookAt per particle, which would be a matrix inverse each.
   */
  update(now: number, dt: number, camera: THREE.Camera): void {
    this.step(this.flashes, now, dt, camera, false, 0);
    this.step(this.sparks, now, dt, camera, false, GRAVITY * 0.35);
    this.step(this.dust, now, dt, camera, true, -0.4);
  }

  private step(
    pool: Pool,
    now: number,
    dt: number,
    camera: THREE.Camera,
    grow: boolean,
    gravity: number,
  ): void {
    scratchQuaternion.copy(camera.quaternion);
    let live = 0;

    for (let i = 0; i < pool.capacity; i++) {
      const expiry = pool.expiry[i]!;
      if (expiry === 0) continue;
      if (now >= expiry) {
        pool.expiry[i] = 0;
        scratchMatrix.makeScale(0, 0, 0);
        pool.mesh.setMatrixAt(i, scratchMatrix);
        continue;
      }
      live += 1;

      const age = (now - pool.born[i]!) / pool.lifetime;
      pool.velocity[i * 3 + 1] = pool.velocity[i * 3 + 1]! - gravity * dt;
      pool.position[i * 3] = pool.position[i * 3]! + pool.velocity[i * 3]! * dt;
      pool.position[i * 3 + 1] = pool.position[i * 3 + 1]! + pool.velocity[i * 3 + 1]! * dt;
      pool.position[i * 3 + 2] = pool.position[i * 3 + 2]! + pool.velocity[i * 3 + 2]! * dt;

      // Flashes and sparks shrink away; dust expands as it dissipates.
      const fade = 1 - age;
      const size = pool.size[i]! * (grow ? 1 + age * 2.2 : fade);
      scratchPosition.set(pool.position[i * 3]!, pool.position[i * 3 + 1]!, pool.position[i * 3 + 2]!);
      scratchScale.set(size, size, size);
      scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
      pool.mesh.setMatrixAt(i, scratchMatrix);

      // Alpha is folded into the instance colour: one less uniform to vary and
      // additive blending fades to nothing as the colour goes to black anyway.
      scratchColor.setRGB(
        pool.color[i * 3]! * fade,
        pool.color[i * 3 + 1]! * fade,
        pool.color[i * 3 + 2]! * fade,
      );
      pool.mesh.setColorAt(i, scratchColor);
    }

    pool.mesh.instanceMatrix.needsUpdate = true;
    if (pool.mesh.instanceColor !== null) pool.mesh.instanceColor.needsUpdate = true;
    pool.mesh.visible = live > 0;
  }

  dispose(scene: THREE.Scene): void {
    for (const pool of [this.flashes, this.sparks, this.dust]) {
      scene.remove(pool.mesh);
      pool.mesh.dispose();
      (pool.mesh.material as THREE.Material).dispose();
    }
    for (const geometry of this.geometries) geometry.dispose();
  }
}
