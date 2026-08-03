import {
  PLAYER_HEAD_HEIGHT,
  PLAYER_HEAD_RADIUS,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
} from './constants.js';
import { rayIntersectsVerticalCapsule, raySphere, type ColliderIndex } from './collision.js';
import type { Vec3 } from './math.js';

/** A candidate hitscan victim, positioned at its feet. */
export interface HitscanTarget {
  id: string;
  position: Vec3;
}

export interface HitscanResult {
  targetId: string;
  distance: number;
  headshot: boolean;
  point: Vec3;
}

export interface HitscanOutcome {
  /** Player hit, if any. */
  hit: HitscanResult | null;
  /** Where the ray visually terminates (player, wall or max range). */
  endPoint: Vec3;
  /** Surface normal when the ray ended on world geometry. */
  worldNormal: Vec3 | null;
}

/**
 * Resolves a single hitscan ray against world geometry and player hitboxes.
 *
 * Players are modelled as a vertical capsule (body) with a sphere on top (head).
 * The head is tested first so a ray grazing the shoulders still reads as a body shot.
 */
export function resolveHitscan(
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  index: ColliderIndex,
  targets: readonly HitscanTarget[],
): HitscanOutcome {
  const worldHit = index.raycast(origin, direction, maxDistance);
  const wallDistance = worldHit ? worldHit.distance : maxDistance;

  let best: HitscanResult | null = null;

  for (const target of targets) {
    const headCentre: Vec3 = {
      x: target.position.x,
      y: target.position.y + PLAYER_HEAD_HEIGHT,
      z: target.position.z,
    };
    const headDistance = raySphere(origin, direction, headCentre, PLAYER_HEAD_RADIUS, wallDistance);
    const bodyDistance = rayIntersectsVerticalCapsule(
      origin,
      direction,
      target.position,
      PLAYER_HEIGHT - PLAYER_HEAD_RADIUS,
      PLAYER_RADIUS,
      wallDistance,
    );

    let distance: number | null = null;
    let headshot = false;
    if (headDistance !== null && (bodyDistance === null || headDistance <= bodyDistance)) {
      distance = headDistance;
      headshot = true;
    } else if (bodyDistance !== null) {
      distance = bodyDistance;
    }

    if (distance === null) continue;
    if (best !== null && distance >= best.distance) continue;

    best = {
      targetId: target.id,
      distance,
      headshot,
      point: {
        x: origin.x + direction.x * distance,
        y: origin.y + direction.y * distance,
        z: origin.z + direction.z * distance,
      },
    };
  }

  if (best) {
    return { hit: best, endPoint: best.point, worldNormal: null };
  }

  if (worldHit) {
    return { hit: null, endPoint: worldHit.point, worldNormal: worldHit.normal };
  }

  return {
    hit: null,
    endPoint: {
      x: origin.x + direction.x * maxDistance,
      y: origin.y + direction.y * maxDistance,
      z: origin.z + direction.z * maxDistance,
    },
    worldNormal: null,
  };
}

export interface Vitals {
  health: number;
  shield: number;
}

export interface DamageResult extends Vitals {
  shieldDamage: number;
  healthDamage: number;
  /** Damage that actually landed (shield + health), never more than was available. */
  appliedDamage: number;
  killed: boolean;
}

/**
 * Applies damage shield-first. Damage that exceeds the remaining shield carries over
 * into health, so a single large hit is not absorbed by a sliver of shield.
 */
export function applyDamage(vitals: Vitals, amount: number): DamageResult {
  const incoming = Math.max(0, amount);
  const shieldDamage = Math.min(vitals.shield, incoming);
  const remaining = incoming - shieldDamage;
  const healthDamage = Math.min(vitals.health, remaining);

  const shield = vitals.shield - shieldDamage;
  const health = vitals.health - healthDamage;

  return {
    health,
    shield,
    shieldDamage,
    healthDamage,
    appliedDamage: shieldDamage + healthDamage,
    killed: health <= 0,
  };
}
