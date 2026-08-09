import * as THREE from 'three';
import {
  CHEST_HEIGHT,
  CHEST_SIZE,
  ItemKind,
  LOOT_BOB_HEIGHT,
  LOOT_SIZE,
  RARITY_COLORS,
  type LootItem,
} from '@br/shared';

const CHEST_COLOR = 0xd8a83a;
const BOB_SPEED = 0.0022;
const SPIN_SPEED = 0.0011;

/**
 * Ground loot. Items are small spinning cubes tinted by rarity - the only way
 * to tell a legendary from a common at a distance - and chests are bigger,
 * still boxes.
 */
export class LootView {
  private readonly group = new THREE.Group();
  private readonly meshes = new Map<number, THREE.Mesh>();
  private readonly itemGeometry = new THREE.BoxGeometry(LOOT_SIZE, LOOT_SIZE, LOOT_SIZE);
  private readonly chestGeometry = new THREE.BoxGeometry(CHEST_SIZE, CHEST_HEIGHT, CHEST_SIZE);
  private readonly materials = new Map<number, THREE.MeshLambertMaterial>();

  constructor(private readonly scene: THREE.Scene) {
    scene.add(this.group);
  }

  private materialFor(color: number): THREE.MeshLambertMaterial {
    let material = this.materials.get(color);
    if (material === undefined) {
      material = new THREE.MeshLambertMaterial({ color });
      this.materials.set(color, material);
    }
    return material;
  }

  update(loot: ReadonlyMap<number, LootItem>, now: number): void {
    for (const [id, mesh] of this.meshes) {
      if (loot.has(id)) continue;
      this.group.remove(mesh);
      this.meshes.delete(id);
    }

    for (const [id, item] of loot) {
      let mesh = this.meshes.get(id);
      if (mesh === undefined) {
        const chest = item.kind === ItemKind.Chest;
        mesh = new THREE.Mesh(
          chest ? this.chestGeometry : this.itemGeometry,
          this.materialFor(chest ? CHEST_COLOR : (RARITY_COLORS[item.rarity] ?? RARITY_COLORS[0])),
        );
        this.group.add(mesh);
        this.meshes.set(id, mesh);
      }

      if (item.kind === ItemKind.Chest) {
        mesh.position.set(item.x, item.y + CHEST_HEIGHT / 2, item.z);
        continue;
      }
      // A little motion makes loose loot readable against flat-coloured ground.
      const phase = now * BOB_SPEED + id;
      mesh.position.set(
        item.x,
        item.y + LOOT_SIZE + Math.sin(phase) * LOOT_BOB_HEIGHT,
        item.z,
      );
      mesh.rotation.y = now * SPIN_SPEED + id;
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.itemGeometry.dispose();
    this.chestGeometry.dispose();
    for (const material of this.materials.values()) material.dispose();
  }
}
