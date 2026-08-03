import {
  nextMatchPhase,
  phaseTimeRemaining,
  type MatchPhase,
  type MatchRules,
} from '@riftfront/shared';

export interface PhaseTransition {
  from: MatchPhase;
  to: MatchPhase;
  atMs: number;
}

/**
 * Owns the match state machine for one room.
 *
 * Transitions are computed by the shared pure `nextMatchPhase` function so the rules
 * stay unit-testable; this class only tracks elapsed time and reports transitions
 * back to the room, which performs the side effects.
 */
export class MatchController {
  private phaseValue: MatchPhase = 'WAITING';
  private phaseStartedAtMs: number;

  constructor(
    private readonly rules: MatchRules,
    nowMs: number,
  ) {
    this.phaseStartedAtMs = nowMs;
  }

  get phase(): MatchPhase {
    return this.phaseValue;
  }

  get phaseStartedAt(): number {
    return this.phaseStartedAtMs;
  }

  phaseElapsedMs(nowMs: number): number {
    return nowMs - this.phaseStartedAtMs;
  }

  /** Absolute server time at which the current phase ends, or 0 when untimed. */
  phaseEndsAtMs(nowMs: number): number {
    const remaining = phaseTimeRemaining(this.phaseValue, this.phaseElapsedMs(nowMs), this.rules);
    return remaining === null ? 0 : nowMs + remaining;
  }

  /**
   * Advances the state machine. Returns every transition that occurred this tick —
   * `RESTARTING` immediately falls through to `WAITING`, so more than one is possible.
   */
  update(nowMs: number, playerCount: number, topScore: number): PhaseTransition[] {
    const transitions: PhaseTransition[] = [];

    // Bounded loop: the machine can legitimately chain at most a couple of states.
    for (let guard = 0; guard < 4; guard++) {
      const next = nextMatchPhase(
        {
          phase: this.phaseValue,
          phaseElapsedMs: this.phaseElapsedMs(nowMs),
          playerCount,
          topScore,
        },
        this.rules,
      );
      if (next === this.phaseValue) break;

      transitions.push({ from: this.phaseValue, to: next, atMs: nowMs });
      this.phaseValue = next;
      this.phaseStartedAtMs = nowMs;
    }

    return transitions;
  }

  /** Forces a phase, used when a room is reset or emptied. */
  forcePhase(phase: MatchPhase, nowMs: number): void {
    this.phaseValue = phase;
    this.phaseStartedAtMs = nowMs;
  }

  get isRunning(): boolean {
    return this.phaseValue === 'PLAYING';
  }
}
