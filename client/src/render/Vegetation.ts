import * as THREE from 'three';
import {
  COLOR_SHRUB_A,
  COLOR_SHRUB_B,
  FARM_SEED_SALT,
  HEDGE_SPACING,
  MAP_HALF,
  PROP_TINT_JITTER,
  Rng,
  SPAWN_CLEARANCE_RADIUS,
  VEGETATION_COUNT,
  VEGETATION_FALLOFF_RADIUS,
  VEGETATION_MAX_HEIGHT,
  VEGETATION_MAX_WIDTH,
  VEGETATION_MIN_DENSITY,
  VEGETATION_MIN_HEIGHT,
  VEGETATION_MIN_WIDTH,
  VEGETATION_WIND_STRENGTH,
  terrainHeightAt,
  type Building,
  type GameMap,
  type Poi,
} from '@br/shared';
import { BlobShadowBatch } from './BlobShadowBatch.js';
import { buildCrossBillboardGeometry, buildFoliageTexture } from './Foliage.js';
import { fieldBoundaryPoints } from './fieldBoundaries.js';

/**
 * Deciduous shrubs and small trees as instanced alpha-cutout cross-billboards
 * - two perpendicular cards rather than solid geometry, which reads as full
 * foliage from any angle at a fraction of the triangle cost.
 *
 * Lighting comes from the ordinary MeshStandardMaterial/CSM path every other
 * surface uses - onBeforeCompile only adds the wind sway, so shadows, the
 * baked sky IBL and the cascade blend fix all apply unmodified. The one thing
 * a stock material cannot do is move, which is the one thing added here.
 */
export class Vegetation {
  private readonly group = new THREE.Group();
  private readonly geometry = buildCrossBillboardGeometry();
  private readonly leafMap: THREE.CanvasTexture;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly mesh: THREE.InstancedMesh;
  private readonly shadows: BlobShadowBatch;
  private readonly windUniform = { value: 0 };
  private count = 0;

  constructor(
    scene: THREE.Scene,
    map: GameMap,
    setupCascadeMaterial: (material: THREE.Material) => void,
    density = 1,
    anisotropy = 1,
  ) {
    const rng = new Rng((map.seed ^ FARM_SEED_SALT) >>> 0);
    this.leafMap = buildFoliageTexture(rng);
    // Alpha-cutout foliage is the other surface that shimmers badly under
    // isotropic filtering - hundreds of thin billboard edges crawling as the
    // camera moves. Same near-zero cost as on the ground.
    this.leafMap.anisotropy = anisotropy;

    this.material = new THREE.MeshStandardMaterial({
      map: this.leafMap,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0,
    });
    injectWindSway(this.material, this.windUniform);
    setupCascadeMaterial(this.material);

    const hedgePoints = fieldBoundaryPoints(map, HEDGE_SPACING).filter((p) => p.isHedge);
    const scatterCount = Math.round(VEGETATION_COUNT * density);
    const capacity = scatterCount + hedgePoints.length;

    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, Math.max(1, capacity));
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.group.add(this.mesh);
    this.shadows = new BlobShadowBatch(this.group, Math.max(1, capacity));

