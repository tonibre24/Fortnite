import * as THREE from 'three';
import { Rng } from '@br/shared';

/**
 * Shared foliage primitives.
 *
 * Both the scattered shrubs/hedgerows (Vegetation) and the tree canopies
 * drawn over the map's own canopy boxes (WorldView) need the same two things:
 * a crossed-card billboard and an alpha-cutout leaf mask. They live here so
 * the two systems cannot drift apart into two different-looking kinds of
 * greenery in the same field.
 */

/**
 * Two unit cards crossed at right angles, base at y=0 and tip at y=1 in local
 * space - instance scale supplies the actual width/height, so wind sway
 * (keyed off local y) and the per-instance size stay independent of each
 * other. DoubleSide plus per-fragment face-direction flipping (built into the
 * standard shader) lights both faces correctly from one set of normals.
 *
 * Four triangles per instance, against twelve for the box it replaces on a
 * tree canopy - this is cheaper than the geometry it stands in for, not a
 * quality-for-performance trade.
 */
export function buildCrossBillboardGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array([
    // Plane A, in the XY plane at z=0, normal +Z.
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
    // Plane B, in the ZY plane at x=0, normal +X.
    0, 0, -0.5, 0, 0, 0.5, 0, 1, 0.5, 0, 1, -0.5,
  ]);
  const normal = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
  ]);
  const uv = new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
  ]);
  const index = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];

  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

/**
 * Renders a soft, irregular foliage clump to an alpha-cutout texture on
 * Canvas2D - several overlapping radial-gradient blobs rather than one
 * circle, so the silhouette reads as a bush and not a lollipop.
 *
 * `lobes` scales the blob count: a tree canopy wants a busier, more broken
 * outline than a knee-high shrub, and an irregular silhouette is most of what
 * separates a drawn tree from a green rectangle.
 */
export function buildFoliageTexture(rng: Rng, size = 96, lobes = 1): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d canvas context unavailable');

  // A crown is read against open sky, so it wants many small lobes clustered
  // tightly enough that alpha still falls to zero before the card edge - that
  // falloff *is* the silhouette. Spreading them to the corners instead fills
  // every texel, alphaTest passes everywhere, and the tree renders as the
  // flat rectangle the card actually is.
  const crown = lobes > 1;
  const blobs = crown ? 12 + Math.floor(rng.range(0, 4)) : 7 + Math.floor(rng.range(0, 3));
  const spread = crown ? 0.17 : 0.3;
  const rMin = crown ? 0.17 : 0.24;
  const rMax = crown ? 0.27 : 0.4;
  for (let i = 0; i < blobs; i++) {
    const bx = size * 0.5 + rng.range(-spread, spread) * size;
    const by = size * 0.52 + rng.range(-spread, spread) * size;
    const r = size * rng.range(rMin, rMax);
    const gradient = ctx.createRadialGradient(bx, by, 0, bx, by, r);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.7, 'rgba(255,255,255,0.9)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
