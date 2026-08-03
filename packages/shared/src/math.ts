/**
 * Minimal vector math shared by client prediction and server simulation.
 *
 * Plain objects (not classes) are used deliberately: the same values travel over
 * the wire, get stored in history buffers and get compared during reconciliation,
 * so they must stay structurally identical on both sides of the connection.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const cloneVec3 = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

export const addVec3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

export const subVec3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

export const scaleVec3 = (v: Vec3, s: number): Vec3 => ({
  x: v.x * s,
  y: v.y * s,
  z: v.z * s,
});

export const dotVec3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const lengthVec3 = (v: Vec3): number => Math.sqrt(dotVec3(v, v));

export const distanceVec3 = (a: Vec3, b: Vec3): number => lengthVec3(subVec3(a, b));

export const horizontalDistance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

export function normalizeVec3(v: Vec3): Vec3 {
  const len = lengthVec3(v);
  if (len < 1e-8) return vec3(0, 0, 0);
  return scaleVec3(v, 1 / len);
}

export function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const lerpVec3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
});

/** Shortest signed difference between two angles, in radians. */
export function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export const lerpAngle = (from: number, to: number, t: number): number =>
  from + angleDelta(from, to) * t;

/**
 * Yaw/pitch to a unit direction vector.
 * Yaw 0 looks down +Z, increasing yaw rotates towards +X (left-handed, matches
 * the renderer's coordinate convention).
 */
export function directionFromAngles(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cosPitch,
    y: -Math.sin(pitch),
    z: Math.cos(yaw) * cosPitch,
  };
}

/** Deterministic 32-bit PRNG. Identical output on client and server for a given seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable, order-dependent hash used to seed per-shot PRNGs. */
export function hashSeed(...parts: (number | string)[]): number {
  let hash = 2166136261;
  for (const part of parts) {
    const text = typeof part === 'number' ? part.toString(36) : part;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0x9e3779b9;
  }
  return hash >>> 0;
}

/** True when every component is a finite number. */
export const isFiniteVec3 = (v: Vec3): boolean =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
