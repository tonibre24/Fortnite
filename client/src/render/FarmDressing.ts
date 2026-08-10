import * as THREE from 'three';
import {
  CABLE_SAG,
  COLOR_CABLE,
  COLOR_DIRT_TRACK,
  COLOR_FIELD_FENCE,
  COLOR_HAY,
  COLOR_POLE,
  FARM_SEED_SALT,
  FENCE_POST_SPACING,
  HAY_BALE_COUNT,
  HAY_BALE_LENGTH,
  HAY_BALE_RADIUS,
  MAP_HALF,
  POLE_CROSSARM_HEIGHT,
  POLE_CROSSARM_WIDTH,
  POLE_HEIGHT,
  POLE_SPACING,
  PROP_TINT_JITTER,
  Rng,
  SPAWN_CLEARANCE_RADIUS,
  TRACK_SEGMENT_LENGTH,
  TRACK_WIDTH,
  VEGETATION_FALLOFF_RADIUS,
  VEGETATION_MIN_DENSITY,
  terrainHeightAt,
  type Building,
  type GameMap,
  type Poi,
} from '@br/shared';
import { BlobShadowBatch } from './BlobShadowBatch.js';
import { fieldBoundaryPoints } from './fieldBoundaries.js';

interface Batch {
  mesh: THREE.InstancedMesh;
  count: number;
  baseColor: THREE.Color;
}

/**
 * Everything about the countryside that is not a plant: dirt tracks strung
 * between the farmsteads, power poles and their sagging cables along those
 * tracks, low fences on the field-boundary lines Vegetation did not claim for
 * a hedge, and hay bales dropped near the POIs they belong to.
 *
 * All decorative, all client-side, all derived from the map seed - see
 * WorldView.ts and Decor.ts for why that split matters.
 */
export class FarmDressing {
  private readonly group = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly batches: Batch[] = [];
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchQuaternion = new THREE.Quaternion();
  private readonly scratchScale = new THREE.Vector3();
  private readonly scratchAxisY = new THREE.Vector3(0, 1, 0);
  private readonly scratchTint = new THREE.Color();
  private readonly cableGeometry: THREE.BufferGeometry;
  private readonly cableMaterial: THREE.LineBasicMaterial;
  private readonly cableLines: THREE.LineSegments;
  private readonly shadows: BlobShadowBatch;

  constructor(
    scene: THREE.Scene,
    map: GameMap,
    setupCascadeMaterial: (material: THREE.Material) => void,
    density = 1,
  ) {
    const rng = new Rng((map.seed ^ FARM_SEED_SALT ^ 0x2211) >>> 0);
    const edges = spanningEdges(map.pois);

    let poleTotal = 0;
    for (const [a, b] of edges) poleTotal += Math.floor(Math.hypot(b.x - a.x, b.z - a.z) / POLE_SPACING) + 1;
    const hayBaleTotal = Math.round(HAY_BALE_COUNT * density);

    const fencePosts = fieldBoundaryPoints(map, FENCE_POST_SPACING).filter((p) => !p.isHedge);
    const fence = this.batch(new THREE.BoxGeometry(0.14, 1, 0.14), COLOR_FIELD_FENCE, fencePosts.length, true, setupCascadeMaterial);
    this.shadows = new BlobShadowBatch(this.group, Math.max(1, fencePosts.length + poleTotal + hayBaleTotal));
    for (const p of fencePosts) {
      const y = terrainHeightAt(map.hills, p.x, p.z);
      this.placeBox(fence, p.x, y + 0.5, p.z, rng.range(0, Math.PI), 1, 1, 1, rng);
      this.shadows.add(p.x, y, p.z, 0.35);
    }

    let trackTotal = 0;
    for (const [a, b] of edges) trackTotal += Math.round(Math.hypot(b.x - a.x, b.z - a.z) / TRACK_SEGMENT_LENGTH) + 1;
    const track = this.batch(new THREE.BoxGeometry(1, 1, 1), COLOR_DIRT_TRACK, trackTotal, false, setupCascadeMaterial, 0.94, 0);
    for (const [a, b] of edges) this.layTrack(track, map, a, b, rng);

    const posts = this.batch(new THREE.BoxGeometry(0.22, 1, 0.22), COLOR_POLE, poleTotal, true, setupCascadeMaterial);
    const crossarms = this.batch(new THREE.BoxGeometry(1, 0.14, 0.14), COLOR_POLE, poleTotal, true, setupCascadeMaterial);
    const cablePoints: number[] = [];
    for (const [a, b] of edges) this.layPoles(posts, crossarms, cablePoints, map, a, b, rng);

    this.cableGeometry = new THREE.BufferGeometry();
    this.cableGeometry.setAttribute('position', new THREE.Float32BufferAttribute(cablePoints, 3));
    this.cableMaterial = new THREE.LineBasicMaterial({ color: COLOR_CABLE });
    this.cableLines = new THREE.LineSegments(this.cableGeometry, this.cableMaterial);
    this.cableLines.frustumCulled = false;
    this.group.add(this.cableLines);

    const bales = this.batch(hayGeometry(), COLOR_HAY, hayBaleTotal, true, setupCascadeMaterial, 0.95, 0);
    this.scatterHayBales(bales, rng, map, hayBaleTotal);

    for (const batch of this.batches) {
      batch.mesh.instanceMatrix.needsUpdate = true;
      if (batch.mesh.instanceColor !== null) batch.mesh.instanceColor.needsUpdate = true;
    }
    this.shadows.finalize();
    scene.add(this.group);
  }

