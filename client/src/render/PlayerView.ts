import * as THREE from 'three';
import { COLOR_ENEMY, PLAYER_HEIGHT, PLAYER_RADIUS } from '@br/shared';
import type { RenderedRemote } from '../game/RemoteInterpolator.js';

const NOSE_SIZE = 0.18;

/** Pool of enemy avatars: a body box plus a nub that shows which way they face. */
export class PlayerView {
  private readonly group = new THREE.Group();
  private readonly avatars = new Map<number, THREE.Group>();
  private readonly bodyGeometry = new THREE.BoxGeometry(
    PLAYER_RADIUS * 2,
    PLAYER_HEIGHT,
    PLAYER_RADIUS * 2,
  );
  private readonly noseGeometry = new THREE.BoxGeometry(NOSE_SIZE, NOSE_SIZE, NOSE_SIZE * 2);
  private readonly material = new THREE.MeshLambertMaterial({ color: COLOR_ENEMY });

  constructor(private readonly scene: THREE.Scene) {
    scene.add(this.group);
  }

  update(remotes: Map<number, RenderedRemote>): void {
    for (const [id, avatar] of this.avatars) {
      if (!remotes.has(id)) {
        this.group.remove(avatar);
        this.avatars.delete(id);
      }
    }

    for (const [id, remote] of remotes) {
      let avatar = this.avatars.get(id);
      if (avatar === undefined) {
        avatar = new THREE.Group();
        const body = new THREE.Mesh(this.bodyGeometry, this.material);
        body.position.y = PLAYER_HEIGHT / 2;
        const nose = new THREE.Mesh(this.noseGeometry, this.material);
        nose.position.set(0, PLAYER_HEIGHT * 0.85, -PLAYER_RADIUS - NOSE_SIZE);
        avatar.add(body, nose);
        this.group.add(avatar);
        this.avatars.set(id, avatar);
      }
      avatar.position.set(remote.x, remote.y, remote.z);
      avatar.rotation.y = remote.yaw;
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.bodyGeometry.dispose();
    this.noseGeometry.dispose();
    this.material.dispose();
  }
}
