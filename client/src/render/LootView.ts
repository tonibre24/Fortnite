import * as THREE from 'three';
import {
  CHEST_HEIGHT,
  CHEST_SIZE,
  ItemKind,
  LOOT_BOB_HEIGHT,
  LOOT_SIZE,
  MAX_PLAYERS,
  RARITY_COLORS,
  RARITY_COUNT,
  type LootItem,
} from '@br/shared';

const CHEST_COLOR = 0xd8a83a;
const BOB_SPEED = 0.0022;
const SPIN_SPEED = 0.0011;

/**
 * Ground loot: small spinning cubes tinted by rarity - the only way to tell a
 * legendary from a common at a distance - and larger boxes for chests.
 *
 * One InstancedMesh per rarity rather than one mesh per item. A fresh map holds
 * a couple of hundred items and every player drops their inventory when they
 * die, so the naive version was several hundred draw calls on its own.
 */
export class LootView {
  private readonly group = new THREE.Group();
  private readonly itemGeometry = new THREE.BoxGeometry(LOOT_SIZE, LOOT_SIZE, LOOT_SIZE);
  private readonly chestGeometry = new THREE.BoxGeometry(CHEST_SIZE, CHEST_HEIGHT, CHEST_SIZE);
  /** One bucket per rarity, plus a final bucket for chests. */
  private readonly buckets: THREE.InstancedMesh[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly axis = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly scene: THREE.Scene,
    capacity = LootView.defaultCapacity(),
  ) {
    for (let bucket = 0; bucket <= RARITY_COUNT; bucket++) {
      const chest = bucket === RARITY_COUNT;
      const mesh = new THREE.InstancedMesh(
        chest ? this.chestGeometry : this.itemGeometry,
        new THREE.MeshLambertMaterial({ color: chest ? CHEST_COLOR : RARITY_COLORS[bucket] }),
        capacity,
      );
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.buckets.push(mesh);
      this.group.add(mesh);
    }
    scene.add(this.group);
  }

  /** Enough room for a full map of loot plus everything twenty players carry. */
  private static defaultCapacity(): number {
    return 512 + MAX_PLAYERS * 8;
  }

  update(loot: ReadonlyMap<number, LootItem>, now: number): void {
    for (const mesh of this.buckets) mesh.count = 0;

    for (const [id, item] of loot) {
      const chest = item.kind === ItemKind.Chest;
      const bucket = this.buckets[chest ? RARITY_COUNT : Math.min(item.rarity, RARITY_COUNT - 1)]!;
      if (bucket.count >= bucket.instanceMatrix.count) continue;

      if (chest) {
        this.position.set(item.x, item.y + CHEST_HEIGHT / 2, item.z);
        this.quaternion.identity();
      } else {
        // A little motion makes loose loot readable against flat-coloured ground.
        const phase = now * BOB_SPEED + id;
        this.position.set(item.x, item.y + LOOT_SIZE + Math.sin(phase) * LOOT_BOB_HEIGHT, item.z);
        this.quaternion.setFromAxisAngle(this.axis, now * SPIN_SPEED + id);
      }
      this.matrix.compose(this.position, this.quaternion, this.scale);
      bucket.setMatrixAt(bucket.count, this.matrix);
      bucket.count += 1;
    }

    for (const mesh of this.buckets) mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.itemGeometry.dispose();
    this.chestGeometry.dispose();
    for (const mesh of this.buckets) {
      mesh.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
