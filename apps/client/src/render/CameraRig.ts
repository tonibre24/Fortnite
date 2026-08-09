import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import type { Scene } from '@babylonjs/core/scene';
import {
  CAMERA_COLLISION_PADDING,
  CAMERA_DISTANCE,
  CAMERA_DISTANCE_AIMING,
  CAMERA_HEIGHT,
  CAMERA_SHOULDER_OFFSET,
  PLAYER_EYE_HEIGHT,
  clamp,
  directionFromAngles,
  type ColliderIndex,
  type Vec3,
} from '@riftfront/shared';

/**
 * Over-the-shoulder third-person camera.
 *
 * The camera is positioned manually every frame rather than parented to the player, so
 * it can be pulled in when geometry would otherwise clip through it. Wall avoidance
 * raycasts from the player's head to the desired camera position using the same shared
 * collider index the simulation uses, which means the camera and the bullets agree about
 * where the walls are.
 */

export interface CameraTarget {
  position: Vec3;
  yaw: number;
  pitch: number;
  aiming: boolean;
}

export class CameraRig {
  readonly camera: FreeCamera;

  private currentDistance = CAMERA_DISTANCE;
  private currentShoulder = CAMERA_SHOULDER_OFFSET;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private shakeMagnitude = 0;
  private shakeTime = 0;

  private readonly anchor = new Vector3();
  private readonly desired = new Vector3();
  /** Scratch for the look-at point; `update` runs every frame and must not allocate. */
  private readonly lookAt = new Vector3();

  constructor(
    scene: Scene,
    private readonly colliders: ColliderIndex,
  ) {
    this.camera = new FreeCamera('player-camera', new Vector3(0, 4, -8), scene);
    this.camera.minZ = 0.12;
    this.camera.maxZ = 260;
    this.camera.fov = 1.12;
    // All movement is driven by the game; Babylon's built-in controls stay off.
    this.camera.inputs.clear();
    scene.activeCamera = this.camera;
  }

  /** Adds a short recoil kick to the *camera only*; aim recoil is applied to input. */
  addRecoilKick(vertical: number, horizontal: number): void {
    this.recoilPitch += vertical;
    this.recoilYaw += horizontal;
  }

  /** Brief shake, e.g. when the local player takes damage. */
  addShake(magnitude: number): void {
    this.shakeMagnitude = Math.min(0.35, this.shakeMagnitude + magnitude);
  }

  /** Field of view narrows slightly while aiming for a subtle zoom. */
  private targetFov(aiming: boolean): number {
    return aiming ? 0.92 : 1.12;
  }

  update(target: CameraTarget, dtSeconds: number): void {
    // Recoil and shake decay exponentially, framerate-independently.
    const decay = Math.exp(-dtSeconds * 9);
    this.recoilPitch *= decay;
    this.recoilYaw *= decay;
    this.shakeMagnitude *= Math.exp(-dtSeconds * 7);
    this.shakeTime += dtSeconds;

    const wantedDistance = target.aiming ? CAMERA_DISTANCE_AIMING : CAMERA_DISTANCE;
    const wantedShoulder = target.aiming ? CAMERA_SHOULDER_OFFSET * 0.55 : CAMERA_SHOULDER_OFFSET;
    const blend = 1 - Math.exp(-dtSeconds * 12);
    this.currentDistance += (wantedDistance - this.currentDistance) * blend;
    this.currentShoulder += (wantedShoulder - this.currentShoulder) * blend;
    this.camera.fov += (this.targetFov(target.aiming) - this.camera.fov) * blend;

    const yaw = target.yaw + this.recoilYaw;
    const pitch = target.pitch - this.recoilPitch;

    // Anchor sits at the player's head; the camera orbits behind it.
    this.anchor.set(target.position.x, target.position.y + CAMERA_HEIGHT, target.position.z);

    const forward = directionFromAngles(yaw, pitch);
    // Right vector for the shoulder offset (yaw only, so the offset stays horizontal).
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    this.desired.set(
      this.anchor.x - forward.x * this.currentDistance + rightX * this.currentShoulder,
      this.anchor.y - forward.y * this.currentDistance,
      this.anchor.z - forward.z * this.currentDistance + rightZ * this.currentShoulder,
    );

    this.applyWallAvoidance();
    this.applyShake();

    this.camera.position.copyFrom(this.desired);
    this.lookAt.set(
      this.anchor.x + forward.x * 12 + rightX * this.currentShoulder,
      this.anchor.y + forward.y * 12,
      this.anchor.z + forward.z * 12 + rightZ * this.currentShoulder,
    );
    this.camera.setTarget(this.lookAt);
  }