  private batch(
    geometry: THREE.BufferGeometry,
    color: number,
    capacity: number,
    castShadow: boolean,
    setupCascadeMaterial: (material: THREE.Material) => void,
    roughness = 0.9,
    metalness = 0,
  ): Batch {
    const material = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness, metalness });
    setupCascadeMaterial(material);
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    const result: Batch = { mesh, count: 0, baseColor: new THREE.Color(color) };
    this.batches.push(result);
    this.geometries.push(geometry);
    this.materials.push(material);
    this.group.add(mesh);
    return result;
  }

  private placeBox(
    batch: Batch,
    x: number,
    y: number,
    z: number,
    yaw: number,
    sx: number,
    sy: number,
    sz: number,
    rng: Rng,
  ): void {
    if (batch.count >= batch.mesh.instanceMatrix.count) return;
    this.scratchPosition.set(x, y, z);
    this.scratchQuaternion.setFromAxisAngle(this.scratchAxisY, yaw);
    this.scratchScale.set(sx, sy, sz);
    this.scratchMatrix.compose(this.scratchPosition, this.scratchQuaternion, this.scratchScale);
    batch.mesh.setMatrixAt(batch.count, this.scratchMatrix);
    this.scratchTint.copy(batch.baseColor).offsetHSL(
      rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.15,
      rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER) * 0.4,
      rng.range(-PROP_TINT_JITTER, PROP_TINT_JITTER),
    );
    batch.mesh.setColorAt(batch.count, this.scratchTint);
    batch.count += 1;
    batch.mesh.count = batch.count;
  }

  /** A ground-hugging strip of overlapping segments between two POIs, following terrain height. */
  private layTrack(batch: Batch, map: GameMap, a: Poi, b: Poi, rng: Rng): void {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.round(length / TRACK_SEGMENT_LENGTH));
    const angle = Math.atan2(dx, dz);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      const y = terrainHeightAt(map.hills, x, z);
      this.placeBox(batch, x, y + 0.025, z, angle, TRACK_WIDTH, 0.05, TRACK_SEGMENT_LENGTH * 1.2, rng);
    }
  }

  /** Poles at POLE_SPACING along one track, with a sagging cable to the previous pole. */
  private layPoles(
    posts: Batch,
    crossarms: Batch,
    cablePoints: number[],
    map: GameMap,
    a: Poi,
    b: Poi,
    rng: Rng,
  ): void {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    const angle = Math.atan2(dx, dz);
    const poleCount = Math.floor(length / POLE_SPACING) + 1;
    let prevTop: THREE.Vector3 | null = null;

    for (let i = 0; i <= poleCount; i++) {
      const t = Math.min(1, (i * POLE_SPACING) / Math.max(length, 1));
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      const y = terrainHeightAt(map.hills, x, z);
      this.placeBox(posts, x, y + POLE_HEIGHT / 2, z, angle, 1, POLE_HEIGHT, 1, rng);
      this.placeBox(crossarms, x, y + POLE_CROSSARM_HEIGHT, z, angle, POLE_CROSSARM_WIDTH, 1, 1, rng);
      this.shadows.add(x, y, z, 0.6);

      const top = new THREE.Vector3(x, y + POLE_CROSSARM_HEIGHT + 0.1, z);
      if (prevTop !== null) addSaggingCable(cablePoints, prevTop, top);
      prevTop = top;
      if (t >= 1) break;
    }
  }

  private scatterHayBales(batch: Batch, rng: Rng, map: GameMap, target: number): void {
    let placed = 0;
    const maxAttempts = Math.max(1, target) * 5;
    for (let attempt = 0; placed < target && attempt < maxAttempts; attempt++) {
      const x = rng.range(-MAP_HALF, MAP_HALF);
      const z = rng.range(-MAP_HALF, MAP_HALF);
      const falloff = Math.max(VEGETATION_MIN_DENSITY, 1 - nearestPoiDistance(map.pois, x, z) / VEGETATION_FALLOFF_RADIUS);
      if (!rng.bool(falloff * 0.5)) continue;
      if (Math.hypot(x, z) < SPAWN_CLEARANCE_RADIUS) continue;
      if (insideAnyBuilding(map.buildings, x, z)) continue;
      const y = terrainHeightAt(map.hills, x, z);
      this.placeBox(batch, x, y + HAY_BALE_RADIUS, z, rng.range(0, Math.PI * 2), 1, 1, 1, rng);
      this.shadows.add(x, y, z, HAY_BALE_LENGTH * 0.42);
      placed += 1;
    }
  }

  get propCount(): number {
    let total = 0;
    for (const batch of this.batches) total += batch.count;
    return total;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    for (const batch of this.batches) batch.mesh.dispose();
    this.shadows.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.cableGeometry.dispose();
    this.cableMaterial.dispose();
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

/** A simple spanning forest over the POIs: each joins the nearest POI generated before it. */
function spanningEdges(pois: readonly Poi[]): Array<[Poi, Poi]> {
  const edges: Array<[Poi, Poi]> = [];
  for (let i = 1; i < pois.length; i++) {
    let best = 0;
    let bestDist = Infinity;
    for (let j = 0; j < i; j++) {
      const d = Math.hypot(pois[i]!.x - pois[j]!.x, pois[i]!.z - pois[j]!.z);
      if (d < bestDist) {
        bestDist = d;
        best = j;
      }
    }
    edges.push([pois[i]!, pois[best]!]);
  }
  return edges;
}

/** A handful of straight sub-segments approximating a catenary sag between two pole tops. */
function addSaggingCable(out: number[], from: THREE.Vector3, to: THREE.Vector3): void {
  const steps = 6;
  let prev = from;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const sag = CABLE_SAG * 4 * t * (1 - t);
    const point = new THREE.Vector3(
      from.x + (to.x - from.x) * t,
      from.y + (to.y - from.y) * t - sag,
      from.z + (to.z - from.z) * t,
    );
    out.push(prev.x, prev.y, prev.z, point.x, point.y, point.z);
    prev = point;
  }
}

/** A round hay bale: a cylinder rotated onto its side, axis running along local X. */
function hayGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(HAY_BALE_RADIUS, HAY_BALE_RADIUS, HAY_BALE_LENGTH, 12);
  geometry.rotateZ(Math.PI / 2);
  return geometry;
}
