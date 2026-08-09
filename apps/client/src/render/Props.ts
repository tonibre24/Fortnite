import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
// Side-effect import: adds the thin-instance methods to Mesh in the tree-shaken build.
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Scene } from '@babylonjs/core/scene';
import type { Environment } from './Environment.js';
import {
  PROP_SPECS,
  buildDecorPlan,
  type ColourGrid,
  type DecorPlan,
  type PropKind,
} from './decorPlan.js';
import { DECOR } from './palette.js';

/**
 * Renders the decoration plan.
 *
 * Two rules drive the whole module:
 *
 *  - **One draw call per prop type, never one per instance.** Every repeated prop is a
 *    single mesh drawn with Babylon thin instances: one matrix buffer, one colour buffer,
 *    one submit for the whole field. A thousand tufts of grass cost the same to submit as
 *    one, and the per-instance colour buffer is what stops them looking tiled.
 *  - **Flat shading everywhere.** Terrain and ground are built as unwelded quads with
 *    face normals, so each cell reads as a single deliberate colour rather than a smooth
 *    gradient. That is the low-poly look, and it is also cheaper than smooth normals.
 *
 * Nothing here has a collider. `decorPlan.ts` owns *where* things go and the tests there
 * own the guarantee that none of it lies about collision.
 */

export interface Props {
  meshes: Mesh[];
  materials: StandardMaterial[];
  /** Total instances placed, for the perf overlay. */
  instanceCount: number;
  dispose: () => void;
}

// ---------------------------------------------------------------------------
// Flat-shaded grid meshes
// ---------------------------------------------------------------------------

/**
 * Turns a colour grid into one flat-shaded mesh.
 *
 * Each cell gets its own four vertices so the colour and the normal are per-face; sharing
 * corners would average both and produce exactly the smooth, muddy look the art direction
 * rules out.
 */
function buildGridMesh(scene: Scene, name: string, grid: ColourGrid, baseY: number): Mesh {
  const { cells, cellSize, originX, originZ, heights, colours, mask } = grid;
  const corners = cells + 1;

  let quadCount = 0;
  for (const flag of mask) if (flag !== 0) quadCount++;

  const positions = new Float32Array(quadCount * 4 * 3);
  const normals = new Float32Array(quadCount * 4 * 3);
  const vertexColours = new Float32Array(quadCount * 4 * 4);
  const indices = new Uint32Array(quadCount * 6);

  const edgeA = new Vector3();
  const edgeB = new Vector3();
  const normal = new Vector3();
  let quad = 0;

  for (let cz = 0; cz < cells; cz++) {
    for (let cx = 0; cx < cells; cx++) {
      if (mask[cz * cells + cx] === 0) continue;

      const x0 = originX + cx * cellSize;
      const z0 = originZ + cz * cellSize;
      const x1 = x0 + cellSize;
      const z1 = z0 + cellSize;
      const h00 = baseY + heights[cz * corners + cx];
      const h10 = baseY + heights[cz * corners + cx + 1];
      const h01 = baseY + heights[(cz + 1) * corners + cx];
      const h11 = baseY + heights[(cz + 1) * corners + cx + 1];

      const v = quad * 4;
      const p = v * 3;
      positions[p] = x0;
      positions[p + 1] = h00;
      positions[p + 2] = z0;
      positions[p + 3] = x1;
      positions[p + 4] = h10;
      positions[p + 5] = z0;
      positions[p + 6] = x1;
      positions[p + 7] = h11;
      positions[p + 8] = z1;
      positions[p + 9] = x0;
      positions[p + 10] = h01;
      positions[p + 11] = z1;

      // One face normal from the cell's diagonals, shared by all four corners.
      edgeA.set(x1 - x0, h11 - h00, z1 - z0);
      edgeB.set(x0 - x1, h01 - h10, z1 - z0);
      Vector3.CrossToRef(edgeB, edgeA, normal);
      normal.normalize();
      if (normal.y < 0) normal.scaleInPlace(-1);
      for (let corner = 0; corner < 4; corner++) {
        normals[p + corner * 3] = normal.x;
        normals[p + corner * 3 + 1] = normal.y;
        normals[p + corner * 3 + 2] = normal.z;
      }

      const source = (cz * cells + cx) * 3;
      const c = v * 4;
      for (let corner = 0; corner < 4; corner++) {
        vertexColours[c + corner * 4] = colours[source];
        vertexColours[c + corner * 4 + 1] = colours[source + 1];
        vertexColours[c + corner * 4 + 2] = colours[source + 2];
        vertexColours[c + corner * 4 + 3] = 1;
      }

      // Babylon is left-handed, so an upward-facing quad winds clockwise when seen from
      // above. Getting this backwards silently culls the entire surface.
      const t = quad * 6;
      indices[t] = v;
      indices[t + 1] = v + 1;
      indices[t + 2] = v + 2;
      indices[t + 3] = v;
      indices[t + 4] = v + 2;
      indices[t + 5] = v + 3;
      quad++;
    }
  }

  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.colors = vertexColours;
  data.indices = indices;
  data.applyToMesh(mesh, false);

  mesh.isPickable = false;
  mesh.useVertexColors = true;
  mesh.freezeWorldMatrix();
  return mesh;
}