  /** Pulls the camera in front of any geometry between the head and the desired spot. */
  private applyWallAvoidance(): void {
    const toCamera = {
      x: this.desired.x - this.anchor.x,
      y: this.desired.y - this.anchor.y,
      z: this.desired.z - this.anchor.z,
    };
    const distance = Math.hypot(toCamera.x, toCamera.y, toCamera.z);
    if (distance < 0.05) return;

    const direction = {
      x: toCamera.x / distance,
      y: toCamera.y / distance,
      z: toCamera.z / distance,
    };
    const anchorVec: Vec3 = { x: this.anchor.x, y: this.anchor.y, z: this.anchor.z };
    const hit = this.colliders.raycast(anchorVec, direction, distance + CAMERA_COLLISION_PADDING);
    if (!hit) return;

    const safe = clamp(hit.distance - CAMERA_COLLISION_PADDING, 0.35, distance);
    this.desired.set(
      this.anchor.x + direction.x * safe,
      this.anchor.y + direction.y * safe,
      this.anchor.z + direction.z * safe,
    );
  }

  private applyShake(): void {
    if (this.shakeMagnitude < 0.001) return;
    const t = this.shakeTime * 47;
    this.desired.x += Math.sin(t) * this.shakeMagnitude;
    this.desired.y += Math.sin(t * 1.7 + 1.1) * this.shakeMagnitude * 0.7;
    this.desired.z += Math.cos(t * 1.3) * this.shakeMagnitude;
  }

  /**
   * The crosshair ray.
   *
   * Because the camera sits over the shoulder, its own forward axis does not pass through
   * the player's weapon. Firing along it would make shots land beside the crosshair at
   * close range — one of the classic third-person shooter bugs.
   *
   * Instead the crosshair's world target is found by raycasting from the camera along its
   * view axis, and the shot direction is computed from the player's eye towards that
   * point. Shots therefore always converge on what the crosshair covers, while still
   * originating from the eye position the server simulates.
   */
  getAimRay(target: CameraTarget, maxDistance: number): { origin: Vec3; direction: Vec3 } {
    const origin: Vec3 = {
      x: target.position.x,
      y: target.position.y + PLAYER_EYE_HEIGHT,
      z: target.position.z,
    };

    const viewAxis = directionFromAngles(
      target.yaw + this.recoilYaw,
      target.pitch - this.recoilPitch,
    );
    const cameraPosition: Vec3 = {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
    };

    const hit = this.colliders.raycast(cameraPosition, viewAxis, maxDistance);
    const reach = hit ? hit.distance : maxDistance;
    // Never converge closer than the player themselves, or the ray inverts.
    const convergence = Math.max(reach, this.currentDistance + 1.5);

    const crosshairPoint: Vec3 = {
      x: cameraPosition.x + viewAxis.x * convergence,
      y: cameraPosition.y + viewAxis.y * convergence,
      z: cameraPosition.z + viewAxis.z * convergence,
    };

    const delta = {
      x: crosshairPoint.x - origin.x,
      y: crosshairPoint.y - origin.y,
      z: crosshairPoint.z - origin.z,
    };
    const length = Math.hypot(delta.x, delta.y, delta.z);
    if (length < 1e-5) {
      return { origin, direction: viewAxis };
    }

    return {
      origin,
      direction: { x: delta.x / length, y: delta.y / length, z: delta.z / length },
    };
  }

  dispose(): void {
    this.camera.dispose();
  }
}
