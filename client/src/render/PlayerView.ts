import * as THREE from 'three';
import {
  COLOR_ENEMY,
  MAX_PLAYERS,
  MoveMode,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SPRINT_SPEED,
  WALK_SPEED,
} from '@br/shared';
import type { RenderedRemote } from '../game/RemoteInterpolator.js';

/**
 * Enemy avatars: simple articulated figures rather than capsules.
 *
 * Six parts - torso, head, two arms, two legs - each its own InstancedMesh, so
 * a full lobby is six draw calls no matter how many players are on screen. The
 * pose is computed per player from the movement state the client already
 * interpolates; there is no skinning, no skeleton and no animation library,
 * just a transform per part.
 *
 * The gait is driven by a phase accumulated from distance travelled rather than
 * from wall-clock time, so legs move in step with actual motion and a player
 * standing still has still legs, for free.
 */

/** Proportions, as fractions of PLAYER_HEIGHT. */
const TORSO_HEIGHT = 0.42;
const TORSO_WIDTH = 0.52;
const HEAD_SIZE = 0.2;
const LIMB_LENGTH = 0.38;
const LIMB_THICK = 0.15;

interface Part {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
}

/** Per-player gait state, kept between frames. Never allocated in the loop. */
interface Gait {
  phase: number;
  lastX: number;
  lastZ: number;
  seen: boolean;
}