// ---------------------------------------------------------------------------
// Prop geometry
// ---------------------------------------------------------------------------

/**
 * Builds the unit mesh for one prop type, origin at its base.
 *
 * Every one of these is deliberately tiny — an eight-triangle rock, a thirty-triangle
 * tree — because the cost that matters is not the triangle, it is having a thousand of
 * them in one buffer. All are flat shaded to match the arena.
 */
function buildPropGeometry(scene: Scene, kind: PropKind): Mesh {
  const parts: Mesh[] = [];
  const box = (
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    rotationY = 0,
  ): void => {
    const part = MeshBuilder.CreateBox(`${kind}-part`, { width, height, depth }, scene);
    part.position.set(x, y, z);
    part.rotation.y = rotationY;
    parts.push(part);
  };
  const cone = (diameter: number, height: number, y: number, sides = 6): void => {
    const part = MeshBuilder.CreateCylinder(
      `${kind}-part`,
      { diameterTop: 0, diameterBottom: diameter, height, tessellation: sides },
      scene,
    );
    part.position.y = y + height / 2;
    parts.push(part);
  };

  switch (kind) {
    case 'grass': {
      // Three crossed blades. Thin boxes rather than quads so they are never invisible
      // edge-on, which is the classic failure of billboard-free vegetation.
      for (let i = 0; i < 3; i++) {
        box(0.035, 0.34, 0.22, 0, 0.17, 0, (i * Math.PI) / 3);
      }
      break;
    }
    case 'pebble': {
      box(0.42, 0.22, 0.36, 0, 0.11, 0);
      box(0.26, 0.3, 0.24, 0.1, 0.15, -0.08, 0.6);
      break;
    }
    case 'shrub': {
      cone(0.95, 0.7, 0.05, 5);
      cone(0.66, 0.55, 0.6, 5);
      break;
    }
    case 'rock': {
      box(1.3, 0.85, 1.1, 0, 0.42, 0, 0.4);
      box(0.85, 0.7, 0.8, 0.28, 1.0, 0.18, -0.7);
      break;
    }
    case 'tree': {
      box(0.34, 2.1, 0.34, 0, 1.05, 0);
      cone(2.5, 2.1, 1.7, 6);
      cone(1.8, 1.7, 3.1, 6);
      break;
    }
    case 'fence': {
      box(0.14, 1.35, 0.14, 0, 0.68, 0);
      box(2.4, 0.12, 0.07, 1.2, 1.05, 0);
      box(2.4, 0.12, 0.07, 1.2, 0.62, 0);
      break;
    }
    case 'shed': {
      box(3.6, 2.3, 2.8, 0, 1.15, 0);
      // A pitched roof from two slabs — the honest way to give a building a roof.
      for (const sign of [-1, 1]) {
        const slab = MeshBuilder.CreateBox(
          'shed-roof',
          { width: 4.1, height: 0.18, depth: 1.85 },
          scene,
        );
        slab.position.set(0, 2.8, sign * 0.78);
        slab.rotation.x = sign * -0.62;
        parts.push(slab);
      }
      break;
    }
  }

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  const mesh = merged ?? parts[0];
  mesh.name = `prop-${kind}`;
  // Duplicates the shared vertices so every face keeps its own normal.
  mesh.convertToFlatShadedMesh();
  return mesh;
}

