import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Scene } from '@babylonjs/core/scene';
import { getArena, type ArenaDefinition, type MaterialKey } from '@riftfront/shared';

/**
 * Builds the arena's visual representation from the shared arena definition.
 *
 * Boxes are merged per material into a handful of static meshes. With ~140 primitives
 * that turns roughly 140 draw calls into 8, which is the single biggest win available
 * for a scene of this shape. Merged meshes are frozen (`freezeWorldMatrix`) because the
 * arena never moves.
 */

interface MaterialSpec {
  diffuse: string;
  emissive?: string;
  specular?: string;
}

/** Original stylised palette: saturated, high-contrast, readable at a glance. */
const PALETTE: Record<MaterialKey, MaterialSpec> = {
  ground: { diffuse: '#2f4a57', specular: '#0a0f14' },
  wall: { diffuse: '#1d2b3d', specular: '#050810' },
  structure: { diffuse: '#7d8aa6', specular: '#141a26' },
  platform: { diffuse: '#c2803f', specular: '#1a1208' },
  accent: { diffuse: '#3fbfa5', emissive: '#0a2a25', specular: '#0b1a18' },
  accentAlt: { diffuse: '#c95f7a', emissive: '#2a0d16', specular: '#1a0a0f' },
  metal: { diffuse: '#9aa7bb', specular: '#3a4356' },
  core: { diffuse: '#7b5bff', emissive: '#3a2a9a', specular: '#221a55' },
};

export interface ArenaScenery {
  meshes: Mesh[];
  materials: StandardMaterial[];
  dispose: () => void;
}

function makeMaterial(scene: Scene, key: MaterialKey): StandardMaterial {
  const spec = PALETTE[key];
  const material = new StandardMaterial(`mat-${key}`, scene);
  const diffuse = Color3.FromHexString(spec.diffuse);
  material.diffuseColor = diffuse;
  material.specularColor = Color3.FromHexString(spec.specular ?? '#101010');
  // A floor of self-illumination keeps unlit faces readable. Without it, surfaces facing
  // away from the key light go almost black and enemy silhouettes disappear against them.
  const emissive = spec.emissive ? Color3.FromHexString(spec.emissive) : diffuse.scale(0.22);
  material.emissiveColor = emissive;
  material.specularPower = 48;
  // The arena has no dynamic lighting changes, so the material can be frozen.
  material.freeze();
  return material;
}

export function buildArenaScenery(scene: Scene, arena: ArenaDefinition = getArena()): ArenaScenery {
  const byMaterial = new Map<MaterialKey, Mesh[]>();

  for (const visual of arena.visuals) {
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
    const material = makeMaterial(scene, key);
    materials.push(material);

    const merged =
      group.length === 1
        ? group[0]
        : (Mesh.MergeMeshes(group, true, true, undefined, false, false) ?? group[0]);

    merged.name = `arena-${key}`;
    merged.material = material;
    merged.isPickable = false;
    merged.receiveShadows = false;
    merged.checkCollisions = false;
    merged.freezeWorldMatrix();
    merged.doNotSyncBoundingInfo = true;
    meshes.push(merged);
  }

  return {
    meshes,
    materials,
    dispose: () => {
      for (const mesh of meshes) mesh.dispose(false, false);
      for (const material of materials) {
        material.unfreeze();
        material.dispose();
      }
      meshes.length = 0;
      materials.length = 0;
    },
  };
}

export interface SceneLighting {
  dispose: () => void;
}

/**
 * Two-light setup: a warm key light for shape readability and a cool hemispheric fill so
 * nothing in shadow becomes unreadable. Shadow maps are deliberately omitted — silhouette
 * clarity matters more than realism here, and it keeps the frame budget for gameplay.
 */
export function buildLighting(scene: Scene): SceneLighting {
  scene.clearColor = new Color4(0.15, 0.19, 0.29, 1);
  scene.ambientColor = new Color3(0.42, 0.46, 0.58);

  const key = new DirectionalLight('key-light', new Vector3(-0.55, -1, 0.35), scene);
  key.intensity = 1.5;
  key.diffuse = Color3.FromHexString('#fff2dd');
  key.specular = Color3.FromHexString('#ffe6c0');

  // The fill is deliberately strong. Readability beats mood in a shooter: a player in
  // shadow must still be identifiable at 40 m.
  const fill = new HemisphericLight('fill-light', new Vector3(0.2, 1, -0.3), scene);
  fill.intensity = 1.05;
  fill.diffuse = Color3.FromHexString('#bcd6ff');
  fill.groundColor = Color3.FromHexString('#4a3f62');

  // Light distance fog for depth cueing only; dense enough to hide an enemy would be a
  // gameplay problem, not an aesthetic one.
  scene.fogMode = 2; // FOGMODE_EXP
  scene.fogColor = new Color3(0.15, 0.19, 0.29);
  scene.fogDensity = 0.0032;

  return {
    dispose: () => {
      key.dispose();
      fill.dispose();
    },
  };
}
