import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Scene } from '@babylonjs/core/scene';
import { clamp, hashSeed } from '@riftfront/shared';
import { AvatarBone, MUZZLE_BONE_OFFSET, type AvatarRig } from './AvatarRig.js';
import type { Environment } from './Environment.js';
import { selectPose, type AvatarPose } from './avatarPose.js';

/**
 * One player: a low-poly articulated figure, posed procedurally from movement state.
 *
 * The geometry and skeleton come from the shared `AvatarRig`, so every player is a clone
 * over the same vertex buffers and costs exactly one draw call. Posing is direct bone
 * matrix writes — no animation clips, no blending graph, no library.
 *
 * Which pose to play is decided by `avatarPose.ts`; this module owns what each pose does
 * to the bones. Aiming is a modifier rather than a pose: it raises both arms onto the
 * weapon and pitches the chest with the camera, over whatever the legs are doing.
 */

export type { AvatarPose } from './avatarPose.js';
export { selectPose } from './avatarPose.js';

export interface AvatarUpdate {
  position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  moving: boolean;
  sprinting: boolean;
  aiming: boolean;
  alive: boolean;
  grounded: boolean;
  /** Vertical velocity in m/s; negative is falling. */
  verticalVelocity: number;
  dtSeconds: number;
}

/** Per-bone rotation targets for a pose, in radians. Plain data, no engine types. */
interface PoseTargets {
  chestPitch: number;
  chestRoll: number;
  headPitch: number;
  armLeftPitch: number;
  armLeftRoll: number;
  armRightPitch: number;
  armRightRoll: number;
  legLeftPitch: number;
  legRightPitch: number;
  /** Barrel elevation. Separate from the arm so the weapon never points at the sky. */
  weaponPitch: number;
  /** Vertical offset of the whole figure — a crouch on landing, a bob on stride. */
  bodyLift: number;
}

export class Avatar {
  readonly mesh: Mesh;
  private readonly skeleton: Skeleton;
  private readonly material: StandardMaterial;
  private readonly environment: Environment | undefined;

  /** Smoothed animation state. Nothing here allocates once construction is done. */
  private strideTime = 0;
  private readonly targets: PoseTargets = blankTargets();
  private readonly current: PoseTargets = blankTargets();
  private pose: AvatarPose = 'idle';

  private readonly scratchQuaternion = new Quaternion();
  private readonly scratchOffset = new Vector3();
  private readonly scratchScale = new Vector3(1, 1, 1);
  private readonly muzzleWorld = new Vector3();
  private readonly boneOffsets: Vector3[] = [];

  private disposed = false;

  constructor(
    scene: Scene,
    readonly playerId: string,
    options: { isLocal: boolean; rig: AvatarRig; environment?: Environment },
  ) {
    const hue = hashSeed(playerId) % 360;
    const primary = Color3.FromHSV(hue, 0.58, 0.9);

    this.material = new StandardMaterial(`avatar-${playerId}`, scene);
    this.material.diffuseColor = primary;
    this.material.specularColor = Color3.Black();
    this.material.emissiveColor = primary.scale(0.12);

    this.mesh = options.rig.template.clone(`avatar-${playerId}`);
    this.mesh.setEnabled(true);
    this.mesh.material = this.material;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = false;
    // Each player needs their own posed skeleton; the geometry stays shared.
    this.skeleton = options.rig.skeleton.clone(`avatar-skeleton-${playerId}`);
    this.skeleton.useTextureToStoreBoneMatrices = false;
    this.mesh.skeleton = this.skeleton;
    this.mesh.numBoneInfluencers = 1;
    this.mesh.rotationQuaternion = Quaternion.Identity();

    // Cache each bone's bind translation so posing never has to re-read a matrix.
    for (const bone of this.skeleton.bones) {
      const bind = bone.getBindMatrix();
      this.boneOffsets.push(new Vector3(bind.m[12], bind.m[13], bind.m[14]));
    }

    this.environment = options.environment;
    if (this.environment) {
      this.mesh.receiveShadows = true;
      this.environment.addShadowCaster(this.mesh);
    }

    void options.isLocal;
  }

