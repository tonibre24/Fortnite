import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Scene } from '@babylonjs/core/scene';
import { getArena, type ArenaDefinition, type MaterialKey } from '@riftfront/shared';
import type { Environment } from './Environment.js';
import { SURFACES } from './palette.js';

/**
 * Builds the arena's visual representation from the shared arena definition.
 *
 * Boxes are merged per material into a handful of static meshes. With ~140 primitives
 * that turns roughly 140 draw calls into 8, which is the single biggest win available
 * for a scene of this shape. Merged meshes are frozen (`freezeWorldMatrix`) because the
 * arena never moves.
 *
 * This module is strictly a *reader* of the shared arena: it never adds, moves or
 * resizes anything the server also simulates. Decoration lives in `Props.ts` and is
 * additive and client-only.
 */

export interface ArenaScenery {
  meshes: Mesh[];
  materials: StandardMaterial[];
  dispose: () => void;
}

export interface SceneryOptions {
  /** Registers the merged meshes as shadow casters and enables shadow receiving. */
  environment?: Environment;
  /**
   * Visual ids to leave out. The ground slab is skipped once the decorated terrain in
   * `Props.ts` takes over drawing it.
   */
  skipVisualIds?: ReadonlySet<string>;
}

/**
 * A flat-shaded matte surface. Specular is off entirely — a stylised low-poly scene wants
 * a single readable value per face, and highlights only add noise at 1080p.
 */
export function makeSurfaceMaterial(scene: Scene, key: MaterialKey): StandardMaterial {
  const spec = SURFACES[key];
  const material = new StandardMaterial(`mat-${key}`, scene);
  const diffuse = Color3.FromHexString(spec.diffuse);
  material.diffuseColor = diffuse;
  material.specularColor = Color3.Black();
  // A floor of self-illumination keeps unlit faces readable. Without it, surfaces facing
  // away from the sun go almost black and enemy silhouettes disappear against them.
  // The sun and the hemispheric fill together peak just under 1.0, so this floor is the
  // only thing standing between a back-facing wall and pure black.
  material.emissiveColor = spec.emissive
    ? Color3.FromHexString(spec.emissive)
    : diffuse.scale(0.11);
  return material;
}

export function buildArenaScenery(
  scene: Scene,
  arena: ArenaDefinition = getArena(),
  options: SceneryOptions = {},
): ArenaScenery {
  const byMaterial = new Map<MaterialKey, Mesh[]>();
  const skip = options.skipVisualIds;

  for (const visual of arena.visuals) {
    if (skip?.has(visual.id)) continue;

    const box = MeshBuilder.CreateBox(
      visual.id,
      { width: visual.size.x, height: visual.size.y, depth: visual.size.z },
      scene,
    );
    box.position.set(visual.position.x, visual.position.y, visual.position.z);
    if (visual.rotation.x !== 0 || visual.rotation.y !== 0 || visual.rotation.z !== 0) {
      box.rotation.set(visual.rotation.x, visual.rotation.y, visual.rotation.z);
    }
    const bucket = byMaterial.get(visual.material);
    if (bucket) bucket.push(box);
    else byMaterial.set(visual.material, [box]);
  }

  const meshes: Mesh[] = [];
  const materials: StandardMaterial[] = [];

  for (const [key, group] of byMaterial) {
    const material = makeSurfaceMaterial(scene, key);
    materials.push(material);

    const merged =
      group.length === 1
        ? group[0]
        : (Mesh.MergeMeshes(group, true, true, undefined, false, false) ?? group[0]);

    merged.name = `arena-${key}`;
    merged.material = material;
    merged.isPickable = false;
    merged.checkCollisions = false;
    merged.receiveShadows = options.environment !== undefined;
    merged.freezeWorldMatrix();
    merged.doNotSyncBoundingInfo = true;
    options.environment?.addShadowCaster(merged);
    meshes.push(merged);
  }

  return {
    meshes,
    materials,
    dispose: () => {
      for (const mesh of meshes) {
        options.environment?.removeShadowCaster(mesh);
        mesh.dispose(false, false);
      }
      for (const material of materials) {
        material.unfreeze();
        material.dispose();
      }
      meshes.length = 0;
      materials.length = 0;
    },
  };
}
