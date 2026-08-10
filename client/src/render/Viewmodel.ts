import * as THREE from 'three';
import {
  ADS_FOV,
  ADS_POSE_EASE_SPEED,
  BASE_FOV,
  BOB_SPRINT_AMOUNT,
  BOB_SPRINT_CYCLE_SPEED,
  BOB_WALK_AMOUNT,
  BOB_WALK_CYCLE_SPEED,
  BREATH_AMOUNT,
  BREATH_CYCLE_SPEED,
  FOV_EASE_SPEED,
  LANDING_DIP_AMOUNT,
  LANDING_DIP_RECOVERY_SPEED,
  RECOIL_PITCH_KICK,
  RECOIL_POSITION_KICK,
  RECOIL_RECOVERY_SPEED,
  RELOAD_DIP_AMOUNT,
  SPRINT_LOWER_OFFSET_Y,
  SPRINT_LOWER_OFFSET_Z,
  SPRINT_TILT,
  StateFlag,
  SWAY_AMOUNT,
  SWAY_EASE_SPEED,
  SWAY_PITCH_AMOUNT,
  VIEWMODEL_FAR,
  VIEWMODEL_FOV,
  VIEWMODEL_LAYER,
  VIEWMODEL_NEAR,
  WeaponClass,
  clamp,
  dequantizePitch,
  dequantizeYaw,
  type PlayerState,
} from '@br/shared';

/** Hip (non-aiming) rest pose, in the viewmodel's own camera-relative local space. */
const HIP_X = 0.28;
const HIP_Y = -0.26;
const HIP_Z = -0.6;
/** Sighted pose: centred and pulled up close to the eye line. */
const ADS_X = 0;
const ADS_Y = -0.06;
const ADS_Z = -0.34;

interface WeaponShape {
  bodyLen: number;
  bodyHeight: number;
  barrelLen: number;
  barrelRadius: number;
  magLen: number;
  hasStock: boolean;
}

const WEAPON_SHAPES: Record<number, WeaponShape> = {
  [WeaponClass.Pistol]: { bodyLen: 0.22, bodyHeight: 0.14, barrelLen: 0.12, barrelRadius: 0.028, magLen: 0.14, hasStock: false },
  [WeaponClass.Smg]: { bodyLen: 0.3, bodyHeight: 0.13, barrelLen: 0.22, barrelRadius: 0.026, magLen: 0.22, hasStock: true },
  [WeaponClass.Rifle]: { bodyLen: 0.4, bodyHeight: 0.13, barrelLen: 0.34, barrelRadius: 0.024, magLen: 0.2, hasStock: true },
  [WeaponClass.Shotgun]: { bodyLen: 0.34, bodyHeight: 0.16, barrelLen: 0.3, barrelRadius: 0.034, magLen: 0.16, hasStock: false },
};

/** Framerate-independent exponential ease toward a target. */
function approach(current: number, target: number, speed: number, dt: number): number {
  const t = 1 - Math.exp(-speed * dt);
  return current + (target - current) * t;
}

function setLayer(object: THREE.Object3D, layer: number): void {
  object.traverse((child) => child.layers.set(layer));
}

/**
 * The first-person weapon: visible arms holding a gun whose proportions
 * change per weapon class, drawn on its own camera and layer so its own near
 * plane - not the world's - decides when it clips, which is what keeps it
 * from poking through a wall the player is standing close to.
 *
 * Also owns the camera-feel added on top of the world camera each frame
 * (recoil kick, breathing, landing dip). Both read the same player state and
 * both are pure rendering - nothing here ever touches input, prediction or
 * the aim the server validates, only how the already-resolved state and
 * events are presented.
 */
export class Viewmodel {
  readonly camera: THREE.PerspectiveCamera;
  private readonly group = new THREE.Group();
  private readonly armMaterial: THREE.MeshStandardMaterial;
  private readonly gunMaterial: THREE.MeshStandardMaterial;
  private readonly gunGroup = new THREE.Group();
  private readonly leftArm: THREE.Mesh;
  private readonly rightArm: THREE.Mesh;
  private readonly armGeometry = new THREE.BoxGeometry(0.09, 0.09, 0.55);
  private builtClass = -1;

  private currentFov = BASE_FOV;
  private poseX = HIP_X;
  private poseY = HIP_Y;
  private poseZ = HIP_Z;
  private poseRoll = 0;
  private swayYaw = 0;
  private swayPitch = 0;
  private breathPhase = 0;
  private walkPhase = 0;
  private moveBlend = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private haveLastLook = false;

  private reloadPeakTicks = 0;
  private wasReloading = false;

  private recoilPitch = 0;
  private recoilPos = 0;
  private landingDip = 0;
  private wasOnGround = true;
  private haveGroundState = false;

