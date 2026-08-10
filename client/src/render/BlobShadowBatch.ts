import * as THREE from 'three';
import { BLOB_SHADOW_DARKNESS, BLOB_SHADOW_Y_OFFSET } from '@br/shared';

/**
 * One instanced mesh of soft, round ground-contact decals - the cheap fake AO
 * a scattered prop needs to read as sitting on the ground rather than
 * hovering just above it, without a real shadow map entry of its own.
 *
 * Unlit and multiply-blended: it darkens whatever is already under it rather
 * than pasting a flat-coloured disc on top, so it looks reasonable over the
 * ground's own varied tint instead of fighting it.
 */
export class BlobShadowBatch {
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private count = 0;

  constructor(group: THREE.Group, capacity: number) {
    this.texture = buildBlobTexture();
    this.geometry = new THREE.PlaneGeometry(1, 1);
    // Flat on the ground in local space, so instance scale maps directly to a
    // world-space diameter with no per-instance rotation math needed.
    this.geometry.rotateX(-Math.PI / 2);
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      blending: THREE.MultiplyBlending,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, Math.max(1, capacity));
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    group.add(this.mesh);
  }

  /** Drops a shadow disc of the given world-space radius at (x, groundY, z). */
  add(x: number, groundY: number, z: number, radius: number): void {
    if (this.count >= this.mesh.instanceMatrix.count) return;
    this.position.set(x, groundY + BLOB_SHADOW_Y_OFFSET, z);
    this.scale.set(radius * 2, radius * 2, 1);
    this.matrix.compose(this.position, this.quaternion, this.scale);
    this.mesh.setMatrixAt(this.count, this.matrix);
    this.count += 1;
    this.mesh.count = this.count;
  }

  /** Call once after every add() this build pass is done. */
  finalize(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get propCount(): number {
    return this.count;
  }

  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/**
 * A soft round vignette: dark at the centre, fully white (a no-op under
 * multiply blending) by the edge, so the decal has no visible hard boundary.
 */
function buildBlobTexture(size = 64): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d canvas context unavailable');

  const shade = Math.round((1 - BLOB_SHADOW_DARKNESS) * 255);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, `rgb(${shade},${shade},${shade})`);
  gradient.addColorStop(0.6, `rgb(${shade},${shade},${shade})`);
  gradient.addColorStop(1, 'rgb(255,255,255)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