export class PlayerView {
  private readonly group = new THREE.Group();
  private readonly material: THREE.MeshLambertMaterial;
  private readonly parts: Part[] = [];
  private readonly torso: Part;
  private readonly head: Part;
  private readonly armL: Part;
  private readonly armR: Part;
  private readonly legL: Part;
  private readonly legR: Part;
  private readonly gaits = new Map<number, Gait>();

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly limbQuat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly euler = new THREE.Euler();
  private readonly offset = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly scene: THREE.Scene) {
    this.material = new THREE.MeshLambertMaterial({ color: COLOR_ENEMY, flatShading: true });

    const h = PLAYER_HEIGHT;
    this.torso = this.part(
      new THREE.BoxGeometry(PLAYER_RADIUS * 2 * TORSO_WIDTH * 2, h * TORSO_HEIGHT, PLAYER_RADIUS * 1.1),
    );
    this.head = this.part(new THREE.BoxGeometry(h * HEAD_SIZE, h * HEAD_SIZE, h * HEAD_SIZE));
    // Limbs are modelled hanging from the origin, so rotating about the origin
    // swings them from the shoulder or hip without an extra pivot transform.
    const limb = (): THREE.BoxGeometry => {
      const geometry = new THREE.BoxGeometry(h * LIMB_THICK, h * LIMB_LENGTH, h * LIMB_THICK);
      geometry.translate(0, -h * LIMB_LENGTH * 0.5, 0);
      return geometry;
    };
    this.armL = this.part(limb());
    this.armR = this.part(limb());
    this.legL = this.part(limb());
    this.legR = this.part(limb());

    scene.add(this.group);
  }

  private part(geometry: THREE.BufferGeometry): Part {
    const mesh = new THREE.InstancedMesh(geometry, this.material, MAX_PLAYERS);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    this.group.add(mesh);
    const result: Part = { mesh, geometry };
    this.parts.push(result);
    return result;
  }

  /** Writes one part's transform, in the player's local frame. */
  private write(
    part: Part,
    index: number,
    baseX: number,
    baseY: number,
    baseZ: number,
    yaw: number,
    localX: number,
    localY: number,
    localZ: number,
    pitch: number,
    roll: number,
  ): void {
    this.quaternion.setFromAxisAngle(this.up, yaw);
    this.offset.set(localX, localY, localZ).applyQuaternion(this.quaternion);
    this.position.set(baseX + this.offset.x, baseY + this.offset.y, baseZ + this.offset.z);
    this.euler.set(pitch, yaw, roll, 'YXZ');
    this.limbQuat.setFromEuler(this.euler);
    this.matrix.compose(this.position, this.limbQuat, this.scale);
    part.mesh.setMatrixAt(index, this.matrix);
  }

  update(remotes: ReadonlyMap<number, RenderedRemote>, dt: number): void {
    let count = 0;
    for (const gait of this.gaits.values()) gait.seen = false;

    const h = PLAYER_HEIGHT;
    for (const remote of remotes.values()) {
      // Eliminated players stay in the snapshot so the scoreboard and spectator
      // camera still know about them, but they leave the world.
      if (!remote.alive || count >= MAX_PLAYERS) continue;

      let gait = this.gaits.get(remote.id);
      if (gait === undefined) {
        gait = { phase: 0, lastX: remote.x, lastZ: remote.z, seen: true };
        this.gaits.set(remote.id, gait);
      }
      gait.seen = true;

      const dx = remote.x - gait.lastX;
      const dz = remote.z - gait.lastZ;
      const travelled = Math.hypot(dx, dz);
      gait.lastX = remote.x;
      gait.lastZ = remote.z;
      const speed = dt > 0 ? travelled / dt : 0;
      // A teleport must not spin the legs; anything faster than sprinting is
      // one of those rather than running.
      if (speed < SPRINT_SPEED * 2) gait.phase += travelled * 2.4;

      const yaw = remote.yaw;
      const grounded = remote.onGround;
      const running = speed > WALK_SPEED * 0.55;
      const swing = grounded ? Math.sin(gait.phase) * (running ? 0.95 : 0.55) : 0;
      const counter = grounded ? -swing : 0;

      // Pose per movement mode. Freefall is a spread star; gliding is arms out
      // and legs together, which reads instantly at a distance.
      let armBase = 0;
      let legBase = 0;
      let armSpread = 0.1;
      let lean = 0;
      if (!grounded) {
        const mode = remoteMode(remote);
        if (mode === MoveMode.Glide) {
          armBase = -1.45;
          armSpread = 1.15;
          legBase = 0.18;
          lean = 0.25;
        } else {
          armBase = -2.1;
          armSpread = 0.75;
          legBase = -0.5;
          lean = 0.1;
        }
      } else if (running) {
        lean = 0.16;
      }

      const baseY = remote.y;
      const hipY = h * 0.46;
      const shoulderY = h * 0.82;

      this.write(this.torso, count, remote.x, baseY, remote.z, yaw, 0, h * 0.62, 0, lean, 0);
      this.write(this.head, count, remote.x, baseY, remote.z, yaw, 0, h * 0.92, 0, lean * 0.5, 0);
      this.write(this.armL, count, remote.x, baseY, remote.z, yaw, -h * 0.19, shoulderY, 0, armBase + counter, -armSpread);
      this.write(this.armR, count, remote.x, baseY, remote.z, yaw, h * 0.19, shoulderY, 0, armBase + swing, armSpread);
      this.write(this.legL, count, remote.x, baseY, remote.z, yaw, -h * 0.1, hipY, 0, legBase + swing, 0);
      this.write(this.legR, count, remote.x, baseY, remote.z, yaw, h * 0.1, hipY, 0, legBase + counter, 0);

      count += 1;
    }

    for (const part of this.parts) {
      part.mesh.count = count;
      part.mesh.instanceMatrix.needsUpdate = true;
    }

    // Drop gait state for anyone who left, or the map grows across a session.
    for (const [id, gait] of this.gaits) {
      if (!gait.seen) this.gaits.delete(id);
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const part of this.parts) {
      part.mesh.dispose();
      part.geometry.dispose();
    }
    this.material.dispose();
  }
}

/**
 * Remotes carry no move mode on the wire, so it is inferred: a player well
 * above the ground and descending slowly is gliding, otherwise falling. Only
 * the pose depends on this, so a wrong guess costs nothing but a frame of the
 * other animation.
 */
function remoteMode(remote: RenderedRemote): number {
  return remote.y > 0.5 ? MoveMode.Glide : MoveMode.Freefall;
}
