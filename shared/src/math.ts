import {
  MAX_PITCH,
  PITCH_STEPS,
  YAW_STEPS,
} from './constants.js';

/**
 * Rounds a double to the nearest float32. Simulation state is kept float32-exact
 * so that what the server puts on the wire is bit-identical to what it holds in
 * memory, which in turn lets client prediction match the server exactly.
 */
export const f32 = Math.fround;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function copyVec3(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function distanceSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-path interpolation between two angles in radians. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

const TAU = Math.PI * 2;

/**
 * Quantization is applied on the client *before* the value is used for
 * prediction, so both sides simulate from the exact same numbers.
 */
export function quantizeYaw(yaw: number): number {
  let a = yaw % TAU;
  if (a < 0) a += TAU;
  return Math.round((a / TAU) * YAW_STEPS) & (YAW_STEPS - 1);
}

export function dequantizeYaw(q: number): number {
  return (q / YAW_STEPS) * TAU;
}

export function quantizePitch(pitch: number): number {
  const c = clamp(pitch, -MAX_PITCH, MAX_PITCH);
  const t = (c + MAX_PITCH) / (MAX_PITCH * 2);
  return clamp(Math.round(t * (PITCH_STEPS - 1)), 0, PITCH_STEPS - 1);
}

export function dequantizePitch(q: number): number {
  return (q / (PITCH_STEPS - 1)) * (MAX_PITCH * 2) - MAX_PITCH;
}
