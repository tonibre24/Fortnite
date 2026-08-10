import * as THREE from 'three';
import type { GameMap, MapBox } from '@br/shared';

/**
 * Draws the map. Boxes are grouped by colour into one InstancedMesh each, so a
 * few thousand primitives cost a handful of draw calls instead of a few
 * thousand.
 */
export class WorldView {
  private readonly group = new THREE.Group();
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);

  constructor(scene: THREE.Scene, map: GameMap) {
    const byColor = new Map<number, MapBox[]>();
    for (const box of map.boxes) {
      const bucket = byColor.get(box.color);
      if (bucket === undefined) byColor.set(box.color, [box]);
      else bucket.push(box);
    }

    const matrix = new THREE.Matrix4();
    for (const [color, boxes] of byColor) {
      const material = new THREE.MeshLambertMaterial({ color });
      const mesh = new THREE.InstancedMesh(this.geometry, material, boxes.length);
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!;
        matrix.makeScale(
          Math.max(b.maxX - b.minX, Number.EPSILON),
          Math.max(b.maxY - b.minY, Number.EPSILON),
          Math.max(b.maxZ - b.minZ, Number.EPSILON),
        );
        matrix.setPosition((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    scene.add(this.group);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    for (const child of this.group.children) {
      if (child instanceof THREE.InstancedMesh) {
        child.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    this.geometry.dispose();
  }
}