  constructor(scene: THREE.Scene, setupCascadeMaterial: (material: THREE.Material) => void) {
    this.camera = new THREE.PerspectiveCamera(VIEWMODEL_FOV, 1, VIEWMODEL_NEAR, VIEWMODEL_FAR);
    this.camera.layers.set(VIEWMODEL_LAYER);

    this.armMaterial = new THREE.MeshStandardMaterial({ color: 0xcf9a72, roughness: 0.75, metalness: 0 });
    this.gunMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.4, metalness: 0.65 });
    setupCascadeMaterial(this.armMaterial);
    setupCascadeMaterial(this.gunMaterial);

    this.leftArm = new THREE.Mesh(this.armGeometry, this.armMaterial);
    this.rightArm = new THREE.Mesh(this.armGeometry, this.armMaterial);
    this.leftArm.position.set(-0.16, -0.14, -0.15);
    this.rightArm.position.set(0.16, -0.14, -0.15);
    for (const arm of [this.leftArm, this.rightArm]) {
      arm.castShadow = false;
      arm.receiveShadow = false;
    }

    this.group.add(this.leftArm, this.rightArm, this.gunGroup);
    setLayer(this.group, VIEWMODEL_LAYER);
    // Hidden until the first setVisible(true) - otherwise it sits at the
    // origin, un-positioned, for however many frames pass before the client
    // is ready and updateWeapon() first runs.
    this.group.visible = false;
    scene.add(this.group);

    this.buildWeapon(WeaponClass.Pistol);
  }

  /** Swaps the gun mesh's proportions when the equipped class changes; a no-op otherwise. */
  private buildWeapon(cls: number): void {
    if (cls === this.builtClass) return;
    this.builtClass = cls;

    for (const child of this.gunGroup.children.slice()) {
      this.gunGroup.remove(child);
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }

    const shape = WEAPON_SHAPES[cls] ?? WEAPON_SHAPES[WeaponClass.Pistol]!;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, shape.bodyHeight, shape.bodyLen), this.gunMaterial);
    body.position.set(0, 0, -shape.bodyLen / 2);
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(shape.barrelRadius, shape.barrelRadius, shape.barrelLen, 8),
      this.gunMaterial,
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, shape.bodyHeight * 0.15, -shape.bodyLen - shape.barrelLen / 2);
    const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.06, shape.magLen, 0.08), this.gunMaterial);
    magazine.position.set(0, -shape.bodyHeight / 2 - shape.magLen / 2, -shape.bodyLen * 0.35);

    // Front and rear sight posts. The body and barrel both foreshorten to
    // almost nothing dead-on, which is exactly the view ADS centres on -
    // without these there would be nothing left to aim with once sighted.
    const rearSight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.045, 0.02), this.gunMaterial);
    rearSight.position.set(0, shape.bodyHeight / 2 + 0.02, -0.03);
    const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.05, 0.015), this.gunMaterial);
    frontSight.position.set(0, shape.bodyHeight / 2 + 0.022, -shape.bodyLen - shape.barrelLen * 0.85);

    this.gunGroup.add(body, barrel, magazine, rearSight, frontSight);

    if (shape.hasStock) {
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, shape.bodyHeight * 0.7, 0.22), this.gunMaterial);
      stock.position.set(0, -0.01, 0.11);
      this.gunGroup.add(stock);
    }

    for (const child of this.gunGroup.children) {
      if (child instanceof THREE.Mesh) {
        child.castShadow = false;
        child.receiveShadow = false;
      }
    }
    setLayer(this.gunGroup, VIEWMODEL_LAYER);
  }

  /** A shot the local player fired - a purely visual kick, decaying back to zero on its own. */
  triggerRecoil(): void {
    this.recoilPitch += RECOIL_PITCH_KICK;
    this.recoilPos += RECOIL_POSITION_KICK;
  }

  /** Hides the arms/weapon - riding the bus, spectating, anywhere there is nothing to hold. */
  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /**
   * Adds recoil recovery, idle breathing and a landing dip to the world
   * camera the rest of the frame already placed. Call after updateCamera()
   * has set the "real" position/rotation from state, and before rendering.
   */
  updateCameraFeel(worldCamera: THREE.PerspectiveCamera, state: PlayerState, dt: number): void {
    const onGround = (state.flags & StateFlag.OnGround) !== 0;
    if (this.haveGroundState && onGround && !this.wasOnGround) this.landingDip = LANDING_DIP_AMOUNT;
    this.wasOnGround = onGround;
    this.haveGroundState = true;

    this.recoilPitch = approach(this.recoilPitch, 0, RECOIL_RECOVERY_SPEED, dt);
    this.landingDip = approach(this.landingDip, 0, LANDING_DIP_RECOVERY_SPEED, dt);
    this.breathPhase += dt * BREATH_CYCLE_SPEED;
    const breathY = Math.sin(this.breathPhase) * BREATH_AMOUNT;

    worldCamera.rotation.x -= this.recoilPitch;
    worldCamera.position.y += breathY - this.landingDip;
  }

  /**
   * Positions the gun relative to wherever the (already camera-felt) world
   * camera ended up this frame, eases the ADS pose and FOV, and keeps the
   * viewmodel's own camera locked to the world one but for its fixed FOV.
   */
  updateWeapon(
    worldCamera: THREE.PerspectiveCamera,
    state: PlayerState,
    weaponCls: number,
    aiming: boolean,
    moving: boolean,
    dt: number,
  ): void {
    this.buildWeapon(weaponCls);

    const sprinting = (state.flags & StateFlag.Sprinting) !== 0 && !aiming;
    const onGround = (state.flags & StateFlag.OnGround) !== 0;

    const targetFov = aiming ? ADS_FOV : BASE_FOV;
    this.currentFov = approach(this.currentFov, targetFov, FOV_EASE_SPEED, dt);
    if (Math.abs(worldCamera.fov - this.currentFov) > 0.001) {
      worldCamera.fov = this.currentFov;
      worldCamera.updateProjectionMatrix();
    }

    let targetX = HIP_X;
    let targetY = HIP_Y;
    let targetZ = HIP_Z;
    let targetRoll = 0;
    if (aiming) {
      targetX = ADS_X;
      targetY = ADS_Y;
      targetZ = ADS_Z;
    } else if (sprinting) {
      targetY = HIP_Y + SPRINT_LOWER_OFFSET_Y;
      targetZ = HIP_Z + SPRINT_LOWER_OFFSET_Z;
      targetRoll = SPRINT_TILT;
    }
    this.poseX = approach(this.poseX, targetX, ADS_POSE_EASE_SPEED, dt);
    this.poseY = approach(this.poseY, targetY, ADS_POSE_EASE_SPEED, dt);
    this.poseZ = approach(this.poseZ, targetZ, ADS_POSE_EASE_SPEED, dt);
    this.poseRoll = approach(this.poseRoll, targetRoll, ADS_POSE_EASE_SPEED, dt);

    // Sway lags behind a fast look-around rather than tracking it instantly -
    // the weapon reads as loosely held, not welded to the crosshair.
    const yaw = dequantizeYaw(state.yawQ);
    const pitch = dequantizePitch(state.pitchQ);
    if (this.haveLastLook) {
      let dyaw = yaw - this.lastYaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const dpitch = pitch - this.lastPitch;
      const targetSwayYaw = clamp(-dyaw * 3, -SWAY_AMOUNT, SWAY_AMOUNT);
      const targetSwayPitch = clamp(-dpitch * 3, -SWAY_PITCH_AMOUNT, SWAY_PITCH_AMOUNT);
      this.swayYaw = approach(this.swayYaw, targetSwayYaw, SWAY_EASE_SPEED, dt);
      this.swayPitch = approach(this.swayPitch, targetSwayPitch, SWAY_EASE_SPEED, dt);
    }
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    this.haveLastLook = true;

    const targetMoveBlend = moving && onGround && !aiming ? 1 : 0;
    this.moveBlend = approach(this.moveBlend, targetMoveBlend, 8, dt);
    if (targetMoveBlend > 0) this.walkPhase += dt * (sprinting ? BOB_SPRINT_CYCLE_SPEED : BOB_WALK_CYCLE_SPEED);
    const bobAmount = (sprinting ? BOB_SPRINT_AMOUNT : BOB_WALK_AMOUNT) * this.moveBlend;
    const bobY = Math.abs(Math.sin(this.walkPhase)) * bobAmount;
    const bobX = Math.sin(this.walkPhase * 0.5) * bobAmount * 0.6;

    // Reload: a single dip-and-return timed against however long this
    // reload actually takes, per class and rarity, rather than a fixed clock.
    const reloading = state.reload > 0;
    if (reloading && !this.wasReloading) this.reloadPeakTicks = state.reload;
    this.wasReloading = reloading;
    const reloadT = reloading && this.reloadPeakTicks > 0 ? 1 - clamp(state.reload / this.reloadPeakTicks, 0, 1) : 0;
    const reloadDip = reloading ? Math.sin(reloadT * Math.PI) * RELOAD_DIP_AMOUNT : 0;

    const localX = this.poseX + bobX;
    const localY = this.poseY + bobY - reloadDip - this.recoilPos * 0.4;
    const localZ = this.poseZ + this.recoilPos * 0.5;

    this.group.position.copy(worldCamera.position);
    this.group.quaternion.copy(worldCamera.quaternion);
    const offset = new THREE.Vector3(localX, localY, localZ).applyQuaternion(worldCamera.quaternion);
    this.group.position.add(offset);
    const sway = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(this.swayPitch, this.swayYaw, this.poseRoll, 'YXZ'),
    );
    this.group.quaternion.multiply(sway);

    this.camera.position.copy(worldCamera.position);
    this.camera.quaternion.copy(worldCamera.quaternion);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.armGeometry.dispose();
    this.armMaterial.dispose();
    this.gunMaterial.dispose();
    for (const child of this.gunGroup.children) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
  }
}
