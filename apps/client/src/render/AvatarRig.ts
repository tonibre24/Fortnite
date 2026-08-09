import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Bone } from '@babylonjs/core/Bones/bone';
import { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { Scene } from '@babylonjs/core/scene';

/**
 * The shared character rig: one low-poly figure, built once and cloned per player.
 *
 * ## Why a skeleton rather than a node hierarchy
 *
 * A transform hierarchy of nine parented boxes is nine draw calls per player, so twenty
 * players cost 180 submits in the main pass and another 180 in the shadow pass. Skinning
 * the same nine boxes into one mesh with eight bones costs *one* draw call per player.
 * That is the single biggest reason the 20-player frame budget holds, and it is why the
 * extra complexity of hand-authoring bind matrices is worth paying for.
 *
 * Babylon's `Bone` and `Skeleton` are core engine types, not an animation library: there
 * are no clips, no blend trees and no importer. `Avatar.ts` writes bone local matrices
 * directly from the movement state, which is the cheapest possible animation path.
 *
 * ## How the bind pose works
 *
 * Every bone's local matrix at construction is a pure translation to its offset from its
 * parent, and that same matrix is used as the bind and rest matrix. Vertices are authored
 * in model space in exactly that pose, so at rest every bone's final matrix is the
 * identity and the mesh renders as authored. Posing a bone then means setting its local
 * matrix to `compose(scale, rotation, offset)`, which rotates its subtree about the
 * bone's own origin.
 */

export const AvatarBone = {
  Root: 0,
  Chest: 1,
  Head: 2,
  ArmLeft: 3,
  ArmRight: 4,
  LegLeft: 5,
  LegRight: 6,
  Weapon: 7,
} as const;

export type AvatarBoneIndex = (typeof AvatarBone)[keyof typeof AvatarBone];
export const AVATAR_BONE_COUNT = 8;

/** Bone offsets from the parent, in metres. Sized against PLAYER_HEIGHT. */
const BONE_LAYOUT: { name: string; parent: number; offset: [number, number, number] }[] = [
  { name: 'root', parent: -1, offset: [0, 0, 0] },
  { name: 'chest', parent: AvatarBone.Root, offset: [0, 0.8, 0] },
  { name: 'head', parent: AvatarBone.Chest, offset: [0, 0.68, 0] },
  { name: 'armL', parent: AvatarBone.Chest, offset: [-0.4, 0.56, 0] },
  { name: 'armR', parent: AvatarBone.Chest, offset: [0.4, 0.56, 0] },
  { name: 'legL', parent: AvatarBone.Root, offset: [-0.17, 0.8, 0] },
  { name: 'legR', parent: AvatarBone.Root, offset: [0.17, 0.8, 0] },
  { name: 'weapon', parent: AvatarBone.Chest, offset: [0.26, 0.44, 0.16] },
];

/**
 * The barrel tip, expressed in the weapon bone's own space.
 *
 * Bone space rather than model space on purpose: `Bone.getFinalMatrix()` maps bone space
 * to posed model space, so this can be transformed by it directly. Because every bind
 * matrix here is a pure translation, this is simply the barrel tip's model-space position
 * (0.26, 1.24, 0.9) minus the weapon bone's absolute bind position (0.26, 1.24, 0.16).
 */
export const MUZZLE_BONE_OFFSET = new Vector3(0, 0, 0.74);

/**
 * The figure's three colour bands, baked into vertex colours.
 *
 * Three materials would mean three draw calls per player. Instead every vertex carries a
 * multiplier against the material's diffuse, so one material and one submit produce a
 * three-tone figure: the player's own hue for the shell, a darker version of it for the
 * limbs, and near-black gunmetal for gear and the weapon.
 */
const BAND_PRIMARY: [number, number, number] = [1, 1, 1];
const BAND_SECONDARY: [number, number, number] = [0.58, 0.6, 0.68];
const BAND_GEAR: [number, number, number] = [0.34, 0.36, 0.42];
const BANDS = [BAND_PRIMARY, BAND_SECONDARY, BAND_GEAR];

interface Part {
  size: [number, number, number];
  centre: [number, number, number];
  bone: number;
  band: number;
}

/**
 * The figure, in model space, feet at y = 0 and crown at PLAYER_HEIGHT.
 *
 * Deliberately blocky and top-heavy: a wide shoulder yoke and a distinct head read as a
 * player silhouette at 40 m, which matters more in a shooter than anatomical proportion.
 */
const PARTS: Part[] = [
  // Legs, boots.
  { size: [0.2, 0.74, 0.22], centre: [-0.17, 0.43, 0], bone: AvatarBone.LegLeft, band: 1 },
  { size: [0.2, 0.74, 0.22], centre: [0.17, 0.43, 0], bone: AvatarBone.LegRight, band: 1 },
  { size: [0.22, 0.12, 0.3], centre: [-0.17, 0.06, 0.03], bone: AvatarBone.LegLeft, band: 2 },
  { size: [0.22, 0.12, 0.3], centre: [0.17, 0.06, 0.03], bone: AvatarBone.LegRight, band: 2 },

  // Pelvis and torso.
  { size: [0.46, 0.22, 0.32], centre: [0, 0.87, 0], bone: AvatarBone.Chest, band: 1 },
  { size: [0.56, 0.56, 0.34], centre: [0, 1.22, 0], bone: AvatarBone.Chest, band: 0 },
  { size: [0.84, 0.16, 0.4], centre: [0, 1.44, 0], bone: AvatarBone.Chest, band: 1 },
  { size: [0.3, 0.34, 0.14], centre: [0, 1.24, -0.23], bone: AvatarBone.Chest, band: 2 },

  // Head, visor and crest — the asymmetric bits that make facing obvious.
  { size: [0.34, 0.32, 0.32], centre: [0, 1.63, 0], bone: AvatarBone.Head, band: 0 },
  { size: [0.28, 0.1, 0.05], centre: [0, 1.64, 0.17], bone: AvatarBone.Head, band: 2 },
  { size: [0.09, 0.09, 0.24], centre: [0, 1.8, -0.02], bone: AvatarBone.Head, band: 1 },

  // Arms.
  { size: [0.16, 0.5, 0.16], centre: [-0.4, 1.11, 0], bone: AvatarBone.ArmLeft, band: 1 },
  { size: [0.16, 0.5, 0.16], centre: [0.4, 1.11, 0], bone: AvatarBone.ArmRight, band: 1 },
  { size: [0.17, 0.16, 0.18], centre: [-0.4, 0.85, 0.02], bone: AvatarBone.ArmLeft, band: 2 },
  { size: [0.17, 0.16, 0.18], centre: [0.4, 0.85, 0.02], bone: AvatarBone.ArmRight, band: 2 },

  // Weapon: body, magazine and stock.
  { size: [0.1, 0.14, 0.7], centre: [0.26, 1.24, 0.5], bone: AvatarBone.Weapon, band: 2 },
  { size: [0.08, 0.2, 0.12], centre: [0.26, 1.1, 0.34], bone: AvatarBone.Weapon, band: 2 },
  { size: [0.1, 0.16, 0.2], centre: [0.26, 1.24, 0.06], bone: AvatarBone.Weapon, band: 1 },
];

export interface AvatarRig {
  /** Template mesh; clone it per player. Disabled and never rendered itself. */
  readonly template: Mesh;
  readonly skeleton: Skeleton;
  dispose(): void;
}

/** Builds the skeleton in bind pose. */
function buildSkeleton(scene: Scene): Skeleton {
  const skeleton = new Skeleton('avatar-rig', 'avatar-rig', scene);
  // Eight bones fit comfortably in uniform registers; a bone texture would cost an
  // upload and a sampler fetch per player per frame for no benefit at this size.
  skeleton.useTextureToStoreBoneMatrices = false;

  const bones: Bone[] = [];
  for (const layout of BONE_LAYOUT) {
    const local = Matrix.Translation(layout.offset[0], layout.offset[1], layout.offset[2]);
    bones.push(
      new Bone(
        layout.name,
        skeleton,
        layout.parent >= 0 ? bones[layout.parent] : null,
        local,
        // Rest and bind both equal the local matrix, so the authored pose *is* the bind
        // pose and every final matrix starts as the identity.
        local.clone(),
        local.clone(),
      ),
    );
  }
  return skeleton;
}

/**
 * Builds the skinned template mesh.
 *
 * Each part is a box whose vertices are all weighted 1.0 to a single bone — rigid
 * skinning, which is exactly right for a blocky low-poly figure and needs only one bone
 * influencer per vertex.
 */
export function buildAvatarRig(scene: Scene): AvatarRig {
  const skeleton = buildSkeleton(scene);
  const boxes: Mesh[] = [];

  for (let i = 0; i < PARTS.length; i++) {
    const part = PARTS[i];
    const box = MeshBuilder.CreateBox(
      `avatar-part-${i}`,
      { width: part.size[0], height: part.size[1], depth: part.size[2] },
      scene,
    );
    box.position.set(part.centre[0], part.centre[1], part.centre[2]);
    box.bakeCurrentTransformIntoVertices();

    const vertexCount = box.getTotalVertices();
    const indices = new Float32Array(vertexCount * 4);
    const weights = new Float32Array(vertexCount * 4);
    const colours = new Float32Array(vertexCount * 4);
    const band = BANDS[part.band];
    for (let v = 0; v < vertexCount; v++) {
      indices[v * 4] = part.bone;
      weights[v * 4] = 1;
      colours[v * 4] = band[0];
      colours[v * 4 + 1] = band[1];
      colours[v * 4 + 2] = band[2];
      colours[v * 4 + 3] = 1;
    }
    box.setVerticesData(VertexBuffer.MatricesIndicesKind, indices, false);
    box.setVerticesData(VertexBuffer.MatricesWeightsKind, weights, false);
    box.setVerticesData(VertexBuffer.ColorKind, colours, false);
    boxes.push(box);
  }

  const template = Mesh.MergeMeshes(boxes, true, true, undefined, false, false);
  if (!template) throw new Error('avatar rig: merge failed');

  template.name = 'avatar-template';
  template.skeleton = skeleton;
  template.numBoneInfluencers = 1;
  template.isPickable = false;
  template.setEnabled(false);
  template.useVertexColors = true;

  return {
    template,
    skeleton,
    dispose: () => {
      template.dispose(false, true);
      skeleton.dispose();
    },
  };
}
