import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { type Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import { PLAYER_HEAD_HEIGHT, hashSeed } from '@riftfront/shared';

/**
 * An original low-poly character built from primitives.
 *
 * The silhouette is deliberately blocky and top-heavy so players read instantly at
 * range, and each player gets a distinct hue derived from their session id. There is no
 * skeletal animation: limbs are driven procedurally, which costs almost nothing and
 * keeps the vertical slice free of an animation pipeline.
 */

const BODY_HEIGHT = 0.78;
const LEG_HEIGHT = 0.72;

export interface AvatarOptions {
  /** Local player avatars are hidden from their own camera except in third person. */
  isLocal: boolean;
}

export class Avatar {
  readonly root: TransformNode;
  /** Yaws with the camera; carries the upper body and weapon. */
  private readonly torso: TransformNode;
  private readonly head: Mesh;
  private readonly weapon: Mesh;
  private readonly weaponMuzzle: TransformNode;
  private readonly legLeft: Mesh;
  private readonly legRight: Mesh;
  private readonly armLeft: Mesh;
  private readonly armRight: Mesh;
  private readonly meshes: Mesh[] = [];
  private readonly materials: StandardMaterial[] = [];

  private strideTime = 0;
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    readonly playerId: string,
    options: AvatarOptions,
  ) {
    const hue = (hashSeed(playerId) % 360) / 360;
    const primary = Color3.FromHSV(hue * 360, 0.62, 0.92);
    const secondary = Color3.FromHSV((hue * 360 + 28) % 360, 0.45, 0.42);

    const bodyMat = this.material(`avatar-body-${playerId}`, primary, 0.16);
    const trimMat = this.material(`avatar-trim-${playerId}`, secondary, 0.05);
    const gunMat = this.material(`avatar-gun-${playerId}`, Color3.FromHexString('#2b3244'), 0.02);

    this.root = new TransformNode(`avatar-${playerId}`, scene);
    this.torso = new TransformNode(`avatar-torso-${playerId}`, scene);
    this.torso.parent = this.root;
    this.torso.position.y = LEG_HEIGHT;

    const chest = this.box(`chest-${playerId}`, 0.62, BODY_HEIGHT, 0.38, bodyMat);
    chest.parent = this.torso;
    chest.position.y = BODY_HEIGHT / 2;

    // A shoulder yoke widens the silhouette so players are readable side-on.
    const yoke = this.box(`yoke-${playerId}`, 0.86, 0.18, 0.42, trimMat);
    yoke.parent = this.torso;
    yoke.position.y = BODY_HEIGHT - 0.06;

    this.head = this.box(`head-${playerId}`, 0.36, 0.36, 0.36, bodyMat);
    this.head.parent = this.torso;
    this.head.position.y = PLAYER_HEAD_HEIGHT - LEG_HEIGHT;

    // Visor: an asymmetric marker that makes facing direction obvious.
    const visor = this.box(`visor-${playerId}`, 0.3, 0.11, 0.06, trimMat);
    visor.parent = this.head;
    visor.position.set(0, 0.03, 0.19);

    this.armLeft = this.box(`arm-l-${playerId}`, 0.17, 0.6, 0.17, trimMat);
    this.armLeft.parent = this.torso;
    this.armLeft.setPivotPoint(new Vector3(0, 0.3, 0));
    this.armLeft.position.set(-0.4, BODY_HEIGHT - 0.36, 0);

    this.armRight = this.box(`arm-r-${playerId}`, 0.17, 0.6, 0.17, trimMat);
    this.armRight.parent = this.torso;
    this.armRight.setPivotPoint(new Vector3(0, 0.3, 0));
    this.armRight.position.set(0.4, BODY_HEIGHT - 0.36, 0);

    this.legLeft = this.box(`leg-l-${playerId}`, 0.2, LEG_HEIGHT, 0.2, trimMat);
    this.legLeft.parent = this.root;
    this.legLeft.setPivotPoint(new Vector3(0, LEG_HEIGHT / 2, 0));
    this.legLeft.position.set(-0.16, LEG_HEIGHT / 2, 0);

    this.legRight = this.box(`leg-r-${playerId}`, 0.2, LEG_HEIGHT, 0.2, trimMat);
    this.legRight.parent = this.root;
    this.legRight.setPivotPoint(new Vector3(0, LEG_HEIGHT / 2, 0));
    this.legRight.position.set(0.16, LEG_HEIGHT / 2, 0);

    this.weapon = this.box(`weapon-${playerId}`, 0.11, 0.16, 0.86, gunMat);
    this.weapon.parent = this.torso;
    this.weapon.position.set(0.3, BODY_HEIGHT - 0.24, 0.34);

    this.weaponMuzzle = new TransformNode(`muzzle-${playerId}`, scene);
    this.weaponMuzzle.parent = this.weapon;
    this.weaponMuzzle.position.set(0, 0, 0.5);

    if (options.isLocal) {
      // The local avatar is visible (third person) but must never block its own camera.
      for (const mesh of this.meshes) mesh.isPickable = false;
    }
  }

  private material(name: string, colour: Color3, emissiveScale: number): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = colour;
    material.emissiveColor = colour.scale(emissiveScale);
    material.specularColor = new Color3(0.14, 0.15, 0.2);
    material.specularPower = 32;
    this.materials.push(material);
    return material;
  }

  private box(
    name: string,
    width: number,
    height: number,
    depth: number,
    material: StandardMaterial,
  ): Mesh {
    const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, this.scene);
    mesh.material = material;
    mesh.isPickable = false;
    this.meshes.push(mesh);
    return mesh;
  }

  /** World position of the weapon muzzle, used to anchor the muzzle flash. */
  getMuzzleWorldPosition(): Vector3 {
    this.weaponMuzzle.computeWorldMatrix(true);
    return this.weaponMuzzle.getAbsolutePosition();
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.root.setEnabled(visible);
  }

  /**
   * Applies replicated transform and animation flags.
   * `dtSeconds` drives the procedural stride; `moving` comes from the server.
   */
  update(params: {
    position: { x: number; y: number; z: number };
    yaw: number;
    pitch: number;
    moving: boolean;
    sprinting: boolean;
    aiming: boolean;
    alive: boolean;
    dtSeconds: number;
  }): void {
    if (this.disposed) return;

    this.root.position.set(params.position.x, params.position.y, params.position.z);
    // Babylon's Y rotation matches the shared yaw convention (0 faces +Z).
    this.root.rotation.y = params.yaw;

    // Aiming pitches the upper body only, so the legs stay planted.
    this.torso.rotation.x = params.aiming ? params.pitch * 0.55 : params.pitch * 0.28;

    if (params.alive) {
      const speed = params.sprinting ? 13 : 9;
      this.strideTime += params.moving ? params.dtSeconds * speed : -this.strideTime * 0.25;
      const swing = params.moving ? Math.sin(this.strideTime) * (params.sprinting ? 0.72 : 0.5) : 0;

      this.legLeft.rotation.x = swing;
      this.legRight.rotation.x = -swing;
      this.armLeft.rotation.x = params.aiming ? -1.15 : -swing * 0.55;
      this.armRight.rotation.x = params.aiming ? -1.3 : swing * 0.55;
      this.weapon.rotation.x = params.aiming ? -0.06 : 0.16;
      this.weapon.position.x = params.aiming ? 0.06 : 0.3;
      this.root.rotation.z = 0;
      this.root.position.y = params.position.y;
    } else {
      // Eliminated players fall over rather than vanishing instantly.
      this.root.rotation.z = Math.PI / 2;
      this.root.position.y = params.position.y + 0.35;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.weaponMuzzle.dispose();
    this.torso.dispose();
    for (const mesh of this.meshes) mesh.dispose(false, false);
    for (const material of this.materials) material.dispose();
    this.meshes.length = 0;
    this.materials.length = 0;
    this.root.dispose();
  }
}