  /** World position of the barrel tip, used to anchor the muzzle flash. */
  getMuzzleWorldPosition(): Vector3 {
    if (this.disposed) return this.muzzleWorld;
    const weapon = this.skeleton.bones[AvatarBone.Weapon];
    // `getFinalMatrix` is the bone's accumulated transform: bone space to posed model
    // space. It is *not* the skinning matrix, so the offset has to start in bone space.
    Vector3.TransformCoordinatesToRef(
      MUZZLE_BONE_OFFSET,
      weapon.getFinalMatrix(),
      this.muzzleWorld,
    );
    Vector3.TransformCoordinatesToRef(
      this.muzzleWorld,
      this.mesh.getWorldMatrix(),
      this.muzzleWorld,
    );
    return this.muzzleWorld;
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.mesh.setEnabled(visible);
  }

  update(params: AvatarUpdate): void {
    if (this.disposed) return;

    this.pose = selectPose(params);
    this.advanceStride(params);
    this.buildTargets(params);

    // Ease towards the pose so state flips (landing, starting a sprint) do not pop.
    const blend = 1 - Math.exp(-params.dtSeconds * 16);
    approach(this.current, this.targets, blend);

    this.applyTransform(params);
    this.applyBones();
  }

  private advanceStride(params: AvatarUpdate): void {
    if (this.pose === 'walk' || this.pose === 'sprint') {
      const rate = this.pose === 'sprint' ? 13.5 : 9;
      this.strideTime += params.dtSeconds * rate;
    } else {
      // Unwind to a neutral stance instead of freezing mid-step.
      this.strideTime += (0 - (this.strideTime % (Math.PI * 2))) * params.dtSeconds * 4;
    }
  }

  private buildTargets(params: AvatarUpdate): void {
    const t = this.targets;
    const swing = Math.sin(this.strideTime);
    const bob = Math.cos(this.strideTime * 2);

    switch (this.pose) {
      case 'idle':
        t.chestPitch = 0.04;
        t.chestRoll = 0;
        t.legLeftPitch = 0;
        t.legRightPitch = 0;
        t.armLeftPitch = 0.06;
        t.armRightPitch = -0.06;
        t.armLeftRoll = 0.08;
        t.armRightRoll = -0.08;
        t.weaponPitch = 0.24;
        t.bodyLift = 0;
        break;
      case 'walk':
        t.chestPitch = 0.1;
        t.chestRoll = swing * 0.05;
        t.legLeftPitch = swing * 0.52;
        t.legRightPitch = -swing * 0.52;
        t.armLeftPitch = -swing * 0.42;
        t.armRightPitch = swing * 0.42;
        t.armLeftRoll = 0.1;
        t.armRightRoll = -0.1;
        t.weaponPitch = 0.28;
        t.bodyLift = bob * 0.022;
        break;
      case 'sprint':
        // The lean is what sells the speed: the legs alone read as a fast walk.
        t.chestPitch = 0.3;
        t.chestRoll = swing * 0.09;
        t.legLeftPitch = swing * 0.86;
        t.legRightPitch = -swing * 0.86;
        t.armLeftPitch = -swing * 0.78 - 0.5;
        t.armRightPitch = swing * 0.78 - 0.5;
        t.armLeftRoll = 0.22;
        t.armRightRoll = -0.22;
        // Barrel dropped and tucked in: nobody sprints with a rifle at eye level.
        t.weaponPitch = 0.62;
        t.bodyLift = bob * 0.045 - 0.03;
        break;
      case 'jump':
        t.chestPitch = -0.12;
        t.chestRoll = 0;
        t.legLeftPitch = 0.7;
        t.legRightPitch = 0.34;
        t.armLeftPitch = -1.1;
        t.armRightPitch = -1.1;
        t.armLeftRoll = 0.4;
        t.armRightRoll = -0.4;
        t.weaponPitch = 0.35;
        t.bodyLift = 0;
        break;
      case 'freefall':
        t.chestPitch = 0.16;
        t.chestRoll = 0;
        t.legLeftPitch = -0.42;
        t.legRightPitch = 0.36;
        t.armLeftPitch = -0.9;
        t.armRightPitch = -0.7;
        t.armLeftRoll = 0.75;
        t.armRightRoll = -0.75;
        t.weaponPitch = 0.4;
        t.bodyLift = 0;
        break;
      case 'glide':
        // Spread-eagle: arms swept wide, legs back, chest pitched into the air stream.
        t.chestPitch = 0.42;
        t.chestRoll = 0;
        t.legLeftPitch = -0.66;
        t.legRightPitch = -0.66;
        t.armLeftPitch = -1.45;
        t.armRightPitch = -1.45;
        t.armLeftRoll = 1.15;
        t.armRightRoll = -1.15;
        t.weaponPitch = 0.5;
        t.bodyLift = 0;
        break;
      case 'dead':
        t.chestPitch = 0.2;
        t.chestRoll = 0;
        t.legLeftPitch = 0.3;
        t.legRightPitch = 0.1;
        t.armLeftPitch = 0.5;
        t.armRightPitch = 0.4;
        t.armLeftRoll = 0.5;
        t.armRightRoll = -0.5;
        t.weaponPitch = 0.2;
        t.bodyLift = 0;
        break;
    }

    // Aiming overrides the upper body wherever the player is alive and on their feet.
    if (params.aiming && params.alive) {
      t.chestPitch = params.pitch * 0.5;
      t.armLeftPitch = -1.24;
      t.armRightPitch = -1.34;
      t.armLeftRoll = 0.46;
      t.armRightRoll = -0.14;
      // Level with the shot: the chest already carries half the aim pitch, so the
      // weapon only needs the remainder to line up with where the bullet goes.
      t.weaponPitch = -params.pitch * 0.5;
    }

    t.headPitch = clamp(params.pitch * 0.6 - t.chestPitch * 0.5, -0.6, 0.6);
  }