    this.scatterShrubs(rng, map, scatterCount);
    this.placeHedges(rng, map, hedgePoints);

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
    this.shadows.finalize();
    scene.add(this.group);
  }

  /**
   * Open-ground shrubs. Scatter probability falls off with distance from the
   * nearest POI rather than being uniform - hedgerow country reads as busiest
   * near the farmsteads it borders and thins into open field beyond them.
   */
  private scatterShrubs(rng: Rng, map: GameMap, target: number): void {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const axisY = new THREE.Vector3(0, 1, 0);
    const base = new THREE.Color();
    const warm = new THREE.Color(COLOR_SHRUB_A);
    const cool = new THREE.Color(COLOR_SHRUB_B);
    const tint = new THREE.Color();

    let placed = 0;
    const maxAttempts = Math.max(1, target) * 4;
    for (let attempt = 0; placed < target && attempt < maxAttempts; attempt++) {
      const x = rng.range(-MAP_HALF, MAP_HALF);
      const z = rng.range(-MAP_HALF, MAP_HALF);
      const falloff = Math.max(VEGETATION_MIN_DENSITY, 1 - nearestPoiDistance(map.pois, x, z) / VEGETATION_FALLOFF_RADIUS);
      if (!rng.bool(falloff)) continue;
      if (Math.hypot(x, z) < SPAWN_CLEARANCE_RADIUS) continue;
      if (insideAnyBuilding(map.buildings, x, z)) continue;

      const y = terrainHeightAt(map.hills, x, z);
      quaternion.setFromAxisAngle(axisY, rng.range(0, Math.PI * 2));
      const height = rng.range(VEGETATION_MIN_HEIGHT, VEGETATION_MAX_HEIGHT);
      const width = rng.range(VEGETATION_MIN_WIDTH, VEGETATION_MAX_WIDTH);
      scale.set(width, height, width);
      position.set(x, y, z);
      matrix.compose(position, quaternion, scale);

      base.copy(warm).lerp(cool, rng.range(0, 1));
      this.place(matrix, base, tint, rng);
      this.shadows.add(x, y, z, width * 0.38);
      placed += 1;
    }
  }

  /** Dense shrub rows along the field-boundary lines the hash assigned to a hedge. */
  private placeHedges(rng: Rng, map: GameMap, points: readonly { x: number; z: number }[]): void {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const axisY = new THREE.Vector3(0, 1, 0);
    const base = new THREE.Color();
    const warm = new THREE.Color(COLOR_SHRUB_A);
    const cool = new THREE.Color(COLOR_SHRUB_B);
    const tint = new THREE.Color();

    for (const p of points) {
      const y = terrainHeightAt(map.hills, p.x, p.z);
      quaternion.setFromAxisAngle(axisY, rng.range(0, Math.PI * 2));
      // Hedges read as a continuous mass, not individual bushes - shorter and
      // squatter than an open-field shrub, packed tighter than they are wide.
      const height = rng.range(VEGETATION_MIN_HEIGHT * 0.7, VEGETATION_MIN_HEIGHT * 1.15);
      const width = HEDGE_SPACING * rng.range(1.6, 2.1);
      scale.set(width, height, width);
      position.set(p.x, y, p.z);
      matrix.compose(position, quaternion, scale);

      base.copy(warm).lerp(cool, rng.range(0, 1));
      this.place(matrix, base, tint, rng);
      this.shadows.add(p.x, y, p.z, width * 0.45);
    }
  }

  private place(matrix: THREE.Matrix4, base: THREE.Color, tint: THREE.Color, rng: Rng): void {
    if (this.count >= this.mesh.instanceMatrix.count) return;
    this.mesh.setMatrixAt(this.count, matrix);
    tint.copy(base).offsetHSL(
      rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.15,
      rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.4,
      rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER),
    );
    this.mesh.setColorAt(this.count, tint);
    this.count += 1;
    this.mesh.count = this.count;
  }

  /** Advances the wind phase. Cheap enough to call unconditionally every frame. */
  update(seconds: number): void {
    this.windUniform.value = seconds;
  }

  get propCount(): number {
    return this.count;
  }

  /** For the perf overlay's memory estimate. */
  get textures(): THREE.Texture[] {
    return [this.leafMap];
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.mesh.dispose();
    this.shadows.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.leafMap.dispose();
  }
}

function nearestPoiDistance(pois: readonly Poi[], x: number, z: number): number {
  let best = Infinity;
  for (const poi of pois) {
    const d = Math.hypot(x - poi.x, z - poi.z);
    if (d < best) best = d;
  }
  return best;
}

function insideAnyBuilding(buildings: readonly Building[], x: number, z: number): boolean {
  for (const b of buildings) {
    if (x > b.minX - 1 && x < b.maxX + 1 && z > b.minZ - 1 && z < b.maxZ + 1) return true;
  }
  return false;
}

/**
 * Adds wind sway to an otherwise ordinary MeshStandardMaterial by patching
 * the one chunk that needs it. `transformed` at this point in the standard
 * vertex shader is still local space (before instanceMatrix), so the sway
 * scales and rotates with each instance automatically, and `transformed.y`
 * - 0 at a billboard's root, 1 at its tip in this geometry - is exactly the
 * "how much does this vertex move" weight without any extra attribute.
 */
function injectWindSway(material: THREE.MeshStandardMaterial, windUniform: { value: number }): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.windTime = windUniform;
    shader.uniforms.windStrength = { value: VEGETATION_WIND_STRENGTH };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float windTime;\nuniform float windStrength;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float sway = transformed.y * windStrength;
        float swayPhase = instanceMatrix[3].x * 0.35 + instanceMatrix[3].z * 0.35;
        transformed.x += sin(windTime * 1.6 + swayPhase) * sway;
        transformed.z += cos(windTime * 1.3 + swayPhase * 0.7) * sway * 0.6;`,
      );
  };
}
