import type { SpawnPoint } from './arena.js';
import {
  MATCH_COUNTDOWN_MS,
  MATCH_DURATION_MS,
  MATCH_MAX_PLAYERS,
  MATCH_MIN_PLAYERS,
  MATCH_RESULTS_MS,
  MATCH_SCORE_LIMIT,
  RESPAWN_DELAY_MS,
} from './constants.js';
import { distanceVec3, type Vec3 } from './math.js';

export const MATCH_PHASES = ['WAITING', 'COUNTDOWN', 'PLAYING', 'FINISHED', 'RESTARTING'] as const;

export type MatchPhase = (typeof MATCH_PHASES)[number];

export const isMatchPhase = (value: unknown): value is MatchPhase =>
  typeof value === 'string' && (MATCH_PHASES as readonly string[]).includes(value);

export interface MatchRules {
  minPlayers: number;
  maxPlayers: number;
  countdownMs: number;
  durationMs: number;
  scoreLimit: number;
  respawnDelayMs: number;
  resultsMs: number;
}

export const DEFAULT_MATCH_RULES: Readonly<MatchRules> = Object.freeze({
  minPlayers: MATCH_MIN_PLAYERS,
  maxPlayers: MATCH_MAX_PLAYERS,
  countdownMs: MATCH_COUNTDOWN_MS,
  durationMs: MATCH_DURATION_MS,
  scoreLimit: MATCH_SCORE_LIMIT,
  respawnDelayMs: RESPAWN_DELAY_MS,
  resultsMs: MATCH_RESULTS_MS,
});

export interface MatchPhaseInput {
  phase: MatchPhase;
  /** Milliseconds spent in the current phase. */
  phaseElapsedMs: number;
  playerCount: number;
  /** Highest elimination count among connected players. */
  topScore: number;
}

/**
 * Pure match state machine. The server owns every transition; this function exists so
 * the rules are testable in isolation and cannot drift from the documented design.
 */
export function nextMatchPhase(input: MatchPhaseInput, rules: MatchRules): MatchPhase {
  const { phase, phaseElapsedMs, playerCount, topScore } = input;

  switch (phase) {
    case 'WAITING':
      return playerCount >= rules.minPlayers ? 'COUNTDOWN' : 'WAITING';

    case 'COUNTDOWN':
      if (playerCount < rules.minPlayers) return 'WAITING';
      return phaseElapsedMs >= rules.countdownMs ? 'PLAYING' : 'COUNTDOWN';

    case 'PLAYING':
      if (playerCount === 0) return 'WAITING';
      if (rules.scoreLimit > 0 && topScore >= rules.scoreLimit) return 'FINISHED';
      return phaseElapsedMs >= rules.durationMs ? 'FINISHED' : 'PLAYING';

    case 'FINISHED':
      return phaseElapsedMs >= rules.resultsMs ? 'RESTARTING' : 'FINISHED';

    case 'RESTARTING':
      return 'WAITING';

    default:
      return 'WAITING';
  }
}

/** Milliseconds remaining in the current phase, or null when the phase is untimed. */
export function phaseTimeRemaining(
  phase: MatchPhase,
  phaseElapsedMs: number,
  rules: MatchRules,
): number | null {
  switch (phase) {
    case 'COUNTDOWN':
      return Math.max(0, rules.countdownMs - phaseElapsedMs);
    case 'PLAYING':
      return Math.max(0, rules.durationMs - phaseElapsedMs);
    case 'FINISHED':
      return Math.max(0, rules.resultsMs - phaseElapsedMs);
    default:
      return null;
  }
}

export interface ScoreboardEntry {
  id: string;
  displayName: string;
  kills: number;
  deaths: number;
  damageDealt: number;
  ping: number;
}

/** Ranking: eliminations, then fewest deaths, then damage dealt, then name for stability. */
export function rankScoreboard<T extends ScoreboardEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    if (b.kills !== a.kills) return b.kills - a.kills;
    if (a.deaths !== b.deaths) return a.deaths - b.deaths;
    if (b.damageDealt !== a.damageDealt) return b.damageDealt - a.damageDealt;
    return a.displayName.localeCompare(b.displayName);
  });
}

/**
 * Picks the spawn point furthest from the nearest living opponent, so players are not
 * dropped straight into someone's crosshair when a safer option exists.
 */
export function selectSpawnPoint(
  spawnPoints: readonly SpawnPoint[],
  occupiedPositions: readonly Vec3[],
  randomValue = Math.random(),
): SpawnPoint {
  if (spawnPoints.length === 0) {
    throw new Error('Arena has no spawn points');
  }
  if (occupiedPositions.length === 0) {
    return spawnPoints[Math.floor(randomValue * spawnPoints.length) % spawnPoints.length];
  }

  let bestScore = -Infinity;
  const best: SpawnPoint[] = [];

  for (const spawn of spawnPoints) {
    let nearest = Infinity;
    for (const occupied of occupiedPositions) {
      nearest = Math.min(nearest, distanceVec3(spawn.position, occupied));
    }
    if (nearest > bestScore + 0.001) {
      bestScore = nearest;
      best.length = 0;
      best.push(spawn);
    } else if (Math.abs(nearest - bestScore) <= 0.001) {
      best.push(spawn);
    }
  }

  return best[Math.floor(randomValue * best.length) % best.length];
}