  private applyTransform(params: AvatarUpdate): void {
    const lift = this.pose === 'dead' ? 0.4 : this.current.bodyLift;
    this.mesh.position.set(params.position.x, params.position.y + lift, params.position.z);

    // Eliminated players topple sideways rather than vanishing.
    const roll = this.pose === 'dead' ? Math.PI / 2 : 0;
    Quaternion.RotationYawPitchRollToRef(
      params.yaw,
      0,
      roll,
      this.mesh.rotationQuaternion ?? Quaternion.Identity(),
    );
  }

  /** Writes every bone's local matrix straight into the skeleton. */
  private applyBones(): void {
    const c = this.current;
    this.setBone(AvatarBone.Chest, c.chestPitch, 0, c.chestRoll);
    this.setBone(AvatarBone.Head, c.headPitch, 0, 0);
    this.setBone(AvatarBone.ArmLeft, c.armLeftPitch, 0, c.armLeftRoll);
    this.setBone(AvatarBone.ArmRight, c.armRightPitch, 0, c.armRightRoll);
    this.setBone(AvatarBone.LegLeft, c.legLeftPitch, 0, 0);
    this.setBone(AvatarBone.LegRight, c.legRightPitch, 0, 0);
    this.setBone(AvatarBone.Weapon, c.weaponPitch, 0, 0);
  }

  private setBone(index: number, pitch: number, yaw: number, roll: number): void {
    const bone = this.skeleton.bones[index];
    Quaternion.RotationYawPitchRollToRef(yaw, pitch, roll, this.scratchQuaternion);
    this.scratchOffset.copyFrom(this.boneOffsets[index]);
    Matrix.ComposeToRef(
      this.scratchScale,
      this.scratchQuaternion,
      this.scratchOffset,
      bone.getLocalMatrix(),
    );
    bone.markAsDirty();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.environment?.removeShadowCaster(this.mesh);
    this.mesh.dispose(false, false);
    this.skeleton.dispose();
    this.material.dispose();
  }
}

function blankTargets(): PoseTargets {
  return {
    chestPitch: 0,
    chestRoll: 0,
    headPitch: 0,
    armLeftPitch: 0,
    armLeftRoll: 0,
    armRightPitch: 0,
    armRightRoll: 0,
    legLeftPitch: 0,
    legRightPitch: 0,
    weaponPitch: 0.24,
    bodyLift: 0,
  };
}

/** Frame-rate-independent ease of every channel towards its target. */
function approach(current: PoseTargets, target: PoseTargets, blend: number): void {
  current.chestPitch += (target.chestPitch - current.chestPitch) * blend;
  current.chestRoll += (target.chestRoll - current.chestRoll) * blend;
  current.headPitch += (target.headPitch - current.headPitch) * blend;
  current.armLeftPitch += (target.armLeftPitch - current.armLeftPitch) * blend;
  current.armLeftRoll += (target.armLeftRoll - current.armLeftRoll) * blend;
  current.armRightPitch += (target.armRightPitch - current.armRightPitch) * blend;
  current.armRightRoll += (target.armRightRoll - current.armRightRoll) * blend;
  current.legLeftPitch += (target.legLeftPitch - current.legLeftPitch) * blend;
  current.legRightPitch += (target.legRightPitch - current.legRightPitch) * blend;
  current.weaponPitch += (target.weaponPitch - current.weaponPitch) * blend;
  current.bodyLift += (target.bodyLift - current.bodyLift) * blend;
}
