import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATCH_RULES,
  nextMatchPhase,
  phaseTimeRemaining,
  rankScoreboard,
  selectSpawnPoint,
  type MatchRules,
} from './match.js';
import { getArena } from './arena.js';

const rules: MatchRules = { ...DEFAULT_MATCH_RULES };

describe('nextMatchPhase', () => {
  it('waits until the minimum player count is met', () => {
    expect(
      nextMatchPhase(
        { phase: 'WAITING', phaseElapsedMs: 99_999, playerCount: 1, topScore: 0 },
        rules,
      ),
    ).toBe('WAITING');
    expect(
      nextMatchPhase({ phase: 'WAITING', phaseElapsedMs: 0, playerCount: 2, topScore: 0 }, rules),
    ).toBe('COUNTDOWN');
  });

  it('starts playing once the countdown elapses', () => {
    expect(
      nextMatchPhase(
        { phase: 'COUNTDOWN', phaseElapsedMs: 4_999, playerCount: 2, topScore: 0 },
        rules,
      ),
    ).toBe('COUNTDOWN');
    expect(
      nextMatchPhase(
        { phase: 'COUNTDOWN', phaseElapsedMs: 5_000, playerCount: 2, topScore: 0 },
        rules,
      ),
    ).toBe('PLAYING');
  });

  it('aborts the countdown when players leave', () => {
    expect(
      nextMatchPhase(
        { phase: 'COUNTDOWN', phaseElapsedMs: 1_000, playerCount: 1, topScore: 0 },
        rules,
      ),
    ).toBe('WAITING');
  });

  it('finishes on the time limit', () => {
    expect(
      nextMatchPhase(
        { phase: 'PLAYING', phaseElapsedMs: rules.durationMs - 1, playerCount: 2, topScore: 0 },
        rules,
      ),
    ).toBe('PLAYING');
    expect(
      nextMatchPhase(
        { phase: 'PLAYING', phaseElapsedMs: rules.durationMs, playerCount: 2, topScore: 0 },
        rules,
      ),
    ).toBe('FINISHED');
  });

  it('finishes early on the score limit', () => {
    expect(
      nextMatchPhase(
        { phase: 'PLAYING', phaseElapsedMs: 1_000, playerCount: 2, topScore: rules.scoreLimit },
        rules,
      ),
    ).toBe('FINISHED');
  });

  it('ignores the score limit when it is disabled', () => {
    const noLimit: MatchRules = { ...rules, scoreLimit: 0 };
    expect(
      nextMatchPhase(
        { phase: 'PLAYING', phaseElapsedMs: 1_000, playerCount: 2, topScore: 999 },
        noLimit,
      ),
    ).toBe('PLAYING');
  });

  it('returns to waiting when the last player leaves mid-match', () => {
    expect(
      nextMatchPhase(
        { phase: 'PLAYING', phaseElapsedMs: 1_000, playerCount: 0, topScore: 3 },
        rules,
      ),
    ).toBe('WAITING');
  });

  it('cycles FINISHED -> RESTARTING -> WAITING', () => {
    expect(
      nextMatchPhase(
        { phase: 'FINISHED', phaseElapsedMs: rules.resultsMs, playerCount: 2, topScore: 5 },
        rules,
      ),
    ).toBe('RESTARTING');
    expect(
      nextMatchPhase(
        { phase: 'RESTARTING', phaseElapsedMs: 0, playerCount: 2, topScore: 5 },
        rules,
      ),
    ).toBe('WAITING');
  });

  it('allows solo play when the minimum is lowered to one', () => {
    const solo: MatchRules = { ...rules, minPlayers: 1 };
    expect(
      nextMatchPhase({ phase: 'WAITING', phaseElapsedMs: 0, playerCount: 1, topScore: 0 }, solo),
    ).toBe('COUNTDOWN');
  });
});

describe('phaseTimeRemaining', () => {
  it('counts down within a timed phase', () => {
    expect(phaseTimeRemaining('PLAYING', 60_000, rules)).toBe(rules.durationMs - 60_000);
    expect(phaseTimeRemaining('COUNTDOWN', 1_000, rules)).toBe(rules.countdownMs - 1_000);
  });

  it('never reports negative time', () => {
    expect(phaseTimeRemaining('PLAYING', rules.durationMs + 5_000, rules)).toBe(0);
  });

  it('reports null for untimed phases', () => {
    expect(phaseTimeRemaining('WAITING', 10_000, rules)).toBeNull();
    expect(phaseTimeRemaining('RESTARTING', 0, rules)).toBeNull();
  });
});

describe('rankScoreboard', () => {
  const entry = (
    displayName: string,
    kills: number,
    deaths: number,
    damageDealt = 0,
  ): {
    id: string;
    displayName: string;
    kills: number;
    deaths: number;
    damageDealt: number;
    ping: number;
  } => ({
    id: displayName,
    displayName,
    kills,
    deaths,
    damageDealt,
    ping: 30,
  });

  it('ranks by eliminations first', () => {
    const ranked = rankScoreboard([entry('a', 1, 0), entry('b', 5, 9), entry('c', 3, 0)]);
    expect(ranked.map((e) => e.displayName)).toEqual(['b', 'c', 'a']);
  });

  it('breaks elimination ties by fewest deaths, then damage', () => {
    const ranked = rankScoreboard([
      entry('a', 4, 3, 900),
      entry('b', 4, 1, 100),
      entry('c', 4, 1, 800),
    ]);
    expect(ranked.map((e) => e.displayName)).toEqual(['c', 'b', 'a']);
  });

  it('does not mutate the input array', () => {
    const input = [entry('a', 1, 0), entry('b', 5, 0)];
    const copy = [...input];
    rankScoreboard(input);
    expect(input).toEqual(copy);
  });
});

describe('selectSpawnPoint', () => {
  const arena = getArena();

  it('returns a spawn point from the arena', () => {
    const spawn = selectSpawnPoint(arena.spawnPoints, [], 0);
    expect(arena.spawnPoints).toContain(spawn);
  });

  it('picks the point furthest from the only enemy', () => {
    const enemy = arena.spawnPoints[0].position;
    const spawn = selectSpawnPoint(arena.spawnPoints, [enemy], 0);
    expect(spawn.position).not.toEqual(enemy);

    const chosenDistance = Math.hypot(
      spawn.position.x - enemy.x,
      spawn.position.y - enemy.y,
      spawn.position.z - enemy.z,
    );
    for (const candidate of arena.spawnPoints) {
      const distance = Math.hypot(
        candidate.position.x - enemy.x,
        candidate.position.y - enemy.y,
        candidate.position.z - enemy.z,
      );
      expect(chosenDistance).toBeGreaterThanOrEqual(distance - 1e-6);
    }
  });

  it('throws when the arena defines no spawn points', () => {
    expect(() => selectSpawnPoint([], [])).toThrow(/no spawn points/);
  });
});