/** The roof of a shed is a different colour from its walls, so it gets its own tint. */
function propMaterial(scene: Scene, kind: PropKind): StandardMaterial {
  const material = new StandardMaterial(`prop-mat-${kind}`, scene);
  material.diffuseColor = Color3.FromHexString(PROP_SPECS[kind].colour);
  material.specularColor = Color3.Black();
  material.emissiveColor = material.diffuseColor.scale(0.12);
  material.backFaceCulling = kind !== 'grass';
  return material;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function buildProps(
  scene: Scene,
  plan: DecorPlan = buildDecorPlan(),
  options: { environment?: Environment } = {},
): Props {
  const meshes: Mesh[] = [];
  const materials: StandardMaterial[] = [];
  const environment = options.environment;

  // --- ground and terrain ---------------------------------------------------
  // White diffuse, because the per-vertex colour multiplies it: the grid's own colours
  // are the surface. Emissive stays low and neutral for the same reason — StandardMaterial
  // cannot tint emissive per vertex, so anything brighter would grey the whole field out.
  const surfaceMaterial = new StandardMaterial('decor-surface', scene);
  surfaceMaterial.diffuseColor = Color3.White();
  surfaceMaterial.specularColor = Color3.Black();
  surfaceMaterial.emissiveColor = new Color3(0.05, 0.05, 0.05);
  materials.push(surfaceMaterial);

  const ground = buildGridMesh(scene, 'arena-ground', plan.ground, 0);
  ground.material = surfaceMaterial;
  ground.receiveShadows = environment !== undefined;
  meshes.push(ground);

  const terrain = buildGridMesh(scene, 'outer-terrain', plan.terrain, 0);
  terrain.material = surfaceMaterial;
  // Deliberately not a shadow receiver: it lies outside the player-fitted shadow frustum
  // and the fog is already dissolving it.
  terrain.receiveShadows = false;
  meshes.push(terrain);

  // --- architectural trim ---------------------------------------------------
  const byColour = new Map<string, Mesh[]>();
  for (const decor of plan.boxes) {
    const mesh = MeshBuilder.CreateBox(
      decor.id,
      { width: decor.size.x, height: decor.size.y, depth: decor.size.z },
      scene,
    );
    mesh.position.set(decor.centre.x, decor.centre.y, decor.centre.z);
    const bucket = byColour.get(decor.colour);
    if (bucket) bucket.push(mesh);
    else byColour.set(decor.colour, [mesh]);
  }

  for (const [colour, group] of byColour) {
    const material = new StandardMaterial(`decor-${colour}`, scene);
    const diffuse = Color3.FromHexString(colour);
    material.diffuseColor = diffuse;
    material.specularColor = Color3.Black();
    // Window glass gets a warm interior glow rather than reading as a black hole.
    material.emissiveColor =
      colour === DECOR.windowGlass
        ? Color3.FromHexString(DECOR.windowGlow).scale(0.22)
        : diffuse.scale(0.12);
    materials.push(material);

    const merged =
      group.length === 1
        ? group[0]
        : (Mesh.MergeMeshes(group, true, true, undefined, false, false) ?? group[0]);
    merged.name = `decor-trim-${colour}`;
    merged.material = material;
    merged.isPickable = false;
    merged.receiveShadows = environment !== undefined;
    merged.freezeWorldMatrix();
    merged.doNotSyncBoundingInfo = true;
    meshes.push(merged);
  }

  // --- instanced props ------------------------------------------------------
  const byKind = new Map<PropKind, typeof plan.props>();
  for (const prop of plan.props) {
    const bucket = byKind.get(prop.kind);
    if (bucket) bucket.push(prop);
    else byKind.set(prop.kind, [prop]);
  }

  const scaling = new Vector3();
  const translation = new Vector3();
  const rotation = new Quaternion();
  const matrix = new Matrix();
  let instanceCount = 0;

  for (const [kind, instances] of byKind) {
    const mesh = buildPropGeometry(scene, kind);
    const material = propMaterial(scene, kind);
    materials.push(material);
    mesh.material = material;
    mesh.isPickable = false;
    mesh.receiveShadows = environment !== undefined;

    const matrices = new Float32Array(instances.length * 16);
    const colours = new Float32Array(instances.length * 4);

    for (let i = 0; i < instances.length; i++) {
      const prop = instances[i];
      scaling.setAll(prop.scale);
      Quaternion.RotationYawPitchRollToRef(prop.rotationY, 0, 0, rotation);
      translation.set(prop.position.x, prop.position.y, prop.position.z);
      Matrix.ComposeToRef(scaling, rotation, translation, matrix);
      matrix.copyToArray(matrices, i * 16);

      colours[i * 4] = prop.tint.r;
      colours[i * 4 + 1] = prop.tint.g;
      colours[i * 4 + 2] = prop.tint.b;
      colours[i * 4 + 3] = 1;
    }

    // One buffer upload, one draw call, for the whole field.
    mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
    mesh.thinInstanceSetBuffer('color', colours, 4, true);
    mesh.thinInstanceRefreshBoundingInfo(false);
    mesh.freezeWorldMatrix();
    instanceCount += instances.length;
    meshes.push(mesh);
  }

  return {
    meshes,
    materials,
    instanceCount,
    dispose: () => {
      for (const mesh of meshes) {
        environment?.removeShadowCaster(mesh);
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
