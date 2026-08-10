import * as THREE from 'three';

/**
 * PBR texture sets, generated on Canvas2D at load time.
 *
 * ambientCG and Poly Haven - the CC0 sources the brief names - are both
 * blocked by this environment's network egress (see ASSET_CREDITS.md for the
 * exact errors). Every albedo, normal and roughness map here is produced by
 * this file instead: fbm value noise rasterised to a canvas, then a normal map
 * derived from that same noise by finite-differencing it as a height field.
 *
 * The "detail normal at close range" the brief asks for is baked in rather
 * than blended in a shader at runtime: the normal map sums a broad-scale
 * octave with a fine one before it is ever uploaded. Ordinary hardware
 * mipmapping already fades high-frequency detail out with distance - baking
 * two octaves into one map gets the same "crisp up close, smooth far away"
 * result a runtime distance blend would, without a custom shader.
 */

export interface TextureSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  dispose(): void;
}

/** A small, fast, seeded PRNG - deterministic per material so a reload looks the same. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bilinearly interpolated 2D value noise on a wrapped lattice. */
function makeLatticeNoise(random: () => number, size = 48): (x: number, y: number) => number {
  const lattice = new Float32Array(size * size);
  for (let i = 0; i < lattice.length; i++) lattice[i] = random();
  const at = (x: number, y: number): number =>
    lattice[(((y % size) + size) % size) * size + (((x % size) + size) % size)]!;

  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
    const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
    return top * (1 - sy) + bottom * sy;
  };
}

/** Fractal sum of the lattice noise at increasing frequency, decreasing amplitude. */
function makeFbm(
  random: () => number,
  octaves: number,
  baseFrequency: number,
): (x: number, y: number) => number {
  const layers = Array.from({ length: octaves }, () => makeLatticeNoise(random));
  return (x, y) => {
    let sum = 0;
    let amp = 0.5;
    let freq = baseFrequency;
    let norm = 0;
    for (const layer of layers) {
      sum += layer(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.15;
    }
    return sum / norm;
  };
}

/** Renders an [0,1] height field into a grayscale Float32 buffer. */
function renderHeightField(size: number, height: (u: number, v: number) => number): Float32Array {
  const field = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      field[y * size + x] = height(x / size, y / size);
    }
  }
  return field;
}

/** Derives a tangent-space normal map from a height field by finite differences. */
function heightFieldToNormalMap(field: Float32Array, size: number, strength: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const at = (x: number, y: number): number => field[((y % size) + size) % size * size + (((x % size) + size) % size)]!;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hl = at(x - 1, y);
      const hr = at(x + 1, y);
      const hd = at(x, y - 1);
      const hu = at(x, y + 1);
      // Sobel-style gradient, scaled into a plausible slope range.
      const dx = (hr - hl) * strength;
      const dy = (hu - hd) * strength;
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      const i = (y * size + x) * 4;
      image.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      image.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      image.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d canvas context unavailable');
  return { canvas, ctx };
}

function toTexture(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export interface MaterialRecipe {
  /** Two colours mixed by the low-frequency noise band, plus a third for deep crevices. */
  colorA: number;
  colorB: number;
  /** Crevice/damp colour, mixed in where the height field is lowest. */
  colorLow: number;
  baseRoughness: number;
  /** How much roughness varies with the noise - damp patches read as smoother/darker. */
  roughnessVariance: number;
  normalStrength: number;
}

/**
 * Builds one albedo/normal/roughness set from a recipe. The same underlying
 * height field drives all three maps, which is what keeps them coherent -
 * the dark, damp-looking patches in the albedo are the same low spots that
 * end up smoother in the roughness map and dented in the normal map.
 */
export function buildTextureSet(recipe: MaterialRecipe, size: number, seed: number): TextureSet {
  const random = mulberry32(seed);
  // Broad shape plus a finer octave baked straight into the same field, so
  // the detail is present in the source data every map is derived from.
  const broad = makeFbm(random, 4, 3);
  const fine = makeFbm(random, 3, 17);
  const field = renderHeightField(size, (u, v) => broad(u, v) * 0.75 + fine(u, v) * 0.25);

  const { canvas: albedoCanvas, ctx: albedoCtx } = makeCanvas(size);
  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(size);
  const albedoImage = albedoCtx.createImageData(size, size);
  const roughImage = roughCtx.createImageData(size, size);

  const a = new THREE.Color(recipe.colorA);
  const b = new THREE.Color(recipe.colorB);
  const low = new THREE.Color(recipe.colorLow);
  const mixed = new THREE.Color();

  for (let i = 0; i < field.length; i++) {
    const h = field[i]!;
    // The two base tones mix across the mid range; the lowest quarter pulls
    // towards the damp/crevice colour instead of continuing the same blend.
    const t = Math.min(1, h * 1.15);
    mixed.copy(a).lerp(b, t);
    if (h < 0.28) mixed.lerp(low, (0.28 - h) / 0.28);

    // A little fine-grain speckle on top so flat mid-tones do not look painted.
    const speckle = (random() - 0.5) * 0.04;
    const p = i * 4;
    albedoImage.data[p] = clampByte((mixed.r + speckle) * 255);
    albedoImage.data[p + 1] = clampByte((mixed.g + speckle) * 255);
    albedoImage.data[p + 2] = clampByte((mixed.b + speckle) * 255);
    albedoImage.data[p + 3] = 255;

    // Damp/low areas read smoother (wet), high areas rougher (dry, dusty).
    const roughness = clamp01(recipe.baseRoughness + (h - 0.5) * recipe.roughnessVariance);
    const rb = clampByte(roughness * 255);
    roughImage.data[p] = rb;
    roughImage.data[p + 1] = rb;
    roughImage.data[p + 2] = rb;
    roughImage.data[p + 3] = 255;
  }
  albedoCtx.putImageData(albedoImage, 0, 0);
  roughCtx.putImageData(roughImage, 0, 0);

  const normalCanvas = heightFieldToNormalMap(field, size, recipe.normalStrength);

  const map = toTexture(albedoCanvas, true);
  const normalMap = toTexture(normalCanvas, false);
  const roughnessMap = toTexture(roughCanvas, false);

  return {
    map,
    normalMap,
    roughnessMap,
    dispose: () => {
      map.dispose();
      normalMap.dispose();
      roughnessMap.dispose();
    },
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
