import {
  BUS_ALTITUDE,
  BUS_DURATION_TICKS,
  BUS_PATH_OVERSHOOT,
  MAP_HALF,
  STORM_CENTRE_DRIFT,
  STORM_PHASES,
  STORM_RADII,
  STORM_SHRINK_TICKS,
  STORM_WAIT_TICKS,
} from './constants.js';
import { f32, type Vec3 } from './math.js';
import { Rng } from './rng.js';

/** Where a round is up to. */
export const RoundPhase = {
  Lobby: 0,
  Bus: 1,
  Playing: 2,
  Ended: 3,
} as const;

export const ROUND_PHASE_NAMES = ['lobby', 'bus', 'playing', 'ended'] as const;

/** How a player is currently moving, which decides which physics apply. */
export const MoveMode = {
  Ground: 0,
  Bus: 1,
  Freefall: 2,
  Glide: 3,
} as const;

/** Everything a client needs to draw the round and the storm. */
export interface RoundState {
  phase: number;
  /** Ticks elapsed inside the current phase. */
  phaseTick: number;
  /** Seed of the map this round is played on; changes when a new round starts. */
  mapSeed: number;
  /** Fingerprint of that map, so a client can prove it built the same one. */
  mapHash: number;
  stormPhase: number;
  stormX: number;
  stormZ: number;
  stormRadius: number;
  /** Where the circle is heading, for the minimap. */
  targetX: number;
  targetZ: number;
  targetRadius: number;
  /** Ticks until the current circle starts shrinking, zero while it is moving. */
  stormWait: number;
  aliveCount: number;
  winnerId: number;
}

export function createRoundState(mapSeed: number): RoundState {
  return {
    phase: RoundPhase.Lobby,
    phaseTick: 0,
    mapSeed,
    mapHash: 0,
    stormPhase: 0,
    stormX: 0,
    stormZ: 0,
    stormRadius: STORM_RADII[0]!,
    targetX: 0,
    targetZ: 0,
    targetRadius: STORM_RADII[0]!,
    stormWait: 0,
    aliveCount: 0,
    winnerId: 0,
  };
}

/**
 * The bus flies a straight chord over the map. Its path is a pure function of
 * the seed and how long the phase has been running, so every client draws it in
 * the same place without any of it going over the wire.
 */
export function busPosition(seed: number, phaseTick: number, out: Vec3): Vec3 {
  const rng = new Rng(seed ^ 0xb0551e);
  const angle = rng.next() * Math.PI * 2;
  // Offset the chord from dead centre so the flight path varies.
  const offset = rng.range(-MAP_HALF * 0.45, MAP_HALF * 0.45);
  const length = MAP_HALF * 2 * BUS_PATH_OVERSHOOT;

  const dirX = Math.cos(angle);
  const dirZ = Math.sin(angle);
  // Perpendicular, for the sideways offset.
  const perpX = -dirZ;
  const perpZ = dirX;

  const t = Math.min(1, Math.max(0, phaseTick / BUS_DURATION_TICKS));
  const travelled = (t - 0.5) * length;

  out.x = f32(perpX * offset + dirX * travelled);
  out.y = f32(BUS_ALTITUDE);
  out.z = f32(perpZ * offset + dirZ * travelled);
  return out;
}

/** Unit heading of the bus, for orienting the model. */
export function busHeading(seed: number): number {
  const rng = new Rng(seed ^ 0xb0551e);
  const angle = rng.next() * Math.PI * 2;
  // Yaw such that forward (-sin, -cos) points along the flight direction.
  return Math.atan2(-Math.cos(angle), -Math.sin(angle));
}

export interface StormStep {
  x: number;
  z: number;
  radius: number;
}

/**
 * The centre and size the circle closes to at each phase. Each target sits
 * inside the circle before it, so the safe zone always shrinks into itself
 * rather than jumping somewhere unreachable.
 */
export function planStorm(seed: number): StormStep[] {
  const rng = new Rng(seed ^ 0x570423);
  const steps: StormStep[] = [];
  let x = 0;
  let z = 0;
  let radius = STORM_RADII[0]!;

  for (let phase = 0; phase < STORM_PHASES; phase++) {
    const next = STORM_RADII[phase + 1]!;
    // Stay far enough in that the new circle is fully contained.
    const drift = Math.max(0, radius - next) * STORM_CENTRE_DRIFT;
    const angle = rng.next() * Math.PI * 2;
    const distance = Math.sqrt(rng.next()) * drift;
    x = f32(x + Math.cos(angle) * distance);
    z = f32(z + Math.sin(angle) * distance);
    radius = next;
    steps.push({ x, z, radius });
  }
  return steps;
}

/** Ticks the whole storm takes, used for the round clock. */
export function stormTotalTicks(): number {
  let total = 0;
  for (let i = 0; i < STORM_PHASES; i++) {
    total += STORM_WAIT_TICKS[i]! + STORM_SHRINK_TICKS[i]!;
  }
  return total;
}

/** True when a point is outside the safe circle and taking damage. */
export function outsideStorm(round: RoundState, x: number, z: number): boolean {
  const dx = x - round.stormX;
  const dz = z - round.stormZ;
  return dx * dx + dz * dz > round.stormRadius * round.stormRadius;
}
