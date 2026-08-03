import {
  INTERPOLATION_DELAY_MS,
  PLAYER_EYE_HEIGHT,
  applyDamage,
  computeHitDamage,
  computeShotDirections,
  eyePosition,
  getWeapon,
  resolveHitscan,
  type ColliderIndex,
  type HitscanTarget,
  type Vec3,
} from '@riftfront/shared';
import type { PlayerState } from '../schema/PlayerState.js';
import type { PlayerSimulation } from './PlayerSimulation.js';
import { rewindAmountMs } from './LagCompensation.js';

export interface CombatParticipant {
  sim: PlayerSimulation;
  state: PlayerState;
}

/** Aggregated result for one victim of one trigger pull. */
export interface AggregatedHit {
  targetId: string;
  /** Raw damage before shield/health split. */
  damage: number;
  /** True when at least one pellet struck the head. */
  headshot: boolean;
  pellets: number;
  point: Vec3;
}

export interface FireResolution {
  origin: Vec3;
  directions: Vec3[];
  endPoints: Vec3[];
  impactNormals: (Vec3 | null)[];
  hits: AggregatedHit[];
  /** Milliseconds the world was rewound for this shot. */
  rewindMs: number;
}

/**
 * Resolves one trigger pull with lag compensation.
 *
 * Other players are rewound to where the shooter plausibly saw them
 * (`RTT/2 + interpolation delay`, hard-capped), then every pellet is raycast against
 * world geometry and rewound hitboxes. Damage is aggregated per victim so a shotgun
 * blast produces one damage event rather than nine.
 */
export function resolveFire(params: {
  shooter: CombatParticipant;
  others: readonly CombatParticipant[];
  index: ColliderIndex;
  nowMs: number;
  direction: Vec3;
  aiming: boolean;
  shotSeq: number;
}): FireResolution {
  const { shooter, others, index, nowMs, direction, aiming, shotSeq } = params;
  const weapon = getWeapon(shooter.sim.weaponId);

  const origin = eyePosition(shooter.sim.movement.position, PLAYER_EYE_HEIGHT);
  const directions = computeShotDirections(
    weapon,
    direction,
    aiming,
    shooter.sim.sessionId,
    shotSeq,
  );

  const rewindMs = rewindAmountMs(shooter.sim.rttMs, INTERPOLATION_DELAY_MS);
  const rewindTime = nowMs - rewindMs;

  // Snapshot of where each opponent was when the shooter pulled the trigger.
  const targets: HitscanTarget[] = [];
  const byId = new Map<string, CombatParticipant>();
  for (const other of others) {
    if (other.sim.sessionId === shooter.sim.sessionId) continue;
    if (!other.state.alive) continue;
    if (other.state.spawnProtectedUntilMs > nowMs) continue;

    const sample = other.sim.history.sampleAt(rewindTime);
    const position = sample?.alive ? sample.position : other.sim.movement.position;
    targets.push({ id: other.sim.sessionId, position });
    byId.set(other.sim.sessionId, other);
  }

  const endPoints: Vec3[] = [];
  const impactNormals: (Vec3 | null)[] = [];
  const aggregated = new Map<string, AggregatedHit>();

  for (const pelletDirection of directions) {
    const outcome = resolveHitscan(origin, pelletDirection, weapon.range, index, targets);
    endPoints.push(outcome.endPoint);
    impactNormals.push(outcome.worldNormal);

    if (!outcome.hit) continue;
    const victim = byId.get(outcome.hit.targetId);
    if (!victim) continue;

    const damage = computeHitDamage(weapon, outcome.hit.distance, outcome.hit.headshot);
    const existing = aggregated.get(outcome.hit.targetId);
    if (existing) {
      existing.damage += damage;
      existing.headshot = existing.headshot || outcome.hit.headshot;
      existing.pellets += 1;
      if (outcome.hit.headshot) existing.point = outcome.hit.point;
    } else {
      aggregated.set(outcome.hit.targetId, {
        targetId: outcome.hit.targetId,
        damage,
        headshot: outcome.hit.headshot,
        pellets: 1,
        point: outcome.hit.point,
      });
    }
  }

  return {
    origin,
    directions,
    endPoints,
    impactNormals,
    hits: [...aggregated.values()],
    rewindMs,
  };
}

export interface DamageApplication {
  targetId: string;
  damage: number;
  headshot: boolean;
  killed: boolean;
  health: number;
  shield: number;
  point: Vec3;
}

/**
 * Applies an aggregated hit to a victim's replicated vitals.
 *
 * Returns null when the victim died between resolution and application, which is what
 * prevents a single shot from being credited with two eliminations.
 */
export function applyHit(
  hit: AggregatedHit,
  victim: PlayerState,
  nowMs: number,
): DamageApplication | null {
  if (!victim.alive) return null;
  if (victim.spawnProtectedUntilMs > nowMs) return null;

  const result = applyDamage({ health: victim.health, shield: victim.shield }, hit.damage);
  victim.health = result.health;
  victim.shield = result.shield;

  return {
    targetId: hit.targetId,
    damage: result.appliedDamage,
    headshot: hit.headshot,
    killed: result.killed,
    health: result.health,
    shield: result.shield,
    point: hit.point,
  };
}
