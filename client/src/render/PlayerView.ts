import * as THREE from 'three';
import { COLOR_ENEMY, MAX_PLAYERS, PLAYER_HEIGHT, PLAYER_RADIUS } from '@br/shared';
import type { RenderedRemote } from '../game/RemoteInterpolator.js';

const NOSE_SIZE = 0.18;

/**
 * Enemy avatars: a body box plus a nub showing which way they face.
 *
 * Instanced rather than a mesh per player, so a full lobby costs two draw calls
 * instead of forty.
 */
export class PlayerView {
  private readonly group = new THREE.Group();
  private readonly bodyGeometry = new THREE.BoxGeometry(
    PLAYER_RADIUS * 2,
    PLAYER_HEIGHT,
    PLAYER_RADIUS * 2,
  );
  private readonly noseGeometry = new THREE.BoxGeometry(NOSE_SIZE, NOSE_SIZE, NOSE_SIZE * 2);
  private readonly material = new THREE.MeshLambertMaterial({ color: COLOR_ENEMY });
  private readonly bodies: THREE.InstancedMesh;
  private readonly noses: THREE.InstancedMesh;

  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly axis = new THREE.Vector3(0, 1, 0);
  private readonly offset = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene) {
    this.bodies = this.makeMesh(this.bodyGeometry);
    this.noses = this.makeMesh(this.noseGeometry);
    scene.add(this.group);
  }

  private makeMesh(geometry: THREE.BufferGeometry): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, this.material, MAX_PLAYERS);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.group.add(mesh);
    return mesh;
  }

  update(remotes: Map<number, RenderedRemote>): void {
    let count = 0;
    for (const remote of remotes.values()) {
      // Eliminated players stay in the snapshot so the scoreboard and spectator
      // camera still know about them, but they leave the world.
      if (!remote.alive || count >= MAX_PLAYERS) continue;

      this.quaternion.setFromAxisAngle(this.axis, remote.yaw);

      this.position.set(remote.x, remote.y + PLAYER_HEIGHT / 2, remote.z);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.bodies.setMatrixAt(count, this.matrix);

      // The nub sits in front of the head, rotated with the body.
      this.offset.set(0, PLAYER_HEIGHT * 0.85, -PLAYER_RADIUS - NOSE_SIZE).applyQuaternion(this.quaternion);
      this.position.set(remote.x + this.offset.x, remote.y + this.offset.y, remote.z + this.offset.z);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.noses.setMatrixAt(count, this.matrix);

      count += 1;
    }

    this.bodies.count = count;
    this.noses.count = count;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.noses.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.bodies.dispose();
    this.noses.dispose();
    this.bodyGeometry.dispose();
    this.noseGeometry.dispose();
    this.material.dispose();
  }
}
